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
from app.validation import validate_output

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


@pytest.mark.parametrize("scene,kind,code", [
    (scene, kind, code)
    for scene in ("fridge", "cook", "eat_out")
    for kind, code in (
        ("identity", "ingredient_identity"), ("schema", "invalid_json_or_schema"),
        ("steps", "missing_steps"), ("duplicate", "duplicate_recipe"),
        ("strict", "strict_main_ingredient"),
    )
    if not (scene == "eat_out" and kind == "steps")
    and not (kind == "strict" and scene != "fridge")
])
def test_partial_batch_retains_only_valid_recipes(scene, kind, code):
    request = REQUEST if scene == "fridge" else RecommendationRequest(scene=scene, maxRecipes=3)
    data = json.loads(asyncio.run(MockClient().generate(request)))
    data["recipes"] = data["recipes"][:3]
    recipe = data["recipes"][2]
    if kind == "identity":
        recipe["ingredients"].append({"ingredientId": "mystery-food", "amount": "1克"})
    elif kind == "schema":
        recipe["ingredients"][0]["amount"] = "x" * 25
    elif kind == "steps":
        recipe["steps"] = []
    elif kind == "strict":
        recipe["ingredients"].append({"ingredientId": "beef", "amount": "100克"})
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
            recipe["ingredients"].append({"ingredientId": "mystery-food", "amount": "1克"})
    elif kind == "broken-envelope":
        data["extra"] = "unexpected"
    else:
        data["recipes"] *= 2
    client = FakeClient(serialize(data))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert caught.value.code == "invalid_model_output"
    assert client.calls == 1


@pytest.mark.parametrize("text", ["番茄自带酸味。", "番茄自然酸甜。", "风味浓郁。", "口感咸鲜。"])
def test_flavor_prose_is_preserved_without_review_machinery(text):
    data = payload()
    data["recipes"][0]["description"] = text
    client = FakeClient(serialize(data))
    response = asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert response.recipes[0].description == text
    assert not any("待人工复核" in warning or "已淘汰" in warning for warning in response.warnings)
    assert client.calls == 1


def test_strict_constraint_is_not_relaxed_by_flavor_prose():
    data = payload()
    recipe = data["recipes"][0]
    recipe["description"] = "番茄自然酸甜。"
    recipe["ingredients"].append({"ingredientId": "beef", "amount": "100克"})
    with pytest.raises(OutputValidationError) as caught:
        validate_output(serialize(data), REQUEST)
    assert caught.value.code == "strict_main_ingredient"


def test_model_preference_claims_are_ignored_and_recomputed():
    data = payload()
    data["recipes"][0]["matchedPreferences"] = ["酸甜"]
    request = REQUEST.model_copy(update={"todayTaste": "酸甜"})
    recipe = validate_output(serialize(data), request)[0]
    assert recipe.matchedPreferences == []


@pytest.mark.parametrize("reason", ["番茄自然酸甜。", "符合酸甜偏好。", "满足您所有口味偏好。"])
def test_reason_keywords_are_not_published_as_preference_claims(reason):
    data = payload()
    data["recipes"][0]["recommendationReason"] = reason
    data["recipes"][0]["matchedPreferences"] = []
    recipe = validate_output(serialize(data), REQUEST)[0]
    assert recipe.matchedPreferences == []
    assert reason not in recipe.recommendationReason
    assert "偏好" not in recipe.recommendationReason


@pytest.mark.parametrize("text", [
    "注意食品安全。", "请注意食品安全，生熟工具分开。", "保证食品安全。", "本菜绝对安全。",
    "注意食品安全。保证无过敏。", "只要注意食品安全就能放心食用。",
])
def test_safety_text_is_not_word_scanned(text):
    # Guidance and disclaimers live in the prompt and UI; the backend keeps no vocabulary list.
    data = payload()
    data["recipes"][0]["description"] = text
    assert validate_output(serialize(data), REQUEST)[0].description == text


@pytest.mark.parametrize("text", ["避免半熟。", "不要生吃鸡蛋。", "必须完全煮熟。", "禁止直接生食。", "不可溏心。"])
def test_explicit_negative_raw_advice_is_not_rejected(text):
    data = payload()
    data["recipes"][0]["steps"][1] += text
    assert len(validate_output(serialize(data), REQUEST)) == 3


@pytest.mark.parametrize("text", ["保持半熟即可。", "可以生吃鸡蛋。", "做成溏心。", "建议生食。", "做成刺身。"])
def test_raw_advice_text_is_not_lexically_rejected(text):
    # Cooking safety is enforced through the prompt and human-review disclaimers, not word bans.
    data = payload()
    data["recipes"][0]["steps"][1] += text
    assert len(validate_output(serialize(data), REQUEST)) == 3


@pytest.mark.parametrize("kind,code,path", [
    ("strict", "strict_main_ingredient", ["recipes", 0, "ingredients"]),
    ("identity", "ingredient_identity", ["recipes", 0, "ingredients", 0]),
    ("schema", "invalid_json_or_schema", ["recipes", 0, "ingredients", 0, "amount"]),
    ("amount", "ingredient_amount", ["recipes", 0, "ingredients", 0, "amount"]),
    ("steps", "missing_steps", ["recipes", 0, "steps"]),
])
def test_failure_locations_and_friendly_errors(kind, code, path):
    data = payload()
    recipe = data["recipes"][0]
    if kind == "strict":
        recipe["ingredients"].append({"ingredientId": "beef", "amount": "100克"})
    elif kind == "identity":
        recipe["ingredients"][0]["ingredientId"] = "mystery-food"
    elif kind == "schema":
        recipe["ingredients"][0]["amount"] = "x" * 25
    elif kind == "amount":
        recipe["ingredients"][0]["amount"] = "   "
    else:
        recipe["steps"] = []
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


def test_amount_reminder_is_advisory_and_not_logged_as_failure():
    data = payload()
    recipe = data["recipes"][0]
    salt = next(item for item in recipe["ingredients"] if item["ingredientId"] == "salt")
    salt["amount"] = "1克"
    recipe["steps"][-1] += "加2克盐调味。"
    client = FakeClient(serialize(data))
    response = asyncio.run(RecommendationService(Settings(mode="mock", max_repairs=0), client).generate(REQUEST, PRIVATE))
    assert len(response.recipes) == 3
    assert any("超过总量" in warning for warning in response.warnings)
    assert not any(row["event"] == "validation_failed" for row in logs())


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
    assert upstream["promptVersion"] == "V3" and upstream["scene"] == "fridge"
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