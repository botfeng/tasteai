import asyncio

import httpx

from app.clients import OpenAICompatibleClient, RecommendationClient
from app.errors import OutputValidationError, RecommendationError
from app.diagnostics import generation_diagnostics, record
from app.limiter import LocalLimiter
from app.mock import MockClient
from app.schemas import RecommendationRequest, RecommendationResponse, RecommendationStatus
from app.settings import Settings
from app.validation import QUALITY_MESSAGES, quality_review, validate_output


class RecommendationService:
    def __init__(self, settings: Settings, client: RecommendationClient | None = None,
                 limiter: LocalLimiter | None = None):
        self.settings = settings
        self.limiter = limiter or LocalLimiter(settings)
        self.client = client
        if self.client is None and settings.mode == "mock":
            self.client = MockClient()
        elif self.client is None and settings.mode == "openai_compatible":
            self.client = OpenAICompatibleClient(settings)

    def status(self) -> RecommendationStatus:
        settings = self.settings
        configured = settings.configured
        if error := settings.configuration_error():
            message = error
        elif settings.mode == "disabled":
            message = "推荐生成默认关闭。可显式启用本地 Mock 演示，尚未调用真实 AI。"
        elif settings.mode == "mock":
            message = "Mock 本地演示模式：结果为预置规则生成，不是真实 AI。"
        else:
            message = "真实 AI 配置已就绪；未探测服务可用性，仅供单进程本地演示。"
        return RecommendationStatus(
            mode=settings.mode if settings.mode in {"disabled", "mock", "openai_compatible"} else "disabled",
            configured=configured,
            source=("mock" if settings.mode == "mock" else "ai") if configured else None,
            model=settings.model if configured and settings.mode == "openai_compatible" else None,
            message=message,
        )

    async def generate(self, request: RecommendationRequest, ip: str) -> RecommendationResponse:
        with generation_diagnostics(request.scene):
            return await self._generate(request, ip)

    async def _generate(self, request: RecommendationRequest, ip: str) -> RecommendationResponse:
        if not self.settings.configured or self.client is None:
            if self.settings.mode == "disabled" and not self.settings.invalid_environment:
                raise RecommendationError("recommendations_disabled", "推荐生成尚未启用，请先配置本地演示模式。")
            raise RecommendationError("not_configured", "推荐服务配置不完整或尚未授权真实调用。")
        with self.limiter.request_slot():
            repair_code = None
            for attempt in range(self.settings.max_repairs + 1):
                # Initial and repair attempts both spend the minute/day budgets.
                self.limiter.charge_attempt(ip)
                record("generation_attempt", attempt=attempt + 1)
                try:
                    async with asyncio.timeout(self.settings.timeout_seconds):
                        raw = await self.client.generate(request, repair_code)
                except (TimeoutError, httpx.TimeoutException):
                    raise RecommendationError("provider_timeout", "推荐服务响应超时，请稍后再试。", 504) from None
                except RecommendationError:
                    raise
                except Exception:
                    # Never return exception strings, upstream bodies, auth headers or keys.
                    raise RecommendationError("provider_error", "推荐服务暂时不可用，请稍后再试。", 502) from None
                try:
                    rejected = []
                    recipes = validate_output(raw, request, rejected)
                    for error in rejected:
                        record("validation_failed", code=error.code, field_path=error.field_path)
                    if self.settings.api_key:
                        for index, recipe in enumerate(recipes):
                            if self.settings.api_key in recipe.model_dump_json():
                                raise OutputValidationError("credential_echo", ("recipes", index))
                    break
                except OutputValidationError as error:
                    record("validation_failed", code=error.code, field_path=error.field_path)
                    if attempt == self.settings.max_repairs:
                        raise RecommendationError("invalid_model_output", "推荐结果未通过约束校验，未展示任何候选；请复核条件后手动重试。", 502) from None
                    repair_code = error.code
            else:
                raise AssertionError("bounded generation loop")
        mock = self.settings.mode == "mock"
        warnings = ["仅供本地演示；结构与关键词校验不能保证全部烹饪语义，仍需人工复核。",
                    "食材用量是整份烹饪或点单参考，不是营养估算；用时会随设备和份量变化。"]
        if rejected:
            reasons = "；".join(f"原第{error.field_path[1] + 1}道：{error.code}" for error in rejected)
            warnings.append(f"已淘汰{len(rejected)}道未通过校验的候选（{reasons}），仅展示通过校验的{len(recipes)}道。")
        for index, recipe in enumerate(recipes, start=1):
            issues = quality_review(recipe)
            if issues:
                warnings.append(f"第{index}道候选待人工复核：{recipe.name}。" + "；".join(QUALITY_MESSAGES[code] for code in issues))
        if request.scene == "fridge":
            warnings.append("严格模式不补充未选主食材；未选非基础调料须明确列为缺少，烹饪前请补齐。" if request.strictIngredients
                            else "允许建议缺少的食材，但仍须包含已选主食材；烹饪前请核对缺少清单。")
            if not request.assumeBasics:
                warnings.append("已关闭基础调料假定：未选的水、油、盐、胡椒一概不使用，即使列为缺少也不添加。")
        matched = {preference for recipe in recipes for preference in recipe.matchedPreferences}
        unmatched = request.preferences() - matched
        if unmatched:
            warnings.append("本次未确认匹配的偏好：" + "、".join(sorted(unmatched)) + "；未声称已满足。")
        notice = "Mock 演示：由本地预置食谱规则生成，非真实 AI 推荐。" if mock else "AI 候选已通过当前约束校验，请结合实际食材和设备复核。"
        if request.scene == "fridge" and len(recipes) < 3:
            notice += f"本次仅返回{len(recipes)}道通过校验的候选，不凑满三道。"
        if request.scene == "eat_out":
            notice += "仅提供通用点单思路，不对应具体商户、实时供应或真实价格。"
        return RecommendationResponse(recipes=recipes, source="mock" if mock else "ai",
                                      model=None if mock else self.settings.model, notice=notice,
                                      warnings=warnings, servings=request.servings, scene=request.scene)
