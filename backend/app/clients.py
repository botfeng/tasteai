import json
import re
from time import perf_counter
from typing import Callable, Protocol

import httpx

from app.errors import RecommendationError
from app.diagnostics import record
from app.prompts import build_messages
from app.schemas import ModelOutput, RecommendationRequest
from app.settings import Settings


class RecommendationClient(Protocol):
    async def generate(self, request: RecommendationRequest, repair_code: str | None = None) -> str: ...


class OpenAICompatibleClient:
    """Explicit opt-in only. One HTTP attempt, no redirects, proxies, or retries."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 on_metrics: Callable[[dict], None] | None = None,
                 allowed_ingredient_ids: frozenset[str] | None = None):
        self.settings = settings
        self.transport = transport
        self.on_metrics = on_metrics
        self.allowed_ingredient_ids = allowed_ingredient_ids

    async def generate(self, request: RecommendationRequest, repair_code: str | None = None) -> str:
        settings = self.settings
        if settings.mode != "openai_compatible" or not settings.configured:
            raise RecommendationError("not_configured", "真实 AI 调用未启用或配置不完整。")
        response_format: dict = {"type": settings.response_format}
        if settings.response_format == "json_schema":
            response_format["json_schema"] = {
                "name": "tasteai_recommendations", "strict": True,
                "schema": ModelOutput.model_json_schema(),
            }
        payload = {
            "model": settings.model,
            "messages": build_messages(request, repair_code, self.allowed_ingredient_ids),
            "max_tokens": settings.max_output_tokens,
            "response_format": response_format,
            "stream": False,
            "n": 1,
        }
        if settings.provider == "deepseek":
            payload.pop("n")
            payload["thinking"] = {"type": "disabled"}
        started = perf_counter()
        metrics = {"requestedModel": settings.model, "responseModel": None, "usage": None, "httpStatus": None}
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(settings.timeout_seconds, connect=min(10.0, settings.timeout_seconds)),
                follow_redirects=False, trust_env=False,
                transport=self.transport or httpx.AsyncHTTPTransport(retries=0, trust_env=False),
            ) as client:
                record("upstream_started")
                async with client.stream(
                    "POST", settings.base_url.rstrip("/") + "/chat/completions",
                    headers={"Authorization": f"Bearer {settings.api_key}"}, json=payload,
                ) as response:
                    metrics["httpStatus"] = response.status_code
                    if response.status_code != 200:
                        raise RecommendationError("provider_error", "AI 服务暂时不可用，请稍后再试。", 502)
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 200_000:
                            raise RecommendationError("provider_response_invalid", "AI 服务响应格式不受支持。", 502)
            data = json.loads(chunks)
            if not isinstance(data, dict):
                raise ValueError("shape")
            model = data.get("model")
            if (isinstance(model, str) and settings.api_key not in model
                    and (model == settings.model or (settings.provider == "deepseek"
                         and re.fullmatch(r"deepseek-[a-zA-Z0-9.-]{1,80}", model, re.I)))):
                metrics["responseModel"] = model
            usage = data.get("usage")
            if isinstance(usage, dict):
                metrics["usage"] = {key: value for key in (
                    "prompt_tokens", "completion_tokens", "total_tokens",
                    "prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
                ) if type(value := usage.get(key)) is int and 0 <= value <= 2_000_000}
            choices = data["choices"]
            if not isinstance(choices, list) or len(choices) != 1:
                raise ValueError("shape")
            choice = choices[0]
            message = choice["message"]
            content = message["content"]
            if (choice.get("finish_reason") != "stop" or message.get("refusal")
                    or message.get("tool_calls") or not isinstance(content, str) or not content.strip()):
                raise ValueError("shape")
            return content
        except httpx.TimeoutException:
            raise RecommendationError("provider_timeout", "AI 服务响应超时，请稍后再试。", 504) from None
        except httpx.HTTPError:
            raise RecommendationError("provider_error", "AI 服务暂时不可用，请稍后再试。", 502) from None
        except (ValueError, KeyError, TypeError, IndexError):
            raise RecommendationError("provider_response_invalid", "AI 服务响应格式不受支持。", 502) from None
        finally:
            elapsed_ms = round((perf_counter() - started) * 1000)
            record("upstream_finished", http_status=metrics["httpStatus"], elapsed_ms=elapsed_ms)
            if self.on_metrics is not None:
                self.on_metrics({**metrics, "elapsedMs": elapsed_ms})
