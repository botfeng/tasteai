import ipaddress
import os
import re
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    mode: str = "disabled"
    provider: str = "generic"
    base_url: str = ""
    model: str = ""
    api_key: str = field(default="", repr=False)
    allow_paid_calls: bool = False
    response_format: str = "json_schema"
    timeout_seconds: float = 30.0
    max_output_tokens: int = 4000
    max_repairs: int = 1
    per_ip_per_minute: int = 6
    daily_attempt_limit: int = 100
    max_concurrent: int = 2
    max_ip_entries: int = 512
    invalid_environment: bool = False
    photo_api_key: str = field(default="", repr=False)
    photo_timeout_seconds: float = 6.0
    photo_hourly_limit: int = 60
    photo_daily_limit: int = 180
    photo_proxy: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        try:
            base = cls(
                mode=env.get("LLM_MODE", "disabled"),
                provider=env.get("LLM_PROVIDER", "generic"),
                base_url=env.get("LLM_BASE_URL", "").strip(),
                model=env.get("LLM_MODEL", "").strip(),
                api_key=env.get("LLM_API_KEY", "").strip(),
                allow_paid_calls=env.get("LLM_ALLOW_PAID_CALLS", "false") == "true",
                response_format=env.get("LLM_RESPONSE_FORMAT", "json_schema"),
                timeout_seconds=float(env.get("LLM_TIMEOUT_SECONDS", "30")),
                max_output_tokens=int(env.get("LLM_MAX_OUTPUT_TOKENS", "4000")),
                max_repairs=int(env.get("LLM_MAX_REPAIRS", "1")),
                per_ip_per_minute=int(env.get("LLM_PER_IP_PER_MINUTE", "6")),
                daily_attempt_limit=int(env.get("LLM_DAILY_ATTEMPT_LIMIT", "100")),
                max_concurrent=int(env.get("LLM_MAX_CONCURRENT", "2")),
                max_ip_entries=int(env.get("LLM_MAX_IP_ENTRIES", "512")),
            )
        except (AttributeError, TypeError, ValueError, OverflowError):
            return cls(invalid_environment=True)
        # Photo settings fail closed on their own; they must never disable recommendations.
        try:
            return cls(**{**base.__dict__,
                          "photo_api_key": env.get("PHOTO_API_KEY", "").strip(),
                          "photo_timeout_seconds": float(env.get("PHOTO_TIMEOUT_SECONDS", "6")),
                          "photo_hourly_limit": int(env.get("PHOTO_HOUR_LIMIT", "60")),
                          "photo_daily_limit": int(env.get("PHOTO_DAY_LIMIT", "180")),
                          "photo_proxy": env.get("PHOTO_PROXY", "").strip()})
        except (AttributeError, TypeError, ValueError, OverflowError):
            return base

    def configuration_error(self) -> str | None:
        if self.invalid_environment or self.mode not in {"disabled", "mock", "openai_compatible"}:
            return "推荐配置无效，请检查本地环境变量。"
        bounds = (
            (self.timeout_seconds, 1, 120), (self.max_output_tokens, 256, 8000),
            (self.per_ip_per_minute, 1, 60), (self.daily_attempt_limit, 1, 10000),
            (self.max_concurrent, 1, 8), (self.max_ip_entries, 1, 4096), (self.max_repairs, 0, 1),
        )
        if any(not low <= value <= high for value, low, high in bounds):
            return "推荐限额或超时配置无效。"
        if self.mode != "openai_compatible":
            return None
        if self.provider not in {"generic", "deepseek"}:
            return "模型供应商配置无效。"
        if self.provider == "deepseek" and (
            self.base_url.rstrip("/") != "https://api.deepseek.com"
            or self.model != "deepseek-flash" or self.response_format != "json_object"
        ):
            return "DeepSeek 配置须使用官方地址、deepseek-flash 与 json_object。"
        if not self.allow_paid_calls:
            return "真实 AI 调用未获明确费用授权。"
        if not self.api_key or "\n" in self.api_key or "\r" in self.api_key:
            return "真实 AI 服务配置不完整。"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", self.model):
            return "真实 AI 服务配置不完整。"
        if self.response_format not in {"json_schema", "json_object"}:
            return "响应格式必须明确选择 json_schema 或 json_object。"
        try:
            url = urlsplit(self.base_url)
            host = url.hostname
            _ = url.port
            loopback = host == "localhost"
            if host and not loopback:
                try:
                    loopback = ipaddress.ip_address(host).is_loopback
                except ValueError:
                    pass
            if (
                not host or url.username is not None or url.password is not None
                or url.query or url.fragment or "\\" in self.base_url
                or any(char.isspace() for char in self.base_url)
                or not (url.scheme == "https" or (url.scheme == "http" and loopback))
            ):
                return "服务地址必须使用 HTTPS；仅本机回环地址可使用 HTTP。"
        except ValueError:
            return "真实 AI 服务地址无效。"
        return None

    @property
    def configured(self) -> bool:
        return self.mode != "disabled" and self.configuration_error() is None

    @property
    def photo_configured(self) -> bool:
        # Openverse anonymous search needs no key; an optional key adds Bearer auth.
        if self.invalid_environment or not (1 <= self.photo_timeout_seconds <= 30):
            return False
        if not (1 <= self.photo_hourly_limit <= 200 and 1 <= self.photo_daily_limit <= 1000):
            return False
        if any(char.isspace() for char in self.photo_api_key):
            return False
        if self.photo_proxy:
            try:
                url = urlsplit(self.photo_proxy)
                _ = url.port
            except ValueError:
                return False
            if (url.scheme not in {"http", "https"} or not url.hostname
                    or url.username is not None or url.password is not None
                    or url.query or url.fragment or "\\" in self.photo_proxy
                    or any(char.isspace() for char in self.photo_proxy)):
                return False
        return True
