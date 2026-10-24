# ShelfSense — Project Brief

**"See your market the way shoppers do."**

Team CodeCrunchers · USICT, GGSIPU ·

Labels used in this brief: **Working** means it runs in the code today. **Mock** means it works only with simulated data. **Prototype** means it is partly built or works only in some cases. **Planned** means it is not built yet.

---

## 1. Problem Statement

**Every dark store has its own stock.** On Blinkit, Zepto and Instamart, each pincode is served by a local dark store. A product can be in stock 2 km away and missing here. The shopper buys a rival in seconds, and the seller never learns about the lost sale.

**The listed price is not the price the shopper pays.** Handling fees, delivery fees and offers change the final amount. A rival that looks cheaper can cost more at checkout, so a seller may cut price for no reason.

**Existing tools are built for big brands.** They are expensive and show dashboards instead of telling a small seller what to do.

**A shopper example.** A shopper in Malviya Nagar looks for Amul milk. It is out of stock at their dark store, so they add Mother Dairy instead. The Amul seller only sees slightly lower sales.

---

## 2. Proposed Solution

ShelfSense is a web app with a Telegram bot. It checks a seller's products and rivals pincode by pincode, maps the results, explains them and suggests actions for the seller to approve.

### How it works

1. **Add a product.** Paste a link or a name, choose platforms and pincodes.
2. **Find rivals.** ShelfSense suggests competitor products and the seller confirms them. (Suggestions are **Mock** today; see Section 8.)
3. **Agents check each pincode.** TinyFish web agents open each app, set the delivery pincode, and read price, MRP, stock and delivery time. Each result saves a screenshot and a step-by-step trace.
4. **The heatmap updates.** Each pincode becomes a pin: in stock, out of stock, price gap, or stale.
5. **The AI explains.** A short summary and up to five ranked recommendations, built only from the stored numbers.
6. **Approve on Telegram.** Recommendations arrive with **Approve** and **Details** buttons. Nothing is marked approved without the seller.

### Features

Status of each feature is in Section 8.

| Group | Features |
|---|---|
| **Monitoring** | Pincode checks (price, MRP, stock, delivery time), competitor tracking and discovery, true checkout price, screenshots and agent traces, scheduled checks (3 h to weekly) |
| **Understanding** | Pincode heatmap with hot zones, snapshots (now / 6 h / 24 h / 7 days), weekly changes with chart and CSV, competitor summary, review insights |
| **Deciding** | AI summary, ranked recommendations, pricing guardrails |
| **Acting** | Telegram alerts, daily briefing, Approve button, plain-English alert rules, bot commands (`/check`, `/compare`, `/status`, `/ask`) |
| **Help & account** | Help Centre chatbot, plans and usage limits, product and user settings, data export |

### Screens (from `frontend/src/app`)

| Route | Screen |
|---|---|
| `/` | Home (marketing page; widget numbers are illustrative) |
| `/login` | Login (Supabase Auth, optional in demo) |
| `/dashboard` | User dashboard |
| `/products` | Products list |
| `/products/[id]` | Product dashboard |
| `/products/[id]/heatmap` | Product heatmap and summary |
| `/products/[id]/telegram` | Telegram connection |
| `/products/[id]/settings` | Product settings (floor price, margin, max change, alerts) |
| `/heatmap` | Heatmaps across products |
| `/agents` | Agent runs: status, step timeline, replay, screenshots |
| `/help` | Help Centre and chatbot |
| `/settings` | User settings, plan, Telegram, data |

### Worked example (illustrative scenario, not a measured result)

> **Amul Taaza Toned Milk 500 ml · Blinkit · Delhi NCR · 14 pincodes**
> Result: 9 in stock, 4 out of stock (South Delhi), 1 price gap.
>
> | | Amul (seller) | Mother Dairy (rival) |
> |---|---|---|
> | Listed price | ₹29 | ₹27 (looks ₹2 cheaper) |
> | At checkout | ₹29 | ₹31 (₹4 fees) |
>
> At checkout the seller is ₹2 cheaper.
> **AI conclusion:** "Don't cut price. Restock 4 South Delhi pincodes."
> **Approved on Telegram:** "Alert distributor".

Note: live Blinkit checks are blocked today, so this run works only in mock mode (the same flow runs live on Zepto and Instamart). Approving "Alert distributor" records the decision; ShelfSense does not yet contact a distributor.

---

## 3. Target Users / Use Cases

| User | Their situation | What they get |
|---|---|---|
| **Small marketplace sellers** | Sell on Amazon and Flipkart; check rivals by hand | Price and stock view against rivals, Telegram alerts, safe pricing advice |
| **New D2C brands on quick commerce** | Cannot see which dark stores run out | Pincode heatmap, stock-out hot zones, restock prompts |
| **Brand and sales teams** | Many SKUs and cities; need proof for distributors | Higher plan limits, screenshot evidence, weekly CSV report |

**Use case 1: Stock-out in one area.** Three or more stock-outs within 3 km form a hot zone. A rule like "Alert me if we go out of stock in South Delhi" sends a Telegram alert.

**Use case 2: Avoiding a needless price cut.** A rival lists lower. Any suggested new price must pass the floor, margin and daily-change rules.

**Use case 3: Quick check from the phone.** The seller sends `/check` in Telegram, picks an app and pincode, and gets the result with a screenshot.

---

## 4. Role of Machine Learning / AI

### Model and tasks

ShelfSense uses **Google Gemini** through the official `google-genai` SDK. The default model is **`gemini-2.5-flash`** (overridable with `GEMINI_MODEL`). Settings: JSON-only output, temperature 0.2, 1,024 max output tokens, 30-second timeout. Gemini does five tasks (`app/services/ai/`):

| Task | Output |
|---|---|
| Summarise | 2–3 sentence product summary |
| Recommend | Up to 3 proposals with priority, action, impact, evidence |
| Reviews | "Loves" and "complaints" phrases (inferred from signals, Prototype) |
| Chat | Help Centre and Telegram `/ask` answers, with in-app action links |
| Parse alert rule | Plain-English rule into a structured rule |

No model is trained or fine-tuned in this project.

### Grounding and validation

- **Grounded input.** Each prompt carries only measured numbers (KPIs, heatmap counts, stock-out pincodes, recent changes, pricing rules) and says to use nothing else.
- **Schema check.** Answers are parsed as JSON and validated with Pydantic.
- **Grounding check.** In summaries, recommendations and chat, any pincode or rupee amount not in the context rejects the answer.
- **Safe links.** Chat actions may only link to known in-app routes.

### Fallback

If there is no key, or Gemini errors, times out or fails the grounding check, a **rule-based fallback** answers in the same format from the same numbers. The source of each answer is stored.

### Code-level guardrails (`app/services/intelligence.py`)

- **Floor price:** proposals below the floor are dropped.
- **Minimum margin:** proposals below cost × (1 + margin %) are dropped.
- **Maximum daily change:** proposals above the max % change, alone or added to today's approved changes, are dropped.
- **Re-check on approval** against fresh numbers.
- **Ban-list:** price fixing, cartels, fake reviews, sabotage.
- **Priority limit:** "high" only with 3+ stock-out pins or a 5%+ price gap.

### Rule-based logic (not AI)

| Logic | Rule |
|---|---|
| Heatmap status | Stale if failed, missing or older than 24 h; out of stock if seller not in stock; price gap if seller price ≥ 1.05 × cheapest fresh in-stock rival; else in stock |
| Hot zones | ≥ 3 out-of-stock pincodes within 3 km (haversine distance) |
| Change detection | Each new result compared with the previous result in a 14-day window |
| Alerts | Seven rule kinds, once per day per condition, quiet hours respected |

### Agent roles mapped to modules

These role names are not in the code; they map to modules like this:

| Role | What it does | Module | Status |
|---|---|---|---|
| **Scout** | Collects price, stock and delivery data | `services/tinyfish/`, `services/runner.py` | Working |
| **Analyst** | Heatmap, hot zones, change detection, weekly stats | `services/heatmap.py`, `services/insights.py` | Working (rules) |
| **Strategist** | Summary and guarded recommendations | `services/intelligence.py`, `services/ai/` | Working |
| **Creative** | Bundles, offers, listing copy | none | **Planned** |

### Planned AI work

Demand forecasting by pincode, learning from approved actions, review analysis from real review text, and listing or offer copy generation.

---

## 5. Proposed Technical Approach

### Architecture

```
        Seller (web dashboard)        Seller (Telegram)
                 |                           |
        Next.js frontend              Telegram Bot API
                 |  REST + SSE               |  long polling
                 v                           v
  +-------------- FastAPI backend (one process) ---------------+
  |  REST API | SSE stream | asyncio job runner | APScheduler  |
  |  Telegram bot | AI layer (Gemini + rule fallback)          |
  +------+-------------------+--------------------+------------+
         |                   |                    |
   SQLite / Postgres    TinyFish APIs         Google Gemini
   (Supabase) +         (Agent, Search,
   screenshot storage    Fetch, Browser)
```

### Tech stack

| Layer | Technology (from `package.json` / `requirements.txt`) |
|---|---|
| Frontend | Next.js 15.5, React 19.1, Tailwind CSS 4, TypeScript 5, SWR, Leaflet + react-leaflet (OpenStreetMap), Motion, Lenis, Supabase JS |
| Backend | Python, FastAPI, Uvicorn, Pydantic v2, pydantic-settings, SQLAlchemy 2 (async), Alembic, httpx, PyJWT |
| Database | aiosqlite (local) or asyncpg (Postgres / Supabase) |
| Live updates | sse-starlette (Server-Sent Events) |
| Scheduling | APScheduler |
| Web agents | `tinyfish` SDK, Playwright (over CDP) |
| AI | `google-genai` (Gemini) |
| Messaging | python-telegram-bot 21 |

### Check pipeline (`services/runner.py`)

1. A run starts by hand, from Telegram `/check`, or from the scheduler (every 15 minutes it looks for due products).
2. Plan limits and today's credit budget are checked.
3. Jobs are created: (seller product + each confirmed competitor) × platforms × pincodes. Live runs over `TINYFISH_LIVE_MAX_JOBS_PER_RUN` (default 6) are refused.
4. Jobs run in the background, capped by `TINYFISH_MAX_CONCURRENCY` (default 2).
5. Each result is validated, retried once if the error is retryable, saved with its screenshot and trace, and streamed to the page over SSE.
6. After the run: change detection → alert rules → AI summary, recommendations and review insights → Telegram delivery.

### Data model (main tables)

- **Users:** users, subscriptions, settings.
- **Products:** products (with floor price, cost, margin, max change, frequency), listings, competitors, pincodes (25 Delhi pincodes seeded).
- **Checks:** runs, results (price, stock, ETA, screenshot, trace), change events, credit ledger.
- **Intelligence:** AI summaries, recommendations, review insights, alert rules, alerts.
- **Chat and Telegram:** conversations, messages, link codes, links.

### Key API endpoints by screen (all under `/api`)

| Screen | Endpoints |
|---|---|
| Dashboard | `GET /dashboard` |
| Products | `GET/POST /products`, `PATCH /products/{id}`, `PUT /products/{id}/pincodes` |
| Competitors | `POST /products/{id}/competitors/discover`, `POST /competitors/{id}/confirm` |
| Product dashboard | `GET /products/{id}/overview`, `/weekly`, `/weekly/report.csv` |
| Heatmap | `GET /products/{id}/heatmap` |
| Agents | `POST /products/{id}/runs`, `GET /runs/{id}/stream` (SSE), `GET /check-results/{id}` |
| Recommendations | `POST /recommendations/{id}/approve`, `/dismiss` |
| Telegram | `POST /products/{id}/telegram/link-code` |
| Help / Settings | `POST /chat`, `PATCH /me/settings`, `GET /me/export` |

### Mock mode

The app runs with no keys. Each missing key switches one part to a fallback: simulated TinyFish results (about 15% stock-outs, 5% failures, SVG screenshots), rule-based AI, logged-only Telegram messages, local files, SQLite and a demo user. `MOCK_MODE=true` forces all mocks; `GET /api/health` shows what is live. `TINYFISH_DEMO=true` replays real results saved from earlier live runs.

### Security and responsible use

- Agent goals are read-only: no cart, no checkout, no login, no phone, OTP or payment details.
- Where Instamart needs sign-in, an optional **team test account** profile is used, never a shopper's account.
- API keys stay on the server (for example `TINYFISH_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`).
- Production requires JWT auth (`SUPABASE_JWT_SECRET`) and turns off demo login and test-mode plan switching.
- Telegram link codes expire in 10 minutes and are single-use. In groups, only the person who linked the group can approve.
- Every action needs human approval.

---

## 6. Proposed TinyFish Integration

### The four TinyFish APIs

| API | How ShelfSense uses it | Status |
|---|---|---|
| **Agent API** | Stealth browser agent sets the pincode, searches the product, reads the card, returns JSON against an output schema, plus a screenshot | **Implemented** for Zepto and Instamart (live-tested in Delhi). Blinkit blocks it, so checks fail fast as "blocked" |
| **Browser API** | Remote browser session driven by Playwright over CDP, with an Indian proxy | **Implemented but not the default.** In tests Blinkit returned 403, Zepto rendered blank, Instamart asked for phone login |
| **Search API** | Finds the Amazon or Flipkart product page for a product name | **Implemented** for marketplaces. Not yet used for competitor discovery (**Planned**) |
| **Fetch API** | Reads the Amazon or Flipkart product page and parses price, MRP and stock | **Implemented.** Cannot set a pincode, so results are listing-wide and labelled that way |

### Pincode Mapper flow

1. Pick the method per app (`CHECK_STRATEGY`): agent for quick commerce, fetch for marketplaces.
2. Build a read-only goal for the app, pincode and product.
3. Stream the agent run; each step goes to the trace and the SSE stream.
4. Validate the JSON, flag wrong pack sizes (`exact_match=false`), save the screenshot.
5. On a block or failure, use the last real cached result, marked as cached.

### Example goal (shortened)

```
You are checking price and stock on Zepto for delivery pincode 110017.
1. Open the location picker, type 110017, choose the first suggestion.
2. Search for "Amul Taaza Toned Milk 500 ml" and find that exact pack.
3. Read name, selling price, MRP, in stock or out of stock, delivery minutes.
STRICT RULES: read-only. Never click ADD. Never open cart or checkout.
Never log in. If blocked or a login is required, set blocked=true.
```

### Example JSON result (illustrative values from the worked example)

```json
{
  "location_set": true,
  "product_name": "Amul Taaza Toned Milk 500 ml",
  "exact_match": true,
  "in_stock": true,
  "price": 29,
  "mrp": null,
  "eta_minutes": null,
  "blocked": false,
  "notes": null
}
```

The live agent does not return checkout fees. The breakdown "item + handling + delivery − offer" (₹31 for Mother Dairy here) is produced only by the mock client today.

### Cost control and reliability

- Per-run cap on live jobs (default 6) and a daily credit budget per plan.
- Each marketplace listing is fetched once per run.
- Agent runs time out (default 600 s) and are cancelled.
- Bad key and empty wallet fail fast; rate limits and server errors are retried.
- Demo replay mode keeps a stage demo working without live calls.

### Honest constraints

- **Free-tier credits** allow only a small number of agent checks; each takes about 3–8 minutes.
- **Concurrency** is 2 sessions by default on the free plan.
- **Blinkit blocks automation** today, so it is off in live mode and shown as unavailable.
- **Checkout needs a phone login** on quick-commerce apps, so a live true checkout price is not built (Prototype / Mock).
- Site layouts change, and the web can differ from the app.

---

## 7. Expected Impact

These are **expected outcomes, not measured results.** No user study or sales data has been collected.

**For sellers**
- See hidden lost sales: stock-outs at specific pincodes.
- Avoid needless price cuts (fully, once live checkout prices work).
- Get a few clear actions on Telegram, not a dashboard to study.
- Keep screenshot proof for distributors.

**For the wider ecosystem**
- Small sellers get a tool big brands already pay for.
- Fewer price wars, because advice respects floor and margin rules.
- Better availability for shoppers if gaps are restocked faster.

---

## 8. Feasibility

### Status from the code

| Status | Features |
|---|---|
| **Working** | Live pincode checks on Zepto and Instamart (Agent API); Amazon and Flipkart (Search + Fetch); screenshots and agent traces; run streaming; heatmap, hot zones, snapshots; change detection; weekly stats and CSV; alert rules and quiet hours; Gemini summary, recommendations, chat, alert parsing with grounding check and rule fallback; pricing guardrails; Telegram linking, alerts, daily briefing, Approve, `/check`, `/compare`; plan limits and credit budget; settings and data export; tests in `backend/tests` |
| **Mock** | Blinkit checks (live is blocked); competitor discovery (placeholder suggestions); true checkout price breakdown; whole-app mock mode |
| **Prototype** | Review insights (inferred from signals, not real reviews); Browser API flow; payments and plan switching (test mode, no charge); marketplace results are listing-wide, not per pincode; `volatile_boost` setting is stored but the scheduler does not use it yet |
| **Planned** | Applying approved price changes on platforms; acting on "Alert distributor" outside ShelfSense; Creative role; Search-based competitor discovery; large-scale live coverage (50+ pincodes) |

### Why it is buildable

The pipeline already runs end to end in mock mode, and live on four platforms. Each integration sits behind one interface (`TinyFishClient`, `AIProvider`), so mock and live clients swap freely. The stack uses common open tools and free tiers.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sites block automation | Stealth agent, team profile, cached fallback, "blocked" label |
| TinyFish credit cost | Job cap, daily budget, demo replay, Fetch for marketplaces |
| AI invents numbers | Grounding check, schema check, rule fallback |
| Unsafe price advice | Guardrails, re-checked on approval |
| One process does everything | Planned workers and queue |

### Business model (prices illustrative)

| Plan | Price (illustrative, from the home page) | Limits in code |
|---|---|---|
| Free | Free | 3 products, 5 pincodes and 3 competitors per product, weekly checks, 100 credits/day |
| Pro | ₹999 / month | 25 products, 100 pincodes, 10 competitors, every 3 h, 1,000 credits/day |
| Brand | Custom | No product, pincode, frequency or credit limit; 25 competitors |

Payments are test mode only.

---

## 9. Future Scope

- **Seller API integrations** to apply approved changes.
- **More platforms and cities**: Flipkart Minutes, Amazon Now, BigBasket; beyond Delhi.
- **Distributor reports.**
- **Demand forecasting** by pincode.
- **Hindi and regional-language alerts.**
- **Learning from approved actions.**
- **Real payments.**
- **Scaling** with separate workers and a queue.

---

## Team

| Member | Role |
|---|---|
| Vaibhav Singla | UI/UX |
| Rohan Garg | Full Stack |
| Jiya Aggarwal | Frontend |
| Bhavya Bansal | Full Stack |

**Team CodeCrunchers · USICT, GGSIPU**
