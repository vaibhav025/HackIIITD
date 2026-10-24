from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    database: str
    mock_mode: bool
    integrations: dict[str, bool]
    auth_mode: Literal["dev", "supabase"]
    tinyfish_mode: Literal["live", "simulated"]
    # "test" = POST /me/plan switches plans instantly; "live" = billing only (production).
    billing_mode: Literal["test", "live"] = "test"
    bot_running: bool
    scheduler_running: bool
