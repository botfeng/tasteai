import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_returns_service_liveness(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"status": "ok", "service": "tasteai-api"}


def test_health_is_read_only(client):
    assert client.post("/api/health").status_code == 405


def test_business_routes_are_not_implemented(client):
    assert client.get("/api/recommendations").status_code == 404
    assert client.get("/api/recipes").status_code == 404


def test_openapi_declares_health_and_day3_routes(client):
    schema = client.get("/openapi.json").json()

    assert set(schema["paths"]) == {
        "/api/health", "/api/ingredients", "/api/recommendations/status", "/api/recommendations/generate",
    }
    assert set(schema["paths"]["/api/health"]) == {"get"}
