import argparse
import asyncio
import json
import os
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from dotenv import dotenv_values

from app.catalog import BASIC_IDS
from app.clients import OpenAICompatibleClient
from app.errors import RecommendationError
from app.schemas import RecommendationRequest
from app.service import RecommendationService
from app.settings import Settings

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "artifacts" / "day3-deepseek" / "real-call.json"
REQUEST = RecommendationRequest(scene="fridge", ingredientIds=["tomato", "egg", "potato"],
                                maxRecipes=3, strictIngredients=True, assumeBasics=True)


async def check_once(settings: Settings, report_path: Path, transport=None) -> bool:
    settings = replace(settings, max_repairs=0, daily_attempt_limit=1, max_concurrent=1)
    if not settings.configured or settings.provider != "deepseek":
        raise RecommendationError("not_configured", "需要完整的 DeepSeek 配置及本次费用授权。")
    attempts = []
    allowed_ids = frozenset(REQUEST.ingredientIds) | BASIC_IDS
    client = OpenAICompatibleClient(settings, transport=transport, on_metrics=attempts.append,
                                   allowed_ingredient_ids=allowed_ids)
    service = RecommendationService(settings, client)
    report = {"startedAt": datetime.now(UTC).isoformat(), "request": REQUEST.model_dump(),
              "requestedModel": settings.model, "allowedIngredientIds": sorted(allowed_ids),
              "state": "started", "accepted": False}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("x", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
        started = perf_counter()
        try:
            result = await service.generate(REQUEST, "single-authorized-check")
            main_ids = {item.ingredientId for recipe in result.recipes for item in recipe.ingredients if item.role == "main"}
            checks = {
                "oneHttpAttempt": len(attempts) == 1,
                "oneToThreeRecipes": 1 <= len(result.recipes) <= 3,
                "onlySelectedMains": main_ids <= set(REQUEST.ingredientIds),
                "onlyAllowedIngredients": all(item.ingredientId in allowed_ids for recipe in result.recipes for item in recipe.ingredients),
                "actionableSteps": all(len(recipe.cookingSteps) >= 3 for recipe in result.recipes),
                "modelReported": bool(attempts and attempts[0]["responseModel"]),
                "usageReported": bool(attempts and {"prompt_tokens", "completion_tokens", "total_tokens"}
                                      <= (attempts[0]["usage"] or {}).keys()),
            }
            report.update(state="finished", accepted=all(checks.values()), checks=checks,
                          manualReview="待人工复核烹饪可行性；程序检查不构成食品安全保证。")
            if checks["onlyAllowedIngredients"]:
                report["result"] = result.model_dump()
            else:
                report.update(state="failed", error={"code": "ingredient_scope_violation", "message": "候选包含本次未允许的食材或调料，未展示；不会重试。"})
        except RecommendationError as error:
            report.update(state="failed", error={"code": error.code, "message": error.message})
        except Exception:
            report.update(state="failed", error={"code": "check_failed", "message": "单次验收未完成；不会自动重试。"})
        finally:
            report.update(attempts=attempts, elapsedMs=round((perf_counter() - started) * 1000))
            output.seek(0)
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.truncate()
    return report["accepted"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="TasteAI DeepSeek 单次付费验收；必须先获得用户明确授权。")
    parser.add_argument("--approve-paid-call", action="store_true", help="仅在用户明确批准一次真实调用后使用")
    args = parser.parse_args(argv)
    if not args.approve_paid_call:
        print("未授权：未读取密钥文件，也未发起请求。")
        return 2
    if REPORT.exists():
        print("已有单次验收记录，拒绝重复请求；请先复核记录，不自动删除或覆盖。")
        return 2
    try:
        env = {**dotenv_values(ROOT / "backend" / ".env", interpolate=False), **os.environ}
        settings = replace(Settings.from_env(env), allow_paid_calls=True)
        accepted = asyncio.run(check_once(settings, REPORT))
    except (OSError, RecommendationError):
        print("无法进行验收：配置不完整或报告不可创建；不展示密钥及底层异常。")
        return 2
    print("单次验收基本检查通过，仍需人工复核。" if accepted else "单次验收未通过；已记录脱敏结果，不会自动重试。")
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
