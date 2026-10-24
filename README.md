# ShelfSense

**See your market the way shoppers do.**

ShelfSense is an AI assistant that shows online sellers where they're losing sales and tells them how to win them back without starting a price war. It tracks a seller's products and competitors on quick-commerce apps (Blinkit, Zepto, Instamart) and marketplaces (Amazon, Flipkart), checks price and stock **pincode by pincode**, works out the **true price** shoppers pay, shows everything on a **heatmap**, explains it in plain English, and lets the seller approve actions with **one tap on Telegram**.

> Built by **Team CodeCrunchers** (USICT, GGSIPU) for **HackIIITD**.

---

## Table of contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [How we use TinyFish](#how-we-use-tinyfish)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Mock mode](#mock-mode)
- [Connecting the real services](#connecting-the-real-services)
- [API overview](#api-overview)
- [Running tests](#running-tests)
- [Deployment](#deployment)
- [Project status and limitations](#project-status-and-limitations)
- [Responsible use](#responsible-use)
- [Roadmap](#roadmap)
- [Team](#team)

---

## The problem

- On quick-commerce apps, every local dark store has its own stock, so a product can be **in stock 2 km away but missing here**.
- When shoppers see "out of stock", they buy a competitor in seconds, and the seller never finds out.
- **Listed prices aren't real prices.** Fees and offers change what shoppers actually pay.
- Existing tools are built for big brands and show dashboards rather than clear actions.

## How it works

1. **Add a product:** paste a link or name.
2. **Find competitors:** ShelfSense suggests similar products; the seller confirms them.
3. **Agents check every pincode:** TinyFish web agents open each app, set the pincode, and read price, stock and delivery time, saving a screenshot as proof.
4. **The heatmap lights up:** each pincode becomes a pin: in stock, out of stock, or price gap.
5. **The AI explains:** for example, *"You're out of stock in 4 South Delhi pincodes. At checkout you're ₹2 cheaper than the rival, so don't cut price. Restock."*
6. **Approve on Telegram:** recommendations arrive with an **Approve** button. Nothing changes without the seller's approval.

---

## How we use TinyFish

TinyFish web agents are ShelfSense's data layer: they visit the real quick-commerce and marketplace sites the way a shopper does and return structured, verifiable results. All calls go through the official [`tinyfish` Python SDK](https://docs.tinyfish.ai).

| App | TinyFish API | What happens | Live-tested (Delhi, Oct 2026) |
|---|---|---|---|
| **Zepto** | Agent API (stealth browser) | The agent opens Zepto, sets the delivery pincode in the site's location picker, searches the product and reads price, stock and delivery time | ✅ 110017, 110016, 110048 |
| **Instamart** | Agent API (stealth) + Browser Context Profile | Same flow, inside a saved team session (Instamart asks anonymous visitors to log in) | ✅ 110017, 110016, 110048 |
| **Amazon.in** | Search API + Fetch API | Search finds the product page; Fetch reads it in seconds (price, MRP, stock, delivery date) | ✅ |
| **Flipkart** | Search API + Fetch API | Same as Amazon | ✅ |
| **Blinkit** | Agent API (stealth) | Blinkit blocks automated browsers, so it is shown as *Unavailable* rather than faked | ❌ blocked |

**Why two methods?** Agent runs can type a pincode, so quick-commerce results are truly per pincode, but they take 3–8 minutes and cost a credit. Fetch is fast and free but reads the page as TinyFish's server sees it, so Amazon and Flipkart results are listing-wide and labelled that way in the app.

**Every result is verifiable.** Each check stores the agent's step-by-step trace, its own notes (e.g. *"the 500 ml pack was sold out; closest match is the 1 L pack at ₹74"*) and a proof screenshot. All of it is shown on the **Agents** page and attached to Telegram alerts.

**Safety and cost controls**
- Read-only goals: agents never add to cart, open checkout, log in with a shopper's account or enter payment details.
- Live runs are capped (`TINYFISH_LIVE_MAX_JOBS_PER_RUN`), each listing is fetched once per run, and agent runs time out and are cancelled.
- If a live check is blocked, ShelfSense falls back to the last real result (marked *Cached*), and `TINYFISH_DEMO=true` replays saved live results so a demo never breaks.
- The API key stays on the server; the frontend never sees it.

**Where to look in the code**
- [`backend/app/services/tinyfish/tinyfish_client.py`](backend/app/services/tinyfish/tinyfish_client.py): SDK client, agent goals, structured output, error handling
- [`backend/app/services/tinyfish/marketplace.py`](backend/app/services/tinyfish/marketplace.py): Amazon and Flipkart Fetch parsers
- [`backend/app/services/tinyfish/demo_cache.py`](backend/app/services/tinyfish/demo_cache.py): cached fallback and demo mode
- [`backend/data/demo_results.json`](backend/data/demo_results.json) and [`demo_screenshots/`](backend/data/demo_screenshots/): real results captured from live runs
- [`backend/tests/test_tinyfish_client.py`](backend/tests/test_tinyfish_client.py): tests, including parsers checked against real page text

**Try one live check** (from `backend/`, with `TINYFISH_API_KEY` in `.env`):

```bash
python -m scripts.check_pincode --app flipkart --pincode 110017 --product "Haldiram Bhujia Sev 200 g"   # free, ~10 s
python -m scripts.check_pincode --app zepto --pincode 110017 --product "Amul Taaza Toned Milk 500 ml"  # 1 credit, 3-8 min
```

---

## Features

### Monitoring
- **Pincode Mapper:** price, stock and delivery time across many pincodes and platforms in parallel.
- **Competitor tracking**, plus **automatic competitor discovery**.
- **True-price check:** final price after fees and offers (never places an order).
- **Evidence screenshots** for every check.
- **Scheduled checks** (every 3 h to weekly); products whose prices change often are checked more often.

### Understanding
- **Pincode heatmap:** in stock, out of stock, price gap (≥5% above rival), stale; clusters of stock-outs shown as hot zones.
- **Snapshots:** now, 6 h, 24 h, 7 days ago.
- **Weekly changes per platform:** this week vs last week, 7-day chart, changelog.
- **Competitor summary table** and **review insights**.

### Deciding
- **AI summary** and prioritised **AI recommendations**.
- **Guardrails:** recommendations never break the seller's minimum margin, floor price or maximum daily price change.
- **"Win without price wars" ideas:** bundles, offers and listing improvements based on rival weaknesses.

### Acting
- **Telegram bot:** alerts, daily briefing, **Approve / Details** buttons.
- **One-tap approval** synced with the dashboard.
- **Plain-English alert rules**, e.g. *"Alert me if we go out of stock in South Delhi."*

### Help and account
- **Help Centre chatbot** that answers using the seller's own data.
- **Plans and usage limits** (Free / Pro / Brand; payments in test mode).
- **Product settings** and **user settings** (profile, notifications, language, security, data export).

### Screens

| Route | Screen |
|---|---|
| `/` | Home |
| `/dashboard` | User Dashboard |
| `/products` | Products list |
| `/products/[id]` | Product Dashboard |
| `/products/[id]/heatmap` | Heatmap + summary |
| `/products/[id]/telegram` | Telegram connection |
| `/products/[id]/settings` | Product settings |
| `/help` | Help Centre |
| `/settings` | User settings |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, Tailwind CSS, Leaflet + OpenStreetMap, Framer Motion |
| Backend | Python 3.11+, FastAPI, Pydantic v2, SQLAlchemy 2.0 (async), Alembic |
| Jobs and scheduling | asyncio job runner, APScheduler |
| Live updates | Server-Sent Events |
| Database and storage | PostgreSQL on Supabase (SQLite locally), Supabase Storage |
| Auth | Supabase Auth (dev auth locally) |
| Web agents | TinyFish (Agent, Browser, Search, Fetch APIs) |
| AI | Google Gemini API |
| Messaging | Telegram Bot API (python-telegram-bot) |
| Hosting | Vercel (frontend); backend runs locally for the demo |

### Design system ("Holst")
Ink Navy `#0D1B2A` · Deep Navy `#1B263B` · Slate Blue `#415A77` · Sage `#778D7A` · Sand `#D4C4A8` · Linen `#F4F1DE`.
Fraunces (headings) and Inter (body). Soft-brutalist style: flat colour cards, 2 px outlines, solid offset shadows. Status is always shown with colour **plus** an icon and label.

---

## Architecture

```
          Seller (web dashboard / Telegram)
                 │                  │
     Next.js frontend          Telegram app
                 │                  │
                 ▼                  ▼
   ┌──────────── FastAPI backend (one process) ────────────┐
   │ REST API + SSE │ Job runner │ Scheduler │ Telegram bot │
   └──────┬──────────────┬─────────────┬───────────────────┘
          │              │             │
   Supabase (Postgres   TinyFish     Gemini
   + Storage + Auth)    web agents   AI
```

**Check pipeline**
1. A run starts (manually or on schedule) after plan limits and credit budget are checked.
2. One job is created per product × platform × pincode (including competitors).
3. Jobs run in parallel, limited by `TINYFISH_MAX_CONCURRENCY`.
4. Each result is validated, retried once on failure, saved with its screenshot, and streamed to the heatmap.
5. After the run: change detection → alerts → AI summary and recommendations → Telegram messages.

---

## Repository structure

```
shelfsense/
├── frontend/
│   ├── app/                    # Next.js routes (see Screens table)
│   ├── components/             # UI components (cards, pins, heatmap, chat, etc.)
│   ├── lib/                    # API client, hooks, formatters
│   ├── styles/                 # globals.css, design tokens
│   ├── public/
│   ├── .env.example
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py             # app factory, routers, startup (scheduler + bot)
│   │   ├── config.py           # settings and feature flags
│   │   ├── db.py  deps.py
│   │   ├── models/             # SQLAlchemy models
│   │   ├── schemas/            # Pydantic schemas
│   │   ├── api/                # routers
│   │   ├── services/
│   │   │   ├── tinyfish/       # base, tinyfish_client (SDK), mock_client, goals
│   │   │   ├── runner.py  events.py  heatmap.py  insights.py
│   │   │   ├── ai/             # gemini, fallback, prompts
│   │   │   ├── alerts.py  telegram_bot.py  storage.py  plans.py
│   │   ├── scheduler.py
│   │   └── utils/
│   ├── alembic/  alembic.ini
│   ├── data/pincodes_delhi.csv
│   ├── scripts/seed.py
│   ├── tests/
│   ├── .env.example
│   └── requirements.txt
├── docs/                       # PRD, design and video specs
└── README.md
```

---

## Getting started

### Prerequisites
- Python **3.11+**
- Node.js **20+** and npm
- Git

### 1. Clone

```bash
git clone https://github.com/<your-team>/shelfsense.git
cd shelfsense
```

### 2. Backend

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env        # works with empty values (mock mode)

alembic upgrade head        # create tables
python -m scripts.seed      # demo user, products, pincodes, history

uvicorn app.main:app --reload
```

- API: http://127.0.0.1:8000
- Interactive docs: http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/api/health

### 3. Frontend

```bash
cd ../frontend
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

Open http://localhost:3000.

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Purpose | Required for real mode |
|---|---|---|
| `APP_ENV` | `development` or `production` | No |
| `MOCK_MODE` | Force mock mode on/off (auto when keys are missing) | No |
| `DATABASE_URL` | Postgres URL (`postgresql+asyncpg://…`); SQLite is used if empty | For Supabase |
| `TINYFISH_API_KEY` | TinyFish API key | Yes, for real checks |
| `TINYFISH_PROXY_COUNTRY` · `TINYFISH_BROWSER_TIMEOUT_SECONDS` | Browser session exit country (default `IN`) and per-check budget | No |
| `TINYFISH_MAX_CONCURRENCY` | Parallel runs (2 on the free plan) | No |
| `GEMINI_API_KEY` · `GEMINI_MODEL` | Gemini AI | Yes, for real AI |
| `TELEGRAM_BOT_TOKEN` · `TELEGRAM_BOT_USERNAME` | Telegram bot | Yes, for Telegram |
| `SUPABASE_URL` · `SUPABASE_SERVICE_KEY` · `SUPABASE_JWT_SECRET` | Storage and auth | Yes, for Supabase |
| `SUPABASE_STORAGE_BUCKET` | Screenshot bucket (default `screenshots`) | No |
| `FRONTEND_ORIGIN` | Allowed CORS origin (default `http://localhost:3000`) | No |

### Frontend (`frontend/.env.local`)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL |
| `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Auth on the client (optional in dev) |

> **Never commit `.env` files or real keys.** Only `.env.example` files belong in Git.

---

## Mock mode

The app runs **without any keys**. Each missing integration switches to a safe fallback:

| Missing | Fallback |
|---|---|
| `TINYFISH_API_KEY` | Mock client returns realistic, repeatable results (some stock-outs, price gaps and failures) |
| `GEMINI_API_KEY` | Rule-based summaries and answers with the same output format |
| `TELEGRAM_BOT_TOKEN` | Bot doesn't start; messages are logged instead of sent |
| Supabase storage | Screenshots saved to `backend/media/screenshots` |
| `DATABASE_URL` | Local SQLite file `shelfsense.db` |
| Supabase auth | Every request uses the seeded demo user |

`GET /api/health` shows which integrations are real and which are mocked.

---

## Connecting the real services

1. **TinyFish:** create an account and copy the API key into `.env` as `TINYFISH_API_KEY`. The backend uses the official `tinyfish` SDK (no base URLs to set); all TinyFish calls live in `backend/app/services/tinyfish/tinyfish_client.py`.
   **Do the feasibility test first:** check that an agent can set a pincode and read price and stock on each quick-commerce site.
2. **Gemini:** create a key in Google AI Studio and set `GEMINI_API_KEY` and `GEMINI_MODEL`.
3. **Telegram:** message **@BotFather** → `/newbot`, then set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`. The bot uses long polling, so no public URL is needed.
4. **Supabase:** create a project; copy the **session pooler** connection string into `DATABASE_URL` (change the prefix to `postgresql+asyncpg://`); create a `screenshots` bucket; set the URL, service key and JWT secret.

Restart the backend after editing `.env`.

### Telegram connection flow
1. The web app requests a one-time code (valid 10 minutes).
2. The user opens `https://t.me/<bot>?start=<code>` (or `?startgroup=<code>` for a group), or sends `/link <code>`.
3. The bot links that chat to the product; the web page detects it and moves to the next step.
4. The user picks alert types and sends a test alert.

Bot commands: `/start`, `/link`, `/status`, `/ask <question>`, `/stop`.

---

## API overview

All routes are under `/api`. Full details are in the interactive docs at `/docs`.

| Area | Endpoints |
|---|---|
| Health and account | `GET /health` · `GET /me` · `GET /dashboard` |
| Products | `GET/POST /products` · `GET/PATCH/DELETE /products/{id}` · `PUT /products/{id}/pincodes` · `PUT /products/{id}/alert-rules` |
| Competitors | `GET/POST /products/{id}/competitors` · `POST /products/{id}/competitors/discover` · `POST /competitors/{id}/confirm` · `DELETE /competitors/{id}` |
| Runs | `POST /products/{id}/runs` · `GET /runs/{run_id}` · `GET /runs/{run_id}/stream` (SSE) |
| Heatmap | `GET /products/{id}/heatmap` · `GET /products/{id}/heatmap/pincodes/{code}` |
| Insights | `GET /products/{id}/overview` · `GET /products/{id}/competitors/summary` · `GET /products/{id}/weekly` · `GET /products/{id}/weekly/report.csv` · `GET /products/{id}/reviews` |
| Recommendations | `POST /recommendations/{id}/approve` · `/dismiss` · `/send-telegram` |
| Help Centre | `POST /chat` · `GET /chat/conversations` · `GET /chat/conversations/{id}` · `GET /help/topics` |
| Telegram | `POST /products/{id}/telegram/link-code` · `GET /products/{id}/telegram/status` · `PATCH /products/{id}/telegram` · `POST /products/{id}/telegram/test` · `DELETE /products/{id}/telegram` |
| Settings | `GET/PATCH /me/settings` · `GET /me/export` · `DELETE /me` · `POST /me/plan` |

Errors use one format: `{"error": {"code": "...", "message": "..."}}`.

---

## Running tests

```bash
# backend
cd backend
pytest
ruff check .

# frontend
cd frontend
npm run lint
npm run build
```

Backend tests cover: health, product CRUD, plan limits, the full check pipeline in mock mode (including SSE), heatmap classification, change detection, AI fallback and grounding checks, Telegram code expiry and single use, and data isolation between users.

---

## Deployment

| Part | Hackathon demo | After the hackathon |
|---|---|---|
| Frontend | Vercel (free) or local | Vercel |
| Backend + bot + scheduler | **Run on a team laptop** (free hosts sleep when idle, which stops the bot) | Always-on host; split the job runner and bot into workers with a queue |
| Database / storage | Supabase free tier | Supabase paid tier with Row Level Security |

**Demo-day checklist:** `/api/health` is green, cached demo run is loaded, the bot replies to `/status`, a backup screen recording is ready.

---

## Project status and limitations

| Working in the MVP | Prototype or mocked |
|---|---|
| Pincode checks via TinyFish, heatmap, screenshots | True checkout price (only on sites that show it without login) |
| AI summary, recommendations, Help Centre chat | Applying price changes in seller dashboards |
| Telegram linking, alerts, one-tap Approve | Payments and plan changes (test mode) |
| Product and user settings, plan limits | Large-scale coverage (50+ pincodes live) |

**Known limits**
- **TinyFish free credits** allow only a limited number of checks. The demo uses about 10–15 pincodes, with results pre-run and cached.
- **Quick-commerce websites may block automation** or handle location differently on the web than in the app.
- **Checkout on quick-commerce apps usually needs a phone login,** so the true-price feature is partly a prototype.
- **Gemini free-tier rate limits apply;** the rule-based fallback covers outages.

---

## Responsible use

- Reads product pages only and is strictly read-only: never adds to cart, opens checkout or **places orders**.
- Never uses a shopper's own accounts. Where an app requires sign-in (Instamart), a ShelfSense team test account is used through a TinyFish Browser Context Profile.
- Requests are rate-limited and spaced out.
- Every action requires **human approval**; guardrails prevent unsafe price suggestions.
- AI answers are restricted to stored data and validated before being shown.
- API keys stay on the server and are never committed.

Check each platform's terms of service before any production use.

---

## Roadmap

- Official seller API integrations to apply approved price changes
- More platforms (Flipkart Minutes, Amazon Now, BigBasket) and cities
- Distributor reports and city-wide Brand plan
- Demand forecasting by pincode
- Hindi and regional-language alerts
- Learning loop: track which recommendations worked and improve future advice
- Real payments (subscriptions and add-ons)

---

## Team

| Member | Role |
|---|---|
| Vaibhav Singla | UI/UX |
| Rohan Garg | Full Stack |
| Jiya Aggarwal | Frontend |
| Bhavya Bansal | Full Stack |

**Team CodeCrunchers · USICT, GGSIPU · HackIIITD**

---

## License

To be decided by the team (for example MIT). Add a `LICENSE` file before making the repository public.