"""Application configuration and credential-derived feature flags."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_env: str = "development"
    mock_mode: bool | None = None
    database_url: str = "sqlite+aiosqlite:///./shelfsense.db"
    tinyfish_api_key: str = ""
    tinyfish_max_concurrency: int = Field(default=2, ge=1)
    tinyfish_agent_timeout_seconds: float = Field(default=600.0, gt=0)
    # Whole budget for one Browser API pincode check, after the session exists.
    tinyfish_browser_timeout_seconds: float = Field(default=120.0, gt=0)
    # Proxy exit country for browser sessions (TinyFish defaults to US).
    tinyfish_proxy_country: str = "IN"
    # Live runs with more jobs than this are refused (0 = no limit): each live
    # check is a minutes-long paid agent run.
    tinyfish_live_max_jobs_per_run: int = Field(default=6, ge=0)
    # Browser Context Profile IDs (prof_...) with a saved, signed-in team
    # session per app. Blank = anonymous stealth browser.
    tinyfish_profile_blinkit: str = ""
    tinyfish_profile_zepto: str = ""
    tinyfish_profile_instamart: str = ""
    # Apps checked when TinyFish is live. Blinkit is left out because it blocks
    # automated browsers (live-tested 2026-10-18); add it back here if that changes.
    tinyfish_live_platforms: str = "zepto,instamart,amazon,flipkart"
    # true = answer checks from data/demo_results.json (real results saved from
    # earlier live runs) instead of calling TinyFish. Failed live checks always
    # fall back to that cache when it has the same app + pincode.
    tinyfish_demo: bool = False

    @property
    def live_platforms(self) -> set[str]:
        return {p.strip() for p in self.tinyfish_live_platforms.split(",") if p.strip()}
    gemini_api_key: str = ""
    gemini_model: str = ""
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_jwt_secret: str = ""
    # JWKS endpoint for asymmetric (ES256/RS256) Supabase access tokens. Blank =
    # `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Setting it explicitly also
    # turns Supabase auth on without SUPABASE_JWT_SECRET.
    supabase_jwks_url: str = ""
    supabase_storage_bucket: str = "screenshots"
    # Primary frontend origin: CORS plus the links in Telegram messages.
    frontend_origin: str = "http://localhost:3000"
    # Extra comma-separated origins allowed by CORS (e.g. a LAN IP or a deploy URL).
    frontend_origins: str = ""

    @field_validator("mock_mode", mode="before")
    @classmethod
    def blank_mock_mode_is_auto(cls, value: object) -> object:
        # `.env.example` ships `MOCK_MODE=`; an empty value means "decide from the keys".
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("database_url", mode="before")
    @classmethod
    def default_database_url(cls, value: str | None) -> str:
        return value or "sqlite+aiosqlite:///./shelfsense.db"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def effective_mock_mode(self) -> bool:
        """True when nothing talks to a real provider.

        `MOCK_MODE=true` forces every integration into mock mode and `false`
        reports real mode; left blank, it reflects whether any key-driven
        integration is live. Integrations are switched individually by their keys.
        """
        if self.mock_mode is not None:
            return self.mock_mode
        return not (self.tinyfish_enabled or self.gemini_enabled or self.storage_enabled)

    @property
    def tinyfish_enabled(self) -> bool:
        return bool(self.tinyfish_api_key) and self.mock_mode is not True

    @property
    def gemini_enabled(self) -> bool:
        return bool(self.gemini_api_key) and self.mock_mode is not True

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_bot_token)

    @property
    def storage_enabled(self) -> bool:
        return (
            bool(self.supabase_url and self.supabase_service_key)
            and self.mock_mode is not True
        )

    @property
    def cors_origins(self) -> list[str]:
        """FRONTEND_ORIGIN plus every FRONTEND_ORIGINS entry, without trailing slashes."""
        origins: list[str] = []
        for raw in (self.frontend_origin, self.frontend_origins):
            for origin in raw.split(","):
                origin = origin.strip().rstrip("/")
                if origin and origin not in origins:
                    origins.append(origin)
        return origins

    @property
    def jwks_url(self) -> str:
        """Where asymmetric Supabase signing keys are published ("" = unknown)."""
        if self.supabase_jwks_url.strip():
            return self.supabase_jwks_url.strip()
        base = self.supabase_url.strip().rstrip("/")
        return f"{base}/auth/v1/.well-known/jwks.json" if base else ""

    @property
    def supabase_auth_configured(self) -> bool:
        """A JWT secret (HS256) or an explicit JWKS URL (ES256/RS256) is set."""
        return bool(self.supabase_jwt_secret or self.supabase_jwks_url.strip())

    @property
    def dev_auth_enabled(self) -> bool:
        """Every request maps to the demo user: never in production, never with Supabase auth."""
        return not self.is_production and not self.supabase_auth_configured

    @property
    def auth_mode(self) -> str:
        return "dev" if self.dev_auth_enabled else "supabase"

    @property
    def tinyfish_mode(self) -> str:
        return "live" if self.tinyfish_enabled else "simulated"

    def validate_for_startup(self) -> None:
        """Refuse to boot a production process that could not authenticate anyone."""
        if self.is_production and not self.supabase_auth_configured:
            raise RuntimeError(
                "SUPABASE_JWT_SECRET (or SUPABASE_JWKS_URL) is required when APP_ENV=production"
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
