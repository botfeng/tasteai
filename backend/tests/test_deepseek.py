"""Offline Day 3 regressions: fake credentials, MockTransport, temporary reports only."""

import asyncio
import builtins
import io
import json
import os
from dataclasses import replace
from pathlib import Path

import dotenv
import httpx
import pytest
from pydantic import ValidationError

from app import clients, deepseek_check, service as service_module
from app.clients import OpenAICompatibleClient
from app.errors import OutputValidationError, RecommendationError
from app.mock import MockClient
from app.schemas import RecommendationRequest
from app.service import RecommendationService
from app.settings import Settings
from app.validation import validate_output

# Explicitly fake sentinels, never credentials read from a file or the host environment.
TEST_KEY = "sentinel-not-a-real-deepseek-api-key"
PRIVATE = "sentinel-private-upstream-text"
ENV = {
    "LLM_MODE": "openai_compatible",
    "LLM_PROVIDER": "deepseek",
    "LLM_BASE_URL": "https://api.deepseek.com",
    "LLM_MODEL": "deepseek-flash",
    "LLM_API_KEY": TEST_KEY,
    "LLM_ALLOW_PAID_CALLS": "true",
    "LLM_RESPONSE_FORMAT": "json_object",
    "LLM_MAX_REPAIRS": "0",
}
BASE = Settings.from_env(ENV)
REQUEST = deepseek_check.REQUEST
USAGE = {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200,
         "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 120}
METRIC_KEYS = {"requestedModel", "responseModel", "usage", "elapsedMs", "httpStatus"}


def forbidden(*args, **kwargs):
    pytest.fail("Unexpected network/default transport, dotenv read, or Mock fallback")


@pytest.fixture(autouse=True)
def offline_only(monkeypatch, tmp_path):
    # Replace the mapping itself; never inspect/copy the host's environment values.
    monkeypatch.setattr(os, "environ", {})
    monkeypatch.setattr(deepseek_check, "ROOT", tmp_path)
    monkeypatch.setattr(deepseek_check, "REPORT", tmp_path / "real-call.json")
    monkeypatch.setattr(deepseek_check, "dotenv_values", forbidden)
    monkeypatch.setattr(dotenv, "dotenv_values", forbidden)
    monkeypatch.setattr(dotenv, "load_dotenv", forbidden)
    monkeypatch.setattr(service_module, "MockClient", forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "__init__", forbidden)
    original_init = httpx.AsyncClient.__init__

    def mock_only(client, *args, **kwargs):
        assert isinstance(kwargs.get("transport"), httpx.MockTransport)
        assert kwargs.get("trust_env") is False
        assert kwargs.get("follow_redirects") is False
        return original_init(client, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", mock_only)

    def guard_open(original):
        def guarded(file, *args, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                name = Path(os.fsdecode(file)).name.lower()
                if name == ".env" or name.startswith(".env."):
                    pytest.fail("No dotenv file may be opened, even in a test")
            return original(file, *args, **kwargs)
        return guarded

    monkeypatch.setattr(builtins, "open", guard_open(builtins.open))
    monkeypatch.setattr(io, "open", guard_open(io.open))


def envelope(content="{}", **overrides):
    data = {
        "model": "deepseek-flash",
        "usage": dict(USAGE),
        "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": content, "reasoning_content": PRIVATE,
        }}],
    }
    data.update(overrides)
    return data


def recorded_transport(handler):
    calls = []

    def record(request):
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(record), calls


def service_for(transport, settings=BASE, metrics=None):
    return RecommendationService(
        settings, OpenAICompatibleClient(settings, transport, on_metrics=metrics.append if metrics is not None else None),
    )


def raw_candidates(request=REQUEST, count=3):
    async def generate():
        mock = MockClient()
        recipes = []
        # Two generations supply six distinct, hand-authored candidates, not renamed copies.
        for _ in range(2):
            recipes.extend(json.loads(await mock.generate(request))["recipes"])
        assert len(recipes) >= count
        return json.dumps({"recipes": recipes[:count]}, ensure_ascii=False)

    return asyncio.run(generate())


def scene_request(scene, max_recipes=3):
    return RecommendationRequest(
        scene=scene, maxRecipes=max_recipes,
        ingredientIds=["tomato", "egg", "potato"] if scene == "fridge" else [],
    )


def assert_metrics(metric):
    assert set(metric) == METRIC_KEYS
    assert metric["requestedModel"] == "deepseek-flash"
    assert type(metric["elapsedMs"]) is int and metric["elapsedMs"] >= 0
    assert metric["httpStatus"] is None or type(metric["httpStatus"]) is int and 100 <= metric["httpStatus"] <= 599
    serialized = json.dumps(metric)
    assert TEST_KEY not in serialized and PRIVATE not in serialized


def read_report(path):
    text = path.read_text(encoding="utf-8")
    assert TEST_KEY not in text and PRIVATE not in text
    assert "Authorization" not in text and "reasoning_content" not in text
    report = json.loads(text)
    assert report["request"] == REQUEST.model_dump()
    assert report["requestedModel"] == "deepseek-flash"
    assert type(report["elapsedMs"]) is int and report["elapsedMs"] >= 0
    assert len(report["attempts"]) == 1
    assert_metrics(report["attempts"][0])
    return report


def test_deepseek_payload_content_only_and_metrics(monkeypatch):
    raw = " \n" + raw_candidates() + "\n "
    metrics = []
    ticks = iter([10.0, 10.125])
    monkeypatch.setattr(clients, "perf_counter", lambda: next(ticks))
    settings = replace(BASE, timeout_seconds=7, max_output_tokens=1024)

    def handler(request):
        assert request.method == "POST"
        assert str(request.url) == "https://api.deepseek.com/chat/completions"
        assert request.headers["Authorization"] == "Bearer " + TEST_KEY
        assert set(request.extensions["timeout"].values()) == {7}
        body = json.loads(request.content)
        assert set(body) == {"model", "messages", "max_tokens", "response_format", "stream", "thinking"}
        assert body["model"] == "deepseek-flash"
        assert body["max_tokens"] == 1024 and body["stream"] is False
        assert body["thinking"] == {"type": "disabled"}
        assert body["response_format"] == {"type": "json_object"}
        assert "n" not in body and "tools" not in body
        assert [message["role"] for message in body["messages"]] == ["system", "user"]
        prompt = json.loads(body["messages"][1]["content"])
        assert prompt["request"] == REQUEST.model_dump()
        assert "repair" not in prompt and prompt["catalog"] and prompt["outputSchema"]
        assert "maxRecipes" in body["messages"][0]["content"]
        assert TEST_KEY not in request.content.decode() and PRIVATE not in request.content.decode()
        return httpx.Response(200, json=envelope(raw, id=PRIVATE, system_fingerprint=PRIVATE))

    transport, calls = recorded_transport(handler)
    adapter = OpenAICompatibleClient(settings, transport, on_metrics=metrics.append)
    assert asyncio.run(adapter.generate(REQUEST)) == raw
    assert len(calls) == 1
    assert metrics == [{"requestedModel": "deepseek-flash", "responseModel": "deepseek-flash",
                        "usage": USAGE, "elapsedMs": 125, "httpStatus": 200}]
    assert_metrics(metrics[0])


@pytest.mark.parametrize("changes", [
    {"LLM_PROVIDER": "other"}, {"LLM_PROVIDER": ""},
    {"LLM_BASE_URL": "https://api.deepseek.com/v1"},
    {"LLM_BASE_URL": "https://api.deepseek.com.evil.invalid"},
    {"LLM_BASE_URL": "http://api.deepseek.com"},
    {"LLM_BASE_URL": "http://127.0.0.1:8000"},
    {"LLM_BASE_URL": "https://api.deepseek.com?key=" + TEST_KEY},
    {"LLM_BASE_URL": "https://user:sentinel@api.deepseek.com"},
    {"LLM_BASE_URL": "https://api.deepseek.com#fragment"},
    {"LLM_BASE_URL": ""}, {"LLM_MODEL": "deepseek-chat"},
    {"LLM_MODEL": "deepseek-reasoner"}, {"LLM_MODEL": ""},
    {"LLM_RESPONSE_FORMAT": "json_schema"}, {"LLM_RESPONSE_FORMAT": "auto"},
    {"LLM_API_KEY": ""}, {"LLM_API_KEY": " \t "}, {"LLM_API_KEY": "sentinel\r\nheader"},
    {"LLM_ALLOW_PAID_CALLS": "false"}, {"LLM_ALLOW_PAID_CALLS": "TRUE"},
    {"LLM_ALLOW_PAID_CALLS": "1"}, {"LLM_MAX_REPAIRS": "-1"},
    {"LLM_MAX_REPAIRS": "2"}, {"LLM_MAX_REPAIRS": "bad"}, {"LLM_MAX_REPAIRS": "0.5"},
    {"LLM_TIMEOUT_SECONDS": "nan"}, {"LLM_TIMEOUT_SECONDS": "inf"},
    {"LLM_DAILY_ATTEMPT_LIMIT": "0"}, {"LLM_MAX_CONCURRENT": "0"},
])
def test_settings_fail_closed_before_any_http(changes):
    settings = Settings.from_env({**ENV, **changes})
    assert not settings.configured and settings.configuration_error()
    assert "api_key=" not in repr(settings)
    transport, calls = recorded_transport(forbidden)
    metrics = []
    service = service_for(transport, settings, metrics)
    status = service.status()
    assert status.configured is False and status.source is None and status.model is None
    assert TEST_KEY not in status.model_dump_json()
    with pytest.raises(RecommendationError, match="not_configured"):
        asyncio.run(service.generate(REQUEST, "test"))
    with pytest.raises(RecommendationError, match="not_configured"):
        asyncio.run(service.client.generate(REQUEST))
    assert calls == [] and metrics == [] and service.limiter.attempts == 0


def test_explicit_settings_defaults_and_repair_bounds():
    assert not Settings.from_env({}).configured
    assert BASE.configured and BASE.provider == "deepseek" and BASE.max_repairs == 0
    assert TEST_KEY not in repr(BASE)
    assert replace(BASE, max_repairs=1).configured
    assert replace(BASE, base_url="https://api.deepseek.com/").configured
    generic = Settings.from_env({key: value for key, value in ENV.items()
                                 if key not in {"LLM_PROVIDER", "LLM_MAX_REPAIRS"}})
    assert generic.configured and generic.provider == "generic" and generic.max_repairs == 1


@pytest.mark.parametrize("value", [-1, 2_000_001, True, False, 1.5, "10", None, [], {}])
def test_usage_rejects_non_integer_negative_and_excessive_values(value):
    usage = {key: value for key in USAGE}
    usage.update(api_key=TEST_KEY, nested={"total_tokens": 1, "secret": PRIVATE})
    metrics = []
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(usage=usage)))
    assert asyncio.run(OpenAICompatibleClient(BASE, transport, metrics.append).generate(REQUEST)) == "{}"
    assert len(calls) == len(metrics) == 1
    assert_metrics(metrics[0])
    assert metrics[0]["usage"] == {}


@pytest.mark.parametrize("value", [0, 1, 2_000_000])
def test_usage_keeps_only_top_level_whitelisted_integer_boundaries(value):
    expected = dict.fromkeys(USAGE, value)
    usage = {**expected, "completion_tokens_details": {"reasoning_tokens": 5, "secret": TEST_KEY},
             "reasoning_tokens": 5, "cost": 1, "secret": PRIVATE}
    metrics = []
    transport, _ = recorded_transport(lambda _: httpx.Response(200, json=envelope(usage=usage)))
    asyncio.run(OpenAICompatibleClient(BASE, transport, metrics.append).generate(REQUEST))
    assert_metrics(metrics[0])
    assert metrics[0]["usage"] == expected


@pytest.mark.parametrize("usage", [None, [], "private", 123])
def test_non_object_usage_is_not_recorded(usage):
    metrics = []
    transport, _ = recorded_transport(lambda _: httpx.Response(200, json=envelope(usage=usage)))
    asyncio.run(OpenAICompatibleClient(BASE, transport, metrics.append).generate(REQUEST))
    assert_metrics(metrics[0])
    assert metrics[0]["usage"] is None


@pytest.mark.parametrize("model,expected", [
    ("deepseek-flash", "deepseek-flash"),
    ("deepseek-flash-2026.11", "deepseek-flash-2026.11"),
    ("DeepSeek-V4", "DeepSeek-V4"),
    (None, None), (17, None), ({"secret": TEST_KEY}, None), ("", None),
    (TEST_KEY, None), ("Bearer " + TEST_KEY, None), ("other-model", None),
    pytest.param("deepseek-" + TEST_KEY, None, id="model-containing-key-must-be-redacted"),
    ("https://api.deepseek.com/" + TEST_KEY, None), ("deepseek-flash\nprivate", None),
    ("deepseek-", None), ("deepseek-" + "a" * 81, None),
])
def test_response_model_allowlist(model, expected):
    metrics = []
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(model=model)))
    asyncio.run(OpenAICompatibleClient(BASE, transport, metrics.append).generate(REQUEST))
    assert len(calls) == 1
    assert_metrics(metrics[0])
    assert metrics[0]["responseModel"] == expected


def test_metrics_drop_key_even_when_it_looks_like_a_deepseek_model():
    sentinel = "deepseek-sentinel-not-a-real-key"
    settings = replace(BASE, api_key=sentinel)
    metrics = []
    transport, _ = recorded_transport(lambda _: httpx.Response(200, json=envelope(model=sentinel)))
    asyncio.run(OpenAICompatibleClient(settings, transport, metrics.append).generate(REQUEST))
    assert metrics[0]["responseModel"] is None
    assert sentinel not in json.dumps(metrics)


@pytest.mark.parametrize("body", [
    b"not-json", b" \n\t ", b"\xff", b"x" * 200_001,
])
def test_invalid_json_or_oversized_http_envelope_is_rejected_once(body):
    metrics = []
    transport, calls = recorded_transport(lambda _: httpx.Response(200, content=body))
    service = service_for(transport, replace(BASE, max_repairs=1), metrics)
    with pytest.raises(RecommendationError, match="provider_response_invalid") as caught:
        asyncio.run(service.generate(REQUEST, "test"))
    assert caught.value.status == 502
    assert len(calls) == len(metrics) == service.limiter.attempts == 1
    assert_metrics(metrics[0])
    assert metrics[0]["responseModel"] is None and metrics[0]["usage"] is None


@pytest.mark.parametrize("data", [
    [], {}, {"choices": []}, {"choices": "invalid"}, {"choices": [None]},
    {"choices": [{"message": None}]},
    envelope(choices=envelope()["choices"] * 2),
    envelope(None), envelope([]), envelope(1), envelope(""), envelope(" \n\t "),
    envelope(choices=[{"finish_reason": "length", "message": {"content": "{}"}}]),
    envelope(choices=[{"finish_reason": "content_filter", "message": {"content": "{}"}}]),
    envelope(choices=[{"message": {"content": "{}"}}]),
    envelope(choices=[{"finish_reason": "stop", "message": {"content": "{}", "refusal": PRIVATE}}]),
    envelope(choices=[{"finish_reason": "stop", "message": {
        "content": "{}", "tool_calls": [{"id": PRIVATE}],
    }}]),
])
def test_noncompliant_envelope_is_not_repaired_or_replaced_by_mock(data):
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=data))
    metrics = []
    service = service_for(transport, replace(BASE, max_repairs=1), metrics)
    with pytest.raises(RecommendationError, match="provider_response_invalid") as caught:
        asyncio.run(service.generate(REQUEST, "test"))
    assert caught.value.status == 502 and PRIVATE not in caught.value.message
    assert len(calls) == len(metrics) == service.limiter.attempts == 1
    assert service.limiter.active == 0
    assert_metrics(metrics[0])


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 429, 500, 503])
def test_http_errors_never_redirect_retry_fallback_or_expose_body(status):
    transport, calls = recorded_transport(lambda _: httpx.Response(
        status, text="Authorization: Bearer " + TEST_KEY + PRIVATE,
        headers={"Location": "https://elsewhere.invalid/steal"},
    ))
    metrics = []
    service = service_for(transport, replace(BASE, max_repairs=1), metrics)
    with pytest.raises(RecommendationError, match="provider_error") as caught:
        asyncio.run(service.generate(REQUEST, "test"))
    assert caught.value.status == 502
    assert TEST_KEY not in caught.value.message and PRIVATE not in caught.value.message
    assert len(calls) == len(metrics) == service.limiter.attempts == 1
    assert_metrics(metrics[0])
    assert metrics[0]["responseModel"] is None and metrics[0]["usage"] is None


@pytest.mark.parametrize("error_type,code,status", [
    (httpx.ConnectError, "provider_error", 502),
    (httpx.RemoteProtocolError, "provider_error", 502),
    (httpx.ConnectTimeout, "provider_timeout", 504),
    (httpx.ReadTimeout, "provider_timeout", 504),
])
def test_transport_failure_has_one_attempt_and_no_mock_fallback(error_type, code, status):
    def handler(request):
        raise error_type("Authorization: Bearer " + TEST_KEY + PRIVATE, request=request)

    transport, calls = recorded_transport(handler)
    metrics = []
    service = service_for(transport, replace(BASE, max_repairs=1), metrics)
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(service.generate(REQUEST, "test"))
    assert caught.value.code == code and caught.value.status == status
    assert TEST_KEY not in caught.value.message and PRIVATE not in caught.value.message
    assert len(calls) == len(metrics) == service.limiter.attempts == 1
    assert service.limiter.active == 0
    assert_metrics(metrics[0])


@pytest.mark.parametrize("scene", ["cook", "eat_out", "fridge"])
def test_three_scenes_return_ai_and_status_does_not_probe(scene):
    request = scene_request(scene)
    raw = raw_candidates(request)
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    service = service_for(transport)
    status = service.status()
    assert status.configured and status.source == "ai" and status.model == "deepseek-flash"
    assert "未探测" in status.message and calls == [] and service.limiter.attempts == 0
    result = asyncio.run(service.generate(request, "test"))
    assert result.source == "ai" and result.model == "deepseek-flash" and result.scene == scene
    assert "Mock" not in result.notice and len(result.recipes) == 3
    assert [item.name for item in result.recipes] == [item["name"] for item in json.loads(raw)["recipes"]]
    assert len(calls) == service.limiter.attempts == 1 and service.limiter.active == 0
    assert TEST_KEY not in result.model_dump_json()
    service.status()
    assert len(calls) == 1


@pytest.mark.parametrize("raw", [
    "{" + PRIVATE + TEST_KEY, "{}", "[]", '{"recipes":"bad"}',
    '```json\n{"recipes": []}\n```', "x" * 120_001,
])
def test_zero_repairs_rejects_invalid_model_content_after_one_request(raw):
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    service = service_for(transport)
    with pytest.raises(RecommendationError, match="invalid_model_output") as caught:
        asyncio.run(service.generate(REQUEST, "test"))
    assert caught.value.status == 502
    assert TEST_KEY not in caught.value.message and PRIVATE not in caught.value.message
    assert len(calls) == service.limiter.attempts == 1 and service.limiter.active == 0


@pytest.mark.parametrize("repair_succeeds", [True, False])
def test_generic_default_retains_exactly_one_sanitized_repair(repair_succeeds):
    settings = Settings(mode="openai_compatible", base_url="https://provider.invalid/v1",
                        model="generic-test-model", api_key=TEST_KEY, allow_paid_calls=True)
    assert settings.provider == "generic" and settings.max_repairs == 1
    valid = raw_candidates()
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        assert body["n"] == 1 and "thinking" not in body
        assert body["response_format"]["type"] == "json_schema"
        assert PRIVATE not in request.content.decode() and TEST_KEY not in request.content.decode()
        prompt = json.loads(body["messages"][1]["content"])
        if len(bodies) == 1:
            assert "repair" not in prompt
            return httpx.Response(200, json=envelope(PRIVATE))
        assert prompt["repair"]["validationCode"] == "invalid_json_or_schema"
        return httpx.Response(200, json=envelope(valid if repair_succeeds else PRIVATE))

    transport, calls = recorded_transport(handler)
    service = service_for(transport, settings)
    if repair_succeeds:
        result = asyncio.run(service.generate(REQUEST, "test"))
        assert result.source == "ai" and len(result.recipes) == 3
    else:
        with pytest.raises(RecommendationError, match="invalid_model_output"):
            asyncio.run(service.generate(REQUEST, "test"))
    assert len(calls) == service.limiter.attempts == 2 and service.limiter.active == 0


@pytest.mark.parametrize("value", [3, 4, 5])
def test_max_recipes_default_and_valid_bounds(value):
    assert RecommendationRequest(scene="cook").maxRecipes == 5
    assert RecommendationRequest(scene="cook", maxRecipes=value).maxRecipes == value


@pytest.mark.parametrize("value", [2, 6, -1, True, False, 3.0, "3", None])
def test_max_recipes_rejects_out_of_range_or_coerced_input(value):
    with pytest.raises(ValidationError):
        RecommendationRequest(scene="cook", maxRecipes=value)


@pytest.mark.parametrize("scene", ["cook", "eat_out", "fridge"])
@pytest.mark.parametrize("maximum,count", [(3, 3), (3, 4), (4, 4), (4, 5), (5, 5), (5, 6)])
def test_max_recipes_is_a_hard_validation_and_service_limit(scene, maximum, count):
    request = scene_request(scene, maximum)
    raw = raw_candidates(request, count)
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    service = service_for(transport)
    if count <= maximum:
        assert len(validate_output(raw, request)) == count
        assert len(asyncio.run(service.generate(request, "test")).recipes) == count
    else:
        with pytest.raises(OutputValidationError) as caught:
            validate_output(raw, request)
        assert caught.value.code == ("recipe_count" if count <= 5 else "invalid_json_or_schema")
        with pytest.raises(RecommendationError, match="invalid_model_output"):
            asyncio.run(service.generate(request, "test"))
    assert len(calls) == service.limiter.attempts == 1


@pytest.mark.parametrize("scene", ["cook", "eat_out", "fridge"])
@pytest.mark.parametrize("count", [0, 1, 2])
def test_only_fridge_allows_fewer_than_three_recipes(scene, count):
    request = scene_request(scene)
    raw = raw_candidates(request, count)
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    service = service_for(transport)
    if scene == "fridge":
        result = asyncio.run(service.generate(request, "test"))
        assert result.source == "ai" and len(result.recipes) == count
        assert f"{count}道" in result.notice
    else:
        with pytest.raises(RecommendationError, match="invalid_model_output"):
            asyncio.run(service.generate(request, "test"))
    assert len(calls) == 1


@pytest.mark.parametrize("count", [1, 2, 3])
def test_check_once_success_reserves_report_and_forces_limits(tmp_path, monkeypatch, count):
    path = tmp_path / "nested" / "report.json"
    raw = raw_candidates(count=count)
    captured = []
    open_modes = []
    original_open = Path.open

    def track_open(self, mode="r", *args, **kwargs):
        if self == path:
            open_modes.append(mode)
        return original_open(self, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", track_open)

    def capture_service(settings, client):
        service = RecommendationService(settings, client)
        captured.append(service)
        return service

    monkeypatch.setattr(deepseek_check, "RecommendationService", capture_service)

    def handler(request):
        # The exclusive reservation is already on disk before the first HTTP attempt.
        started = json.loads(path.read_text(encoding="utf-8"))
        assert started["state"] == "started" and started["accepted"] is False
        prompt = json.loads(json.loads(request.content)["messages"][1]["content"])
        assert prompt["request"] == REQUEST.model_dump() and "repair" not in prompt
        allowed = {"tomato", "egg", "potato", "salt", "black-pepper", "oil", "water"}
        assert set(prompt["allowedIngredientIds"]) == allowed
        assert {item["id"] for item in prompt["catalog"]} == allowed
        assert started["allowedIngredientIds"] == sorted(allowed)
        return httpx.Response(200, json=envelope(raw))

    transport, calls = recorded_transport(handler)
    settings = replace(BASE, max_repairs=1, daily_attempt_limit=42, max_concurrent=6)
    assert asyncio.run(deepseek_check.check_once(settings, path, transport)) is True
    report = read_report(path)
    assert report["state"] == "finished" and report["accepted"] is True
    assert set(report["checks"]) == {"oneHttpAttempt", "oneToThreeRecipes", "onlySelectedMains", "onlyAllowedIngredients",
                                       "actionableSteps", "modelReported", "usageReported"}
    assert all(report["checks"].values()) and report["manualReview"]
    assert report["result"]["source"] == "ai" and len(report["result"]["recipes"]) == count
    assert REQUEST.ingredientIds == ["tomato", "egg", "potato"] and REQUEST.scene == "fridge"
    assert REQUEST.maxRecipes == 3 and REQUEST.strictIngredients and REQUEST.assumeBasics
    assert open_modes[0] == "x" and len(calls) == 1
    service = captured[0]
    assert (service.settings.max_repairs, service.settings.daily_attempt_limit, service.settings.max_concurrent) == (0, 1, 1)
    assert (settings.max_repairs, settings.daily_attempt_limit, settings.max_concurrent) == (1, 42, 6)
    assert service.limiter.attempts == 1 and service.limiter.active == 0
    with pytest.raises(RecommendationError, match="daily_budget_exhausted"):
        asyncio.run(service.generate(REQUEST, "another-ip"))
    with service.limiter.request_slot():
        with pytest.raises(RecommendationError, match="concurrency_limit"):
            asyncio.run(service.generate(REQUEST, "another-ip"))
    assert len(calls) == 1


def test_check_once_rejects_additional_seasoning_without_display_or_retry(tmp_path):
    data = json.loads(raw_candidates())
    recipe = data["recipes"][0]
    extra = {"ingredientId": "soy-sauce", "name": "酱油", "amount": "5毫升", "role": "seasoning"}
    recipe["ingredients"].append(extra)
    recipe["missingIngredients"].append(dict(extra))
    recipe["cookingSteps"].append({"title": "补充调味", "body": "将酱油加入做好的食材，轻轻拌匀1分钟后装盘。", "ingredientIds": ["soy-sauce"]})
    raw = json.dumps(data, ensure_ascii=False)
    assert len(validate_output(raw, REQUEST)) == 3
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    path = tmp_path / "extra-seasoning.json"
    assert asyncio.run(deepseek_check.check_once(BASE, path, transport)) is False
    report = read_report(path)
    assert report["checks"]["onlyAllowedIngredients"] is False
    assert report["error"]["code"] == "ingredient_scope_violation"
    assert "result" not in report and len(calls) == 1
    assert report["attempts"][0]["httpStatus"] == 200


@pytest.mark.parametrize("kind,code", [
    ("invalid-content", "invalid_model_output"), ("blank", "provider_response_invalid"),
    ("length", "provider_response_invalid"), ("invalid-envelope", "provider_response_invalid"),
    ("http-error", "provider_error"), ("transport", "provider_error"), ("timeout", "provider_timeout"),
])
def test_check_once_failure_records_sanitized_attempt_and_refuses_retry(tmp_path, kind, code):
    path = tmp_path / "failure.json"

    def handler(request):
        if kind == "transport":
            raise httpx.ConnectError(TEST_KEY + PRIVATE, request=request)
        if kind == "timeout":
            raise httpx.ReadTimeout(TEST_KEY + PRIVATE, request=request)
        if kind == "http-error":
            return httpx.Response(429, text="Authorization " + TEST_KEY + PRIVATE)
        if kind == "invalid-envelope":
            return httpx.Response(200, content=(TEST_KEY + PRIVATE).encode())
        data = envelope(" \n\t " if kind == "blank" else TEST_KEY + PRIVATE)
        if kind == "length":
            data["choices"][0]["finish_reason"] = "length"
        return httpx.Response(200, json=data)

    transport, calls = recorded_transport(handler)
    assert asyncio.run(deepseek_check.check_once(replace(BASE, max_repairs=1), path, transport)) is False
    report = read_report(path)
    assert report["state"] == "failed" and report["accepted"] is False
    assert report["error"]["code"] == code and "result" not in report
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        asyncio.run(deepseek_check.check_once(BASE, path, transport))
    assert path.read_bytes() == before and len(calls) == 1


@pytest.mark.parametrize("kind", ["empty-recipes", "missing-model", "missing-usage", "partial-usage"])
def test_check_once_does_not_accept_empty_candidates_or_incomplete_metrics(tmp_path, kind):
    data = envelope(raw_candidates(count=0 if kind == "empty-recipes" else 3))
    failed_check = "oneToThreeRecipes"
    if kind == "missing-model":
        data.pop("model")
        failed_check = "modelReported"
    elif kind == "missing-usage":
        data.pop("usage")
        failed_check = "usageReported"
    elif kind == "partial-usage":
        data["usage"] = {"prompt_tokens": 1, "completion_tokens": True, "total_tokens": 2_000_001,
                         "private": TEST_KEY, "nested": {"completion_tokens": 1, "total_tokens": 2}}
        failed_check = "usageReported"
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=data))
    path = tmp_path / "unaccepted.json"
    assert asyncio.run(deepseek_check.check_once(BASE, path, transport)) is False
    report = read_report(path)
    assert report["state"] == "finished" and report["checks"][failed_check] is False
    assert report["accepted"] is False and len(calls) == 1
    if kind == "partial-usage":
        assert report["attempts"][0]["usage"] == {"prompt_tokens": 1}


def test_check_once_report_redacts_key_embedded_in_response_model(tmp_path):
    raw = raw_candidates()
    data = envelope(raw, model="deepseek-" + TEST_KEY)
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=data))
    path = tmp_path / "model-redaction.json"
    accepted = asyncio.run(deepseek_check.check_once(BASE, path, transport))
    assert len(calls) == 1
    report = read_report(path)
    assert report["attempts"][0]["responseModel"] is None
    assert report["checks"]["modelReported"] is False and accepted is False


@pytest.mark.parametrize("escaped", [False, True])
def test_check_once_rejects_credentials_inside_otherwise_valid_candidates(tmp_path, escaped):
    data = json.loads(raw_candidates())
    data["recipes"][0]["description"] += TEST_KEY
    raw = json.dumps(data, ensure_ascii=False)
    assert len(validate_output(raw, REQUEST)) == 3
    if escaped:
        raw = raw.replace(TEST_KEY, "".join(f"\\u{ord(char):04x}" for char in TEST_KEY))
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    path = tmp_path / "credential-echo.json"
    assert asyncio.run(deepseek_check.check_once(BASE, path, transport)) is False
    report = read_report(path)
    assert report["error"]["code"] == "invalid_model_output"
    assert "result" not in report and len(calls) == 1


@pytest.mark.parametrize("contents", [b"", b"not a report", b'{"state":"started"}', b'{"state":"finished"}'])
def test_check_once_never_overwrites_an_existing_report(tmp_path, contents):
    path = tmp_path / "existing.json"
    path.write_bytes(contents)
    transport, calls = recorded_transport(forbidden)
    with pytest.raises(FileExistsError):
        asyncio.run(deepseek_check.check_once(BASE, path, transport))
    assert path.read_bytes() == contents and calls == []


@pytest.mark.parametrize("changes", [
    {"allow_paid_calls": False}, {"provider": "generic"}, {"api_key": ""}, {"model": "deepseek-chat"},
])
def test_check_once_unconfigured_makes_no_report_or_request(tmp_path, changes):
    path = tmp_path / "must-not-be-created" / "report.json"
    transport, calls = recorded_transport(forbidden)
    with pytest.raises(RecommendationError, match="not_configured"):
        asyncio.run(deepseek_check.check_once(replace(BASE, **changes), path, transport))
    assert calls == [] and not path.parent.exists()


def test_main_without_approval_never_reads_dotenv_settings_or_report(monkeypatch, capsys):
    class UntouchedReport:
        exists = staticmethod(forbidden)

    monkeypatch.setattr(deepseek_check, "REPORT", UntouchedReport())
    monkeypatch.setattr(Settings, "from_env", forbidden)
    monkeypatch.setattr(deepseek_check, "check_once", forbidden)
    assert deepseek_check.main([]) == 2
    assert "未授权" in capsys.readouterr().out


def test_main_existing_report_refuses_before_dotenv_or_call(tmp_path, monkeypatch, capsys):
    path = deepseek_check.REPORT
    contents = b"synthetic previous report; do not overwrite"
    path.write_bytes(contents)
    monkeypatch.setattr(Settings, "from_env", forbidden)
    monkeypatch.setattr(deepseek_check, "check_once", forbidden)
    assert deepseek_check.main(["--approve-paid-call"]) == 2
    assert "已有" in capsys.readouterr().out
    assert path.read_bytes() == contents


@pytest.mark.parametrize("success", [True, False])
def test_main_approval_is_temporary_and_uses_only_fake_env_and_transport(tmp_path, monkeypatch, capsys, success):
    file_values = {**ENV, "LLM_ALLOW_PAID_CALLS": "false"}
    process_values = {"LLM_ALLOW_PAID_CALLS": "false"}
    monkeypatch.setattr(os, "environ", process_values)
    reads = []

    def fake_dotenv(path, *, interpolate):
        assert path == tmp_path / "backend" / ".env" and interpolate is False
        reads.append(path)
        return file_values  # A dict, not an actual file read.

    monkeypatch.setattr(deepseek_check, "dotenv_values", fake_dotenv)
    raw = raw_candidates() if success else TEST_KEY + PRIVATE
    transport, calls = recorded_transport(lambda _: httpx.Response(200, json=envelope(raw)))
    actual_check_once = deepseek_check.check_once
    authorized_settings = []

    async def isolated_check(settings, report_path):
        assert report_path == tmp_path / "real-call.json"
        authorized_settings.append(settings)
        return await actual_check_once(settings, report_path, transport=transport)

    monkeypatch.setattr(deepseek_check, "check_once", isolated_check)
    assert deepseek_check.main(["--approve-paid-call"]) == (0 if success else 1)
    assert authorized_settings[0].allow_paid_calls is True
    assert file_values == {**ENV, "LLM_ALLOW_PAID_CALLS": "false"}
    assert process_values == {"LLM_ALLOW_PAID_CALLS": "false"}
    assert Settings.from_env(file_values).allow_paid_calls is False
    report = read_report(deepseek_check.REPORT)
    assert report["accepted"] is success
    contents = deepseek_check.REPORT.read_bytes()
    assert deepseek_check.main(["--approve-paid-call"]) == 2
    assert deepseek_check.main([]) == 2
    assert len(reads) == len(calls) == len(authorized_settings) == 1
    assert deepseek_check.REPORT.read_bytes() == contents
    assert not (tmp_path / "backend").exists()
    output = capsys.readouterr().out
    assert TEST_KEY not in output and PRIVATE not in output


def test_main_invalid_configuration_exits_without_call_or_report(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(deepseek_check, "dotenv_values", lambda *args, **kwargs: {})
    assert deepseek_check.main(["--approve-paid-call"]) == 2
    assert not deepseek_check.REPORT.exists()
    assert "无法进行验收" in capsys.readouterr().out
