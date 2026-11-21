import json
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from uuid import uuid4

from app.prompts import PROMPT_VERSION

LOG_PATH = Path(__file__).resolve().parents[2] / "artifacts" / "diagnostics" / "recommendations.jsonl"
_context: ContextVar[dict | None] = ContextVar("generation_diagnostics", default=None)
_lock = Lock()
CODES = frozenset("""not_configured recommendations_disabled provider_timeout provider_error
provider_response_invalid invalid_model_output credential_echo rate_limit limiter_capacity
invalid_json invalid_json_or_schema recipe_count duplicate_recipe duplicate_ingredient
ingredient_identity ingredient_amount no_main_ingredient no_selected_main strict_main_ingredient
basics_disabled missing_ingredients_mismatch invalid_text unsupported_claim_or_url
unselected_preference unselected_preference_reason unsupported_preference unsupported_flavor
hidden_ingredient dining_cooking_fields dining_fields merchant_facts cooking_dining_fields
time_limit non_executable_steps step_ingredient_reference hidden_step_ingredient
raw_food_instructions uncatalogued_food mock_constraints_unsupported""".split())
FIELDS = frozenset("""recipes name description ingredients ingredientId amount role cookingSteps
title body ingredientIds estimatedTime recommendationReason missingIngredients imageFallbackCategory
diningCategory orderingTip matchedPreferences""".split())


def record(event: str, *, code: str | None = None, field_path: tuple = (),
           http_status: int | None = None, elapsed_ms: int | None = None,
           attempt: int | None = None):
    context = _context.get()
    if context is None:
        return
    if event == "upstream_started":
        context["realRequestStarted"] = True
    if attempt is not None:
        context["attempt"] = attempt
    path = [part if (type(part) is int and 0 <= part < 1000) or
            (type(part) is str and part in FIELDS) else "unknown_field" for part in field_path]
    row = {**context, "timeUtc": datetime.now(UTC).isoformat(), "event": event}
    if code is not None:
        row["code"] = code if code in CODES else "unclassified_error"
    if event == "validation_failed":
        row["fieldPath"] = path
        row["recipeNumber"] = path[1] + 1 if len(path) > 1 and path[0] == "recipes" and type(path[1]) is int else None
    if event == "upstream_finished":
        row["httpStatus"] = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        row["elapsedMs"] = elapsed_ms if type(elapsed_ms) is int and elapsed_ms >= 0 else None
    try:
        with _lock:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with LOG_PATH.open("a", encoding="utf-8") as output:
                output.write(json.dumps(row, ensure_ascii=True) + "\n")
    except OSError:
        logging.getLogger(__name__).warning("Generation diagnostic log unavailable; no error details retained.")


@contextmanager
def generation_diagnostics(scene: str):
    token = _context.set({"requestId": str(uuid4()), "scene": scene if scene in {"cook", "fridge", "eat_out"} else "unknown",
                          "promptVersion": PROMPT_VERSION, "realRequestStarted": False, "attempt": 0})
    try:
        record("request_started")
        yield
    except Exception as error:
        record("request_failed", code=getattr(error, "code", "unclassified_error"))
        raise
    else:
        record("request_finished")
    finally:
        _context.reset(token)
