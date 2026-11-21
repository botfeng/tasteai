import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.errors import RecommendationError
from app.limiter import LocalLimiter
from app.main import create_app
from app.mock import MockClient
from app.schemas import RecommendationRequest
from app.service import RecommendationService
from app.settings import Settings

URL = "/api/recommendations/generate"
BODY = {"scene": "fridge", "ingredientIds": ["tomato", "egg", "potato"]}
REQUEST = RecommendationRequest.model_validate(BODY)


class FixedClient:
    def __init__(self, value):
        self.value = value
        self.calls = 0

    async def generate(self, request, repair_code=None):
        self.calls += 1
        return self.value


def valid_raw():
    return asyncio.run(MockClient().generate(REQUEST))


@pytest.mark.parametrize("settings,code", [
    ({"per_ip_per_minute": 1}, "rate_limit"),
    ({"daily_attempt_limit": 1}, "daily_budget_exhausted"),
])
def test_repair_also_consumes_minute_and_daily_budgets(settings, code):
    fake = FixedClient("malformed")
    app = create_app(Settings(mode="mock", **settings), fake)
    with TestClient(app) as client:
        response = client.post(URL, json=BODY)
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == code
    assert fake.calls == 1 and app.state.recommendation_service.limiter.attempts == 1
    assert app.state.recommendation_service.limiter.active == 0


def test_failed_repair_is_charged_twice():
    fake = FixedClient("malformed")
    app = create_app(Settings(mode="mock", daily_attempt_limit=2), fake)
    with TestClient(app) as client:
        assert client.post(URL, json=BODY).status_code == 502
        response = client.post(URL, json=BODY)
    assert response.status_code == 429
    assert fake.calls == 2 and app.state.recommendation_service.limiter.attempts == 2


def test_forwarded_ip_cannot_bypass_local_minute_cap():
    fake = FixedClient(valid_raw())
    with TestClient(create_app(Settings(mode="mock", per_ip_per_minute=1), fake)) as client:
        assert client.post(URL, json=BODY, headers={"X-Forwarded-For": "1.1.1.1"}).status_code == 200
        response = client.post(URL, json=BODY, headers={"X-Forwarded-For": "2.2.2.2"})
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
    assert fake.calls == 1


def test_window_expiry_day_reset_and_bounded_memory():
    monotonic = [100.0]
    wall = [86400.0]
    settings = Settings(mode="mock", per_ip_per_minute=1, max_ip_entries=2, daily_attempt_limit=3)
    limiter = LocalLimiter(settings, lambda: monotonic[0], lambda: wall[0])
    limiter.charge_attempt("first")
    limiter.charge_attempt("second")
    with pytest.raises(RecommendationError, match="limiter_capacity"):
        limiter.charge_attempt("third")
    assert len(limiter.ips) == 2 and limiter.attempts == 2
    with pytest.raises(RecommendationError, match="rate_limit"):
        limiter.charge_attempt("first")
    monotonic[0] += 60
    limiter.charge_attempt("third")
    assert set(limiter.ips) == {"third"} and limiter.attempts == 3
    with pytest.raises(RecommendationError, match="daily_budget_exhausted"):
        limiter.charge_attempt("fourth")
    wall[0] -= 86400
    with pytest.raises(RecommendationError, match="daily_budget_exhausted"):
        limiter.charge_attempt("fourth")
    wall[0] += 86400 * 2
    limiter.charge_attempt("fourth")
    assert limiter.attempts == 1
    assert len(limiter.ips) <= settings.max_ip_entries


def test_concurrent_limit_held_through_repair_and_released():
    raw = valid_raw()

    async def run():
        repairing = asyncio.Event()
        finish = asyncio.Event()

        class RepairClient:
            calls = 0

            async def generate(self, request, repair_code=None):
                self.calls += 1
                if repair_code is None:
                    return "broken JSON"
                repairing.set()
                await finish.wait()
                return raw

        fake = RepairClient()
        app = create_app(Settings(mode="mock", max_concurrent=1), fake)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            first = asyncio.create_task(client.post(URL, json=BODY))
            await asyncio.wait_for(repairing.wait(), 2)
            second = await client.post(URL, json=BODY)
            assert second.status_code == 429
            assert second.json()["detail"]["code"] == "concurrency_limit"
            assert fake.calls == 2
            finish.set()
            assert (await first).status_code == 200
            assert app.state.recommendation_service.limiter.active == 0
            assert app.state.recommendation_service.limiter.attempts == 2
    asyncio.run(run())


def test_cancellation_releases_slot_without_refunding_attempt():
    async def run():
        started = asyncio.Event()

        class WaitingClient:
            async def generate(self, request, repair_code=None):
                started.set()
                await asyncio.Event().wait()

        service = RecommendationService(Settings(mode="mock"), WaitingClient())
        task = asyncio.create_task(service.generate(REQUEST, "test"))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.limiter.active == 0 and service.limiter.attempts == 1
    asyncio.run(run())


def test_overall_attempt_deadline_no_retry_and_slot_released():
    async def run():
        class WaitingClient:
            calls = 0

            async def generate(self, request, repair_code=None):
                self.calls += 1
                await asyncio.Event().wait()

        fake = WaitingClient()
        service = RecommendationService(Settings(mode="mock", timeout_seconds=1), fake)
        with pytest.raises(RecommendationError, match="provider_timeout"):
            await service.generate(REQUEST, "test")
        assert fake.calls == 1 and service.limiter.active == 0 and service.limiter.attempts == 1
    asyncio.run(run())
