import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.settings import Settings
from app.limiter import LocalLimiter
from app.errors import RecommendationError


def test_exact_cors_and_preflight(monkeypatch):
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://taste.example")
    client = TestClient(create_app(Settings(mode="mock")))
    headers = {"Origin": "https://taste.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
    assert client.options("/api/recommendations/generate", headers=headers).headers["access-control-allow-origin"] == "https://taste.example"
    headers["Origin"] = "https://evil.example"
    assert "access-control-allow-origin" not in client.options("/api/recommendations/generate", headers=headers).headers


def test_budget_survives_new_limiter_and_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setenv("TASTEAI_DEPLOYMENT", "production")
    monkeypatch.setenv("TASTEAI_PAID_BUDGET_DB", str(tmp_path / "quota.sqlite3"))
    monkeypatch.setenv("TASTEAI_TOTAL_ATTEMPT_LIMIT", "1")
    settings = Settings(mode="openai_compatible")
    LocalLimiter(settings).charge_attempt("a")
    with pytest.raises(RecommendationError) as error:
        LocalLimiter(settings).charge_attempt("b")
    assert error.value.code == "daily_budget_exhausted"
    monkeypatch.delenv("TASTEAI_PAID_BUDGET_DB")
    with pytest.raises(RecommendationError) as error:
        LocalLimiter(settings).charge_attempt("c")
    assert error.value.code == "budget_unavailable"
