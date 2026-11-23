"""Bounded, fail-closed demo guard. NOT a distributed/public-deployment limiter."""
import os
import sqlite3
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
            if self.settings.mode == "openai_compatible" and os.getenv("TASTEAI_DEPLOYMENT") == "production":
                self._charge_persistent_budget(day)
            self.ips.setdefault(ip, []).append(now)
            self.attempts += 1

    def _charge_persistent_budget(self, day: int):
        # Reserve before upstream I/O; failures are charged too. Never auto-refill lifetime quota.
        path = os.getenv("TASTEAI_PAID_BUDGET_DB", "")
        try:
            total_limit = int(os.getenv("TASTEAI_TOTAL_ATTEMPT_LIMIT", "100"))
            if not os.path.isabs(path) or not 1 <= total_limit <= 1000:
                raise ValueError("budget configuration")
            with sqlite3.connect(path, timeout=5, isolation_level=None) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("CREATE TABLE IF NOT EXISTS attempts (day INTEGER NOT NULL)")
                total, today = db.execute("SELECT count(*), coalesce(sum(day >= ?), 0) FROM attempts", (day,)).fetchone()
                if total >= total_limit or today >= self.settings.daily_attempt_limit:
                    raise RecommendationError("daily_budget_exhausted", "AI 调用额度已用完。", 429)
                db.execute("INSERT INTO attempts(day) VALUES (?)", (day,))
                db.execute("COMMIT")
        except RecommendationError:
            raise
        except (OSError, ValueError, sqlite3.Error):
            raise RecommendationError("budget_unavailable", "AI 预算保护未就绪，已暂停真实调用。", 503) from None
