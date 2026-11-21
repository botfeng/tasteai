"""Bounded, fail-closed demo guard. NOT a distributed/public-deployment limiter."""
import time
from contextlib import contextmanager
from threading import Lock
from typing import Callable

from app.errors import RecommendationError
from app.settings import Settings


class LocalLimiter:
    def __init__(self, settings: Settings, clock: Callable[[], float] = time.monotonic,
                 wall_clock: Callable[[], float] = time.time):
        self.settings = settings
        self.clock = clock
        self.wall_clock = wall_clock
        self.lock = Lock()
        self.active = 0
        self.day = int(wall_clock() // 86400)
        self.attempts = 0
        self.ips: dict[str, list[float]] = {}

    @contextmanager
    def request_slot(self):
        with self.lock:
            if self.active >= self.settings.max_concurrent:
                raise RecommendationError("concurrency_limit", "当前推荐请求较多，请稍后再试。", 429)
            self.active += 1
        try:
            yield
        finally:
            with self.lock:
                self.active -= 1

    def charge_attempt(self, ip: str):
        with self.lock:
            now = self.clock()
            # Expired IPs are removed, active IPs are never evicted to bypass limits.
            self.ips = {
                key: recent for key, values in self.ips.items()
                if (recent := [value for value in values if value > now - 60])
            }
            day = int(self.wall_clock() // 86400)
            # A backwards clock change must not replenish today's budget.
            if day > self.day:
                self.day, self.attempts = day, 0
            if self.attempts >= self.settings.daily_attempt_limit:
                raise RecommendationError("daily_budget_exhausted", "本地今日调用次数已用完，请明日再试。", 429)
            if len(self.ips.get(ip, [])) >= self.settings.per_ip_per_minute:
                raise RecommendationError("rate_limit", "请求过于频繁，请一分钟后再试。", 429)
            if ip not in self.ips and len(self.ips) >= self.settings.max_ip_entries:
                raise RecommendationError("limiter_capacity", "本地限流容量已满，请稍后再试。", 429)
            self.ips.setdefault(ip, []).append(now)
            self.attempts += 1
