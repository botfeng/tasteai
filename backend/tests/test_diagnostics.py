import asyncio
import builtins
import io
import json
import os
import socket
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from app import diagnostics
from app.clients import OpenAICompatibleClient
from app.errors import OutputValidationError, RecommendationError
from app.mock import MockClient
from app.schemas import RecommendationRequest
from app.service import RecommendationService
from app.settings import Settings
from app.validation import QUALITY_MESSAGES, quality_review, validate_output

REQUEST = RecommendationRequest(scene="fridge", ingredientIds=["tomato", "egg", "potato"])
FAKE_KEY = "offline-sentinel-not-a-real-key"
PRIVATE = "private-sentinel-model-content"
BASE = Settings(mode="openai_compatible", provider="deepseek", base_url="https://api.deepseek.com",
                model="deepseek-flash", api_key=FAKE_KEY, allow_paid_calls=True,
                response_format="json_object", max_repairs=0)


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    # Windows' internal wakeup socketpair must exist before application connections are blocked.
    loop = asyncio.SelectorEventLoop()
    monkeypatch.setattr(asyncio, "run", loop.run_until_complete)
    monkeypatch.setattr(os, "environ", {})
    monkeypatch.setattr(diagnostics, "LOG_PATH", tmp_path / "diagnostics.jsonl")

    def forbidden(*args, **kwargs):
        pytest.fail("Unexpected real transport, network or dotenv read")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "__init__", forbidden)
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    for module in (builtins, io):
        original = module.open

        def guarded(file, *args, _open=original, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                name = Path(os.fsdecode(file)).name
                if name == ".env" or name.startswith(".env."):
                    forbidden()
            return _open(file, *args, **kwargs)

        monkeypatch.setattr(module, "open", guarded)
    yield
    loop.close()


class FakeClient:
    def __init__(self, raw):
        self.raw = raw
        self.calls = 0

    async def generate(self, request, repair_code=None):
        self.calls += 1
        return self.raw


def payload():
    return json.loads(asyncio.run(MockClient().generate(REQUEST)))


def logs():
    return [json.loads(line) for line in diagnostics.LOG_PATH.read_text(encoding="utf-8").splitlines()]


def serialize(data):
    return json.dumps(data, ensure_ascii=False)


@pytest.mark.parametrize("kind", ["duplicate", "missing-hyphen"])
def test_step_reference_normalization_requires_body_evidence(kind):
    data = payload()
    recipe = data["recipes"][0]
    step = recipe["cookingSteps"][0]
    original = list(step["ingredientIds"])
    if kind == "duplicate":
        step["ingredientIds"].append(original[0])
        expected = original
    else:
        recipe["ingredients"].append({"ingredientId": "black-pepper", "name": "黑胡椒", "amount": "1克", "role": "seasoning"})
        step["body"] += "加入黑胡椒拌匀。"
        step["ingredientIds"].append("blackpepper")
        expected = [*original, "black-pepper"]
    result = validate_output(serialize(data), REQUEST)
    assert result[0].cookingSteps[0].ingredientIds == expected


@pytest.mark.parametrize("kind", ["unknown", "known-other-food", "no-body-evidence", "not-declared", "duplicate-without-evidence", "negated-use"])
def test_uncertain_step_reference_is_not_silently_deleted(kind):
    data = payload()
    recipe = data["recipes"][0]
    step = recipe["cookingSteps"][0]
    if kind == "unknown":
        step["ingredientIds"].append("mystery-food")
    elif kind == "known-other-food":
        step["ingredientIds"].append("beef")
    elif kind == "duplicate-without-evidence":
        step["ingredientIds"].extend(["oil", "oil"])
    elif kind == "negated-use":
        step["ingredientIds"].append("blackpepper")
        recipe["ingredients"].append({"ingredientId": "black-pepper", "name": "黑胡椒", "amount": "1克", "role": "seasoning"})
        step["body"] += "不要加入黑胡椒。"
    else:
        step["ingredientIds"].append("blackpepper")
        if kind == "no-body-evidence":
            recipe["ingredients"].append({"ingredientId": "black-pepper", "name": "黑胡椒", "amount": "1克", "role": "seasoning"})
        else:
            step["body"] += "加入黑胡椒。"
    with pytest.raises(OutputValidationError) as caught:
        validate_output(serialize(data), REQUEST)
    assert caught.value.code == "step_ingredient_reference"


@pytest.mark.parametrize("scene,kind,code", [
    (scene, kind, code)
    for scene in ("fridge", "cook", "eat_out")
    for kind, code in (
        ("reference", "step_ingredient_reference"), ("schema", "invalid_json_or_schema"),
        ("hidden", "hidden_ingredient"), ("dangerous", "raw_food_instructions"),
        ("duplicate", "duplicate_recipe"), ("strict", "strict_main_ingredient"),
    )
    if not (scene == "eat_out" and kind in {"reference", "dangerous"})
    and not (kind == "strict" and scene != "fridge")
])
def test_partial_batch_retains_only_valid_recipes(scene, kind, code):
    request = REQUEST if scene == "fridge" else RecommendationRequest(scene=scene, maxRecipes=3)
    data = json.loads(asyncio.run(MockClient().generate(request)))
    data["recipes"] = data["recipes"][:3]
    recipe = data["recipes"][2]
    if kind == "reference":
        recipe["cookingSteps"][0]["ingredientIds"].append("mystery-food")
    elif kind == "schema":
        recipe["ingredients"][0]["amount"] = "适量"
    elif kind == "hidden":
        recipe["description"] += "加入牛奶。"
    elif kind == "dangerous":
        recipe["cookingSteps"][0]["body"] += "可以生吃。"
    elif kind == "strict":
        recipe["ingredients"].append({"ingredientId": "beef", "name": "牛肉", "role": "main", "amount": "100克"})
    else:
        data["recipes"][2] = data["recipes"][0]
    client = FakeClient(serialize(data))
    response = asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=1), client).generate(request, PRIVATE))
    assert len(response.recipes) == 2
    assert [item.name for item in response.recipes] == [item["name"] for item in data["recipes"][:2]]
    assert any("已淘汰1道" in warning and code in warning and "原第3道" in warning for warning in response.warnings)
    assert client.calls == 1
    failure = next(row for row in logs() if row["event"] == "validation_failed")
    assert failure["recipeNumber"] == 3 and failure["code"] == code


@pytest.mark.parametrize("kind", ["all-invalid", "broken-envelope", "too-many"])
def test_batch_without_acceptable_output_remains_rejected(kind):
    data = payload()
    if kind == "all-invalid":
        for recipe in data["recipes"]:
            recipe["cookingSteps"][0]["ingredientIds"].append("mystery-food")
    elif kind == "broken-envelope":
        data["extra"] = "unexpected"
    else:
        data["recipes"] *= 2
    client = FakeClient(serialize(data))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert caught.value.code == "invalid_model_output"
    assert client.calls == 1


@pytest.mark.parametrize("text,warn", [
    ("番茄自带酸味。", False), ("番茄自然酸甜。", True),
    ("风味浓郁。", True), ("口感咸鲜。", False),
])
def test_flavor_prose_uses_existing_warnings(text, warn):
    data = payload()
    data["recipes"][0]["description"] = text
    client = FakeClient(serialize(data))
    response = asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert response.recipes[0].description == text
    assert ("flavor_review" in quality_review(response.recipes[0])) is warn
    assert any(QUALITY_MESSAGES["flavor_review"] in warning for warning in response.warnings) is warn
    assert client.calls == 1


@pytest.mark.parametrize("kind,code", [
    ("hidden", "hidden_ingredient"), ("allergen", "hidden_ingredient"),
    ("strict", "strict_main_ingredient"), ("preference", "unsupported_preference"),
    ("guarantee", "unsupported_claim_or_url"),
])
def test_flavor_warning_does_not_relax_hard_constraints(kind, code):
    data = payload()
    recipe = data["recipes"][0]
    recipe["description"] = "番茄自然酸甜。"
    request = REQUEST
    if kind == "hidden":
        recipe["description"] += "加入酱油。"
    elif kind == "allergen":
        recipe["description"] += "加入牛奶。"
    elif kind == "strict":
        recipe["ingredients"].append({"ingredientId": "beef", "name": "牛肉", "role": "main", "amount": "100克"})
    elif kind == "preference":
        request = REQUEST.model_copy(update={"todayTaste": "酸甜"})
        recipe["matchedPreferences"] = ["酸甜"]
    else:
        recipe["description"] += "保证无过敏。"
    with pytest.raises(OutputValidationError) as caught:
        validate_output(serialize(data), request)
    assert caught.value.code == code


@pytest.mark.parametrize("reason", ["番茄自然酸甜。", "符合酸甜偏好。", "满足您所有口味偏好。"])
def test_reason_keywords_are_not_published_as_preference_claims(reason):
    data = payload()
    data["recipes"][0]["recommendationReason"] = reason
    data["recipes"][0]["matchedPreferences"] = []
    recipe = validate_output(serialize(data), REQUEST)[0]
    assert recipe.matchedPreferences == []
    assert reason not in recipe.recommendationReason
    assert "偏好" not in recipe.recommendationReason


@pytest.mark.parametrize("text,allowed", [
    ("注意食品安全。", True), ("请注意食品安全，生熟工具分开。", True),
    ("请注意安全。", True), ("注意饮食安全。", True),
    ("保证食品安全。", False), ("本菜绝对安全。", False),
    ("注意食品安全。保证无过敏。", False),
    ("注意食品安全，食用无风险。", False),
    ("只要注意食品安全就能放心食用。", False),
])
def test_safety_reminders_are_distinct_from_guarantees(text, allowed):
    data = payload()
    data["recipes"][0]["description"] = text
    if allowed:
        assert validate_output(serialize(data), REQUEST)[0].description == text
    else:
        with pytest.raises(OutputValidationError) as caught:
            validate_output(serialize(data), REQUEST)
        assert caught.value.code == "unsupported_claim_or_url"


@pytest.mark.parametrize("text", ["避免半熟。", "不要生吃鸡蛋。", "必须完全煮熟。", "禁止直接生食。", "不可溏心。"])
def test_explicit_negative_raw_advice_is_not_rejected(text):
    data = payload()
    data["recipes"][0]["cookingSteps"][1]["body"] += text
    assert len(validate_output(serialize(data), REQUEST)) == 3


@pytest.mark.parametrize("text", [
    "保持半熟即可。", "可以生吃鸡蛋。", "做成溏心。", "建议生食。", "做成刺身。",
    "不要生吃鸡蛋，但可以半熟。", "不必避免半熟。", "无需禁止生吃鸡蛋。",
])
def test_dangerous_or_mixed_advice_remains_rejected(text):
    data = payload()
    data["recipes"][0]["cookingSteps"][1]["body"] += text
    with pytest.raises(OutputValidationError) as caught:
        validate_output(serialize(data), REQUEST)
    assert caught.value.code == "raw_food_instructions"
    assert caught.value.field_path == ("recipes", 0, "cookingSteps", 1, "body")


@pytest.mark.parametrize("kind,code,path", [
    ("strict", "strict_main_ingredient", ["recipes", 0, "ingredients"]),
    ("hidden", "hidden_step_ingredient", ["recipes", 0, "cookingSteps", 0, "body"]),
    ("schema", "invalid_json_or_schema", ["recipes", 0, "ingredients", 0, "amount"]),
    ("unknown-field", "invalid_json_or_schema", ["recipes", 0, "unknown_field"]),
])
def test_failure_locations_and_friendly_errors(kind, code, path):
    data = payload()
    recipe = data["recipes"][0]
    if kind == "strict":
        recipe["ingredients"].append({"ingredientId": "beef", "name": "牛肉", "role": "main", "amount": "100克"})
    elif kind == "hidden":
        recipe["cookingSteps"][0]["body"] += "加入牛肉。"
    elif kind == "schema":
        recipe["ingredients"][0]["amount"] = PRIVATE
    else:
        recipe[PRIVATE] = PRIVATE
    data["recipes"] = [recipe]
    client = FakeClient(serialize(data))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert caught.value.code == "invalid_model_output"
    assert code not in caught.value.message
    assert client.calls == 1
    rows = logs()
    failure = next(row for row in rows if row["event"] == "validation_failed")
    assert failure["code"] == code
    assert failure["fieldPath"] == path
    assert failure["recipeNumber"] == 1
    assert failure["realRequestStarted"] is False
    assert len({row["requestId"] for row in rows}) == 1
    text = diagnostics.LOG_PATH.read_text(encoding="utf-8")
    for excluded in (FAKE_KEY, PRIVATE, "Authorization", "鸡蛋", "tomato", "requestBody"):
        assert excluded not in text


@pytest.mark.parametrize("status,content,expected", [
    (429, PRIVATE, "provider_error"),
    (200, PRIVATE, "provider_response_invalid"),
    (200, None, "invalid_model_output"),
])
def test_upstream_status_and_elapsed_from_mock_transport(status, content, expected):
    attempts = []

    def handler(request):
        attempts.append(True)
        if content is not None:
            return httpx.Response(status, text=content)
        return httpx.Response(200, json={"model": "deepseek-flash", "choices": [
            {"finish_reason": "stop", "message": {"content": "not-json"}}]})

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(BASE, adapter).generate(REQUEST, PRIVATE))
    assert caught.value.code == expected
    assert len(attempts) == 1
    rows = logs()
    upstream = next(row for row in rows if row["event"] == "upstream_finished")
    assert upstream["httpStatus"] == status
    assert upstream["elapsedMs"] >= 0
    assert upstream["realRequestStarted"] is True
    assert upstream["promptVersion"] == "V2" and upstream["scene"] == "fridge"
    assert rows[-1]["code"] == expected
    assert FAKE_KEY not in serialize(rows) and PRIVATE not in serialize(rows)


def test_timeout_records_no_http_status_or_exception_text():
    def handler(request):
        raise httpx.ReadTimeout(PRIVATE)

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(BASE, adapter).generate(REQUEST, PRIVATE))
    assert caught.value.code == "provider_timeout" and caught.value.status == 504
    rows = logs()
    upstream = next(row for row in rows if row["event"] == "upstream_finished")
    assert upstream["httpStatus"] is None and upstream["elapsedMs"] >= 0
    assert PRIVATE not in serialize(rows)


def test_paid_disabled_never_enters_adapter_stage():
    client = FakeClient("unused")
    with pytest.raises(RecommendationError):
        asyncio.run(RecommendationService(replace(BASE, allow_paid_calls=False), client).generate(REQUEST, PRIVATE))
    assert client.calls == 0
    assert all(row["realRequestStarted"] is False for row in logs())
    assert not any(row["event"].startswith("upstream") for row in logs())


def test_concurrent_requests_have_distinct_context_and_append_only_logs():
    raw = serialize(payload())
    diagnostics.LOG_PATH.write_text('{"priorRecord":true}\n', encoding="utf-8")

    async def run():
        service = RecommendationService(Settings(mode="mock", max_repairs=0), FakeClient(raw))
        return await asyncio.gather(service.generate(REQUEST, "one"), service.generate(REQUEST, "two"))

    assert len(asyncio.run(run())) == 2
    rows = logs()
    assert rows[0] == {"priorRecord": True}
    starts = [row["requestId"] for row in rows[1:] if row["event"] == "request_started"]
    ends = [row["requestId"] for row in rows[1:] if row["event"] == "request_finished"]
    assert len(set(starts)) == 2 and set(starts) == set(ends)
    assert diagnostics._context.get() is None


def test_log_write_failure_preserves_friendly_error(monkeypatch, caplog):
    client = FakeClient("not-json")
    diagnostics.LOG_PATH.mkdir()
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert caught.value.code == "invalid_model_output"
    assert "diagnostic log unavailable" in caplog.text
    assert PRIVATE not in caplog.text and "Traceback" not in caplog.text
