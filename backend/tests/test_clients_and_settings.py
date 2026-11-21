import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.clients import OpenAICompatibleClient
from app.errors import RecommendationError
from app.main import create_app
from app.mock import MockClient
from app.schemas import ModelOutput, RecommendationRequest
from app.settings import Settings

# A test sentinel, not a credential; all HTTP traffic uses MockTransport.
TEST_KEY = "test-only-not-a-real-key"
BASE = Settings(mode="openai_compatible", base_url="https://provider.invalid/v1", model="test-model",
                api_key=TEST_KEY, allow_paid_calls=True)
REQUEST = RecommendationRequest(scene="cook")


def envelope(content="{}", **extra):
    return {"choices": [{"finish_reason": "stop", "message": {"content": content, **extra}}]}


@pytest.mark.parametrize("response_format", ["json_schema", "json_object"])
def test_adapter_payload_format_and_no_secret_in_prompts(response_format):
    seen = []

    def handler(request):
        seen.append(request)
        assert str(request.url) == "https://provider.invalid/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer " + TEST_KEY
        body = json.loads(request.content)
        assert body["model"] == "test-model" and body["max_tokens"] == 4000
        assert body["stream"] is False and body["n"] == 1
        assert TEST_KEY not in request.content.decode()
        assert body["response_format"]["type"] == response_format
        if response_format == "json_schema":
            schema = body["response_format"]["json_schema"]
            assert schema["strict"] is True
            assert schema["schema"] == ModelOutput.model_json_schema()
            assert schema["schema"]["additionalProperties"] is False
            candidate = schema["schema"]["$defs"]["CandidateRecipe"]
            assert set(candidate["required"]) == set(candidate["properties"])
        else:
            assert body["response_format"] == {"type": "json_object"}
        assert "V2" in body["messages"][0]["content"]
        assert "timeLimit" in body["messages"][0]["content"]
        assert all(level not in body["messages"][0]["content"] for level in ("economy", "balanced", "treat"))
        prompt = json.loads(body["messages"][1]["content"])
        assert prompt["request"]["scene"] == "cook" and prompt["catalog"]
        assert prompt["repair"]["validationCode"] == "hidden_ingredient"
        return httpx.Response(200, json=envelope())

    adapter = OpenAICompatibleClient(replace(BASE, response_format=response_format), httpx.MockTransport(handler))
    assert asyncio.run(adapter.generate(REQUEST, "hidden_ingredient")) == "{}"
    assert len(seen) == 1


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 429, 500])
def test_provider_errors_no_redirect_retry_or_body_exposure(status):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, text="Authorization " + TEST_KEY, headers={"Location": "https://elsewhere.invalid/steal"})

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    with TestClient(create_app(BASE, adapter)) as client:
        response = client.post("/api/recommendations/generate", json={"scene": "cook"})
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "provider_error"
    assert TEST_KEY not in response.text and "Authorization" not in response.text
    assert len(requests) == 1


@pytest.mark.parametrize("data", [
    {}, {"choices": []}, {"choices": [None]}, {"choices": "invalid"},
    {"choices": [{"message": {"content": "{}"}, "finish_reason": "length"}]},
    {"choices": [{"message": {"content": "{}"}}]},
    envelope(None), envelope([]), envelope(""), envelope("{}", refusal="test refusal"),
    envelope("{}", tool_calls=[{"id": "unrequested"}]),
])
def test_adapter_rejects_unsupported_shapes_without_repair(data):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=data)

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    with TestClient(create_app(BASE, adapter)) as client:
        response = client.post("/api/recommendations/generate", json={"scene": "cook"})
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "provider_response_invalid"
    assert len(calls) == 1


@pytest.mark.parametrize("error", [httpx.ConnectTimeout(TEST_KEY), httpx.ReadTimeout(TEST_KEY), httpx.ConnectError(TEST_KEY)])
def test_adapter_network_error_sanitization(error):
    calls = []

    def handler(request):
        calls.append(request)
        raise error

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    with pytest.raises(RecommendationError) as caught:
        asyncio.run(adapter.generate(REQUEST))
    assert TEST_KEY not in str(caught.value) and TEST_KEY not in caught.value.message
    assert len(calls) == 1
    assert caught.value.status == (504 if isinstance(error, httpx.TimeoutException) else 502)


@pytest.mark.parametrize("body", [b"not JSON with private authorization", b"x" * 200001])
def test_adapter_rejects_non_json_or_oversized_envelope(body):
    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(lambda _: httpx.Response(200, content=body)))
    with pytest.raises(RecommendationError, match="provider_response_invalid"):
        asyncio.run(adapter.generate(REQUEST))


@pytest.mark.parametrize("base_url,valid", [
    ("https://provider.invalid/v1", True), ("http://localhost:11434/v1", True),
    ("http://127.0.0.1:1234/v1", True), ("http://[::1]:1234/v1", True),
    ("http://provider.invalid/v1", False), ("http://192.168.1.2/v1", False),
    ("http://localhost.evil.invalid/v1", False), ("https://user:pass@provider.invalid/v1", False),
    ("https://provider.invalid/v1?api_key=private", False), ("https://provider.invalid/v1#secret", False),
    ("file:///tmp/provider", False), ("https://", False), ("https://provider.invalid:bad/v1", False),
    ("https://provider.invalid\\@localhost/v1", False), ("https://provider.invalid /v1", False),
])
def test_provider_url_validation(base_url, valid):
    assert replace(BASE, base_url=base_url).configured is valid


@pytest.mark.parametrize("changes", [
    {"mode": "disabled"}, {"mode": "something-else"}, {"base_url": ""}, {"model": ""}, {"api_key": ""},
    {"allow_paid_calls": False}, {"response_format": "auto"}, {"model": "secret\nheader"},
    {"timeout_seconds": 0}, {"max_output_tokens": 999999}, {"per_ip_per_minute": 0},
    {"daily_attempt_limit": 0}, {"max_concurrent": 100}, {"max_ip_entries": 0},
    {"api_key": "bad\nheader"},
])
def test_real_adapter_fails_closed_for_incomplete_settings(changes):
    settings = replace(BASE, **changes)
    calls = []
    adapter = OpenAICompatibleClient(settings, httpx.MockTransport(lambda request: calls.append(request)))
    with pytest.raises(RecommendationError, match="not_configured"):
        asyncio.run(adapter.generate(REQUEST))
    assert calls == []
    with TestClient(create_app(settings, adapter)) as client:
        response = client.get("/api/recommendations/status")
        assert response.json()["configured"] is False
        assert response.json()["source"] is None and response.json()["model"] is None
        assert TEST_KEY not in response.text


def test_env_loading_is_explicit_and_invalid_config_is_safe():
    env = {"LLM_MODE": "openai_compatible", "LLM_BASE_URL": BASE.base_url, "LLM_MODEL": "test-model",
           "LLM_API_KEY": TEST_KEY, "LLM_ALLOW_PAID_CALLS": "true"}
    assert Settings.from_env(env).configured
    assert not Settings.from_env({**env, "LLM_ALLOW_PAID_CALLS": "TRUE"}).configured
    assert not Settings.from_env({**env, "LLM_ALLOW_PAID_CALLS": "1"}).configured
    assert not Settings.from_env({**env, "LLM_DAILY_ATTEMPT_LIMIT": "bad"}).configured
    assert not Settings.from_env({**env, "LLM_TIMEOUT_SECONDS": "nan"}).configured
    assert TEST_KEY not in repr(Settings.from_env(env))


def test_transport_integration_repairs_content_and_returns_ai_source():
    valid = asyncio.run(MockClient().generate(REQUEST))
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            return httpx.Response(200, json=envelope("malformed-model-text-do-not-echo"))
        assert "malformed-model-text-do-not-echo" not in request.content.decode()
        prompt = json.loads(body["messages"][1]["content"])
        assert prompt["repair"]["validationCode"] == "invalid_json_or_schema"
        return httpx.Response(200, json=envelope(valid))

    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(handler))
    app = create_app(BASE, adapter)
    with TestClient(app) as client:
        response = client.post("/api/recommendations/generate", json={"scene": "cook"})
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "ai" and response.json()["model"] == "test-model"
    assert len(requests) == 2 and app.state.recommendation_service.limiter.attempts == 2
    assert TEST_KEY not in response.text


def test_status_does_not_probe_provider():
    calls = []
    adapter = OpenAICompatibleClient(BASE, httpx.MockTransport(lambda request: calls.append(request)))
    with TestClient(create_app(BASE, adapter)) as client:
        response = client.get("/api/recommendations/status")
    assert response.json()["configured"] is True
    assert response.json()["source"] == "ai" and response.json()["model"] == "test-model"
    assert "未探测" in response.json()["message"]
    assert calls == [] and TEST_KEY not in response.text
