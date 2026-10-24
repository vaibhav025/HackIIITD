# ShelfSense backend

FastAPI backend for the ShelfSense seller price and shelf-visibility assistant: it tracks a seller's products and competitors on Blinkit, Zepto, Instamart, Amazon, and Flipkart, checks price/stock/delivery across pincodes, and turns the results into heatmaps, AI summaries, recommendations, alerts, and a Telegram bot.

## Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt   # runtime: requirements.txt
alembic upgrade head
python -m scripts.seed
uvicorn app.main:app --reload
```

Open `http://localhost:8000/docs`. The API serves dashboard, product and competitor management, manual/SSE check runs, heatmaps and weekly insights, AI summaries/recommendations/chat, alert rules and inbox, user settings, and Telegram linking.

Run the tests and linter:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m ruff check .
```

## Endpoints added for the frontend

- `GET /api/pincodes`, `GET /api/plans` — pincode catalogue and plan limits.
- `GET /api/products/{id}/pincodes` — current pincode/platform selection.
- `GET|PUT /api/products/{id}/listings` — per-platform product links.
- `POST /api/products/{id}/alert-rules/parse` — plain-English rule → structured rule (Gemini or rule-based).
- `PATCH /api/me` — profile, language, timezone, default city.
- `POST /api/products/{id}/telegram/simulate-link` — mock mode only: redeem a link code as if the bot received `/start <code>`.
- `DELETE /api/products/{id}/telegram/links/{link_id}` — disconnect one chat (`DELETE /api/products/{id}/telegram` disconnects all).
- `GET /api/runs?product_id=&limit=` — recent runs with mode; `GET /api/runs/{id}` adds per-job `results` and `mode`.
- `GET /api/check-results/{id}` — one result with its agent trace (`agent.steps`, `true_price`); `GET /api/check-results/{id}/screenshot` — owner-checked evidence image.
- `GET /api/tinyfish/usage` — mode, concurrency, credits today vs budget, runs today, 7-day success rate.
- `GET /api/me/export?format=json` — full account export (CSV of results without `format`).

Chats without a product focus are grounded in the product the message names (else the one with the most stock-outs), plus plan credit usage.

## Current plan limits

- Free: 3 products, 5 pincodes and 3 competitors per product, weekly checks, 100 credits/day.
- Pro: 25 products, 100 pincodes and 10 competitors per product, checks as often as every 3 hours, 1000 credits/day.
- Brand: no product, pincode, frequency, or credit limit; 25 competitors per product.

New products default to the fastest frequency the plan allows. Manual runs are refused with `429 credit_budget_exceeded` when their job count exceeds today's remaining credits.

`POST /api/me/plan` is a test-mode switch (refused in production); it never charges. Downgrading clamps product frequencies and pauses the newest products beyond the cap, reporting `adjusted_products` / `paused_products`.

## Safe local mode (no keys needed)

Copy `.env.example` only if configuration is needed; do not commit a `.env`. With no keys at all, ShelfSense runs fully:

- **Database**: SQLite at `./shelfsense.db` (no `DATABASE_URL`).
- **Auth**: development auth maps every request to the seeded Riya Sharma demo user (no `SUPABASE_JWT_SECRET`, `APP_ENV` not `production`). `DELETE /api/me` returns 409 in this mode; `python -m scripts.seed` restores any missing demo data and is safe to re-run.
- **Checks**: `MockTinyFishClient` returns deterministic fake results per query/platform/pincode with a 0.5–2s delay, ~15% out-of-stock, ~5% transient failures, and simulated agent steps and SVG evidence screenshots in `./media/screenshots` (served at `/media` outside production only) (no `TINYFISH_API_KEY`).
- **AI**: a rule-based fallback produces the same response schemas as Gemini from the measured numbers (no `GEMINI_API_KEY`).
- **Telegram**: the bot does not start; link codes are still issued, messages are logged instead of sent (no `TELEGRAM_BOT_TOKEN`).
- `/api/health` reports the mock flags and whether the bot and scheduler are running.

Each integration switches on with its own key; `MOCK_MODE=true` forces all of them back to mocks. `/api/health` reports `auth_mode` (`dev`/`supabase`), `tinyfish_mode` (`live`/`simulated`) and `billing_mode` (`test`, or `live` in production where `POST /api/me/plan` is refused).

## Integration switches

Set these environment variables (see `.env.example`) to move each integration from mock to real:

| Variable | Switches |
| --- | --- |
| `TINYFISH_API_KEY` | Live TinyFish client (official `tinyfish` SDK) |
| `GEMINI_API_KEY` (optionally `GEMINI_MODEL`) | Gemini summaries, recommendations, chat, alert-rule parsing |
| `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_BOT_USERNAME`) | Long-polling bot and real message delivery |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Remote screenshot storage |
| `SUPABASE_JWT_SECRET` | Bearer JWT authentication for HS256 tokens (this or `SUPABASE_JWKS_URL` is required when `APP_ENV=production`; SSE and screenshot URLs also accept `?access_token=`) |
| `SUPABASE_JWKS_URL` | Optional: JWKS for ES256/RS256 Supabase tokens. Blank = `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`; setting it turns Supabase auth on even without a JWT secret |
| `DATABASE_URL` | Postgres/Supabase instead of SQLite |
| `FRONTEND_ORIGIN` | CORS allow-list and Telegram "Details" button URLs |
| `FRONTEND_ORIGINS` | Extra comma-separated CORS origins. In development any port on localhost, 127.0.0.1 and private LAN IPs (10.x, 172.16-31.x, 192.168.x) is allowed too |

## TinyFish (live checks)

All TinyFish calls live in `app/services/tinyfish/tinyfish_client.py`, built on the official `tinyfish` SDK and verified against docs.tinyfish.ai. It implements the same `TinyFishClient` interface as the simulator, so the runner, SSE stream, screenshot storage and heatmap work unchanged.

**How each app is checked** (`CHECK_STRATEGY`, from live tests on 2026-10-18 at 110017):

| App | Method | Live result |
| --- | --- | --- |
| Instamart | Agent API, stealth browser | Works: sets the pincode, reads price/stock/ETA (~4 min) |
| Zepto | Agent API, stealth browser | Works (~3 min) |
| Blinkit | Agent API, stealth browser | Blinkit blocks automation ("access denied"); the check fails fast as *blocked* |

Plain Browser API sessions (Playwright over CDP, Indian proxy) are also implemented and selectable per app, but in testing Blinkit returned 403s, Zepto rendered blank, and Instamart required phone login once a location was set. The agent goal is strictly read-only: it never clicks ADD, never opens the cart or checkout, and never logs in. Each result stores the agent's last screenshot as proof (`GET /v1/runs/{id}/steps/{step}/screenshot`). The Agent API only accepts proxy countries US/GB/CA/DE/FR/JP/AU, so agent runs use TinyFish's default network.

**Cost guard.** Live runs needing more than `TINYFISH_LIVE_MAX_JOBS_PER_RUN` checks (default 6) are refused with `422 live_job_limit`, including scheduled runs, so the scheduler can never start hundreds of paid agent runs.

**Errors.** Bad key (401/403) and an empty wallet (402) fail fast and are logged as errors. Rate limits (429), 5xx and network errors are retried by the SDK, then once more by the runner. Blocked pages and unserviceable pincodes fail without a retry. Every failure keeps its agent trace for replay.

**Try one check end to end** (uses real credits: one agent run, about 4 minutes):

```bash
pip install -r requirements.txt       # adds tinyfish + playwright
echo "TINYFISH_API_KEY=sk-..." >> .env  # never commit .env
python -m scripts.check_pincode --app instamart --pincode 110017 \
    --product "Amul Taaza Toned Milk 500 ml"
```

It streams each agent step, prints the result JSON (`app, pincode, in_stock, price, eta, screenshot_url, ...`), and exits non-zero on failure. Without a key, add `--allow-simulated` to run the same path against the simulator.

## Smart price-recommendation threshold

Price suggestions no longer fire on every small gap (`app/services/price_thresholds.py`):

- **Hard bounds**: `break_even = cost / (1 - commission%)`, `safe_floor = max(floor_price, break_even × (1 + min_margin%))`, ceiling = `mrp`. No suggested or approved price leaves `safe_floor ≤ price ≤ MRP`, and the max-change / daily-cap guardrails still apply.
- **Trigger**: per-product `price_sensitivity` — essential 4%, regular 7% (default), premium 10% — and never under ₹2. Gaps use the true checkout price when every compared listing has one.
- **Persistence**: over the threshold in 2 consecutive completed runs, or on ≥ 30% of the compared pincodes in the latest run.
- **Hysteresis**: within 7 days of the last price suggestion, a new one needs the gap to move by half the threshold.
- **Outcomes**: `price` (lower to a bounded target, optionally snapped to ₹x9/₹x5/₹x0 price points with `round_to_price_point`), `margin_risk` (rival is below your safe floor — "don't price-match"; approving only adds an action item and never counts toward the daily cap), or nothing, with the reason in the refresh response's `price_note`/`message`. Gemini price advice is filtered through the same rules.
- New nullable product fields: `commission_pct` (0–60), `mrp` (> 0, ≥ floor and cost), `price_sensitivity`, `round_to_price_point`. Default `price_gap_pct` alert rules use the sensitivity threshold.

**After deploying, run `alembic upgrade head` on the production database** (adds revision `0002_price_thresholds`) before starting the new API.

## Postgres / Supabase

**Supabase setup (tested against PostgreSQL 17):**

1. Create a Supabase project. In Project Settings -> Database -> Connection string, copy the **Session pooler** URL (port 5432).
2. Put it in `backend/.env` with the prefix changed to `postgresql+asyncpg://` (never commit it).
3. From `backend/`: `alembic upgrade head` then `python -m scripts.seed`, then restart the API.
4. Optional screenshots in Supabase Storage: create a **public** bucket `screenshots` and set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. Without them screenshots stay in `backend/media/`.

Leave `SUPABASE_JWT_SECRET` blank for the demo; setting it turns on Supabase login for every request. Connections are health-checked before use (the pooler closes idle ones), and port 6543 (transaction pooler) disables prepared-statement caching automatically.

Set `DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/dbname` to run against Postgres instead of SQLite; the engine selects the driver from the URL and no code changes are needed. Alembic runs through the same async driver as the app (aiosqlite/asyncpg), so no sync driver is needed. The initial revision is explicit `op.create_table` DDL using only generic types (`String`, `Float`, `JSON`, timezone-aware `DateTime`), with `ON DELETE` rules and a partial unique index allowing one active run per product; SQLite runs in batch mode and enforces foreign keys (`PRAGMA foreign_keys=ON`). UUID primary keys are stored as 36-character strings for portability.

## Operations

- Each response carries an `X-Request-ID` header; every error, including 404/405, validation (422, with `fields: [{loc, msg}]`), conflicts (409) and 500s (which keep CORS headers), uses `{"error": {"code", "message", "fields"?}}`.
- One process runs everything: API, asyncio check runner, the 15-minute due-run scheduler, the daily briefing job, and the Telegram bot. No Redis, Celery, or separate worker.
- Check runs execute in the background (`asyncio.create_task`); `POST /api/products/{id}/runs` returns immediately with a `run_id` and estimated credits, and progress streams on `GET /api/runs/{run_id}/stream` (SSE).
- After each run the pipeline detects change events, evaluates alert rules (with per-day dedupe and quiet hours), regenerates the AI summary/recommendations/review insights, and delivers alerts to linked Telegram chats.
- Telegram link codes are random `SS-…` tokens that expire in 10 minutes, are single-use, and replace the product's earlier unused codes; failed `/start` attempts are rate-limited per chat. The bot supports `/start <code>`, `/link <code>`, `/status`, `/ask <question>`, and `/stop`; recommendation messages carry inline Approve and Details buttons.
