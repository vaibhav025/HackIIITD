# ShelfSense — Video Brief (≈50 seconds)

This brief is for the editor or motion designer who will produce the video. Every screen, colour and font here comes from the ShelfSense code. Where a feature is not fully built, the brief labels it **Prototype** or **Planned** and asks for a **concept animation**. Concept animations must not look like a real recorded screen.

---

## 1. Overview

| Item | Detail |
|---|---|
| **Goal** | Show judges, in under a minute, the problem ShelfSense solves and how it solves it |
| **Audience** | Hackathon judges |
| **Length** | 50 seconds (accepted range 48–52 s) |
| **Format** | 1920×1080 landscape (main); 1080×1920 vertical (optional) |
| **Tone** | Calm, premium, confident. No hype, no fast cuts for their own sake |
| **One-sentence message** | ShelfSense checks every pincode the way a shopper does, finds the real price, and tells the seller what to do. |

---

## 2. Fact Sheet

**Every number, name and quote in the video must come from this table.** Do not add other numbers or percentages.

| Fact | Value |
|---|---|
| Product | Amul Taaza Toned Milk 500 ml |
| Platform | Blinkit |
| Region | Delhi NCR |
| Pincodes checked | 14 |
| Result | 9 in stock · 4 out of stock (South Delhi) · 1 price gap |
| Key pincode | 110017 · Malviya Nagar · Out of stock · ₹29 · checked 1h ago |
| Listed price | Amul ₹29 vs Mother Dairy ₹27 (rival looks ₹2 cheaper) |
| Checkout price | Amul ₹29 vs Mother Dairy ₹31 (₹4 fees) |
| Price verdict | "You're ₹2 cheaper at checkout." |
| AI conclusion | "Don't cut price. Restock 4 South Delhi pincodes." |
| Telegram approval | "Alert distributor: out of stock in 4 South Delhi pincodes" |
| Tagline | "See your market the way shoppers do." |
| Closing line | "Others show the listed price. We show the real one." |
| Team | Team CodeCrunchers · USICT, GGSIPU · HackIIITD |
| Members | Vaibhav Singla (UI/UX) · Rohan Garg (Full Stack) · Jiya Aggarwal (Frontend) · Bhavya Bansal (Full Stack) |

**Important notes on the demo story (read before recording):**

- **The story is a scripted scenario, not a recorded live result.** The app's demo seed (`python -m scripts.seed --with-demo-data`) creates the Amul product with simulated history. It puts a Blinkit stock-out cluster on 4 South Delhi pincodes (110017, 110019, 110048, 110049), but its other numbers are random. It also seeds 15 pincodes, not 14. Record the real screens for layout and motion, then **replace the numbers with the Fact Sheet values** using overlays built in the site's own style.
- **Pincode name.** In the app's pincode data (`backend/data/pincodes_delhi.csv`), 110017 is named **"Saket"**. The home page marketing widgets use **"Malviya Nagar"**. The video uses "Malviya Nagar" as the Fact Sheet says, so the 110017 tooltip must be an overlay or a recreation, not a raw recording.
- **Blinkit.** Live Blinkit checks are blocked by Blinkit's anti-automation today. Blinkit data in the app comes from mock mode. Do not claim a live Blinkit check on screen.
- **True price at checkout is a Prototype.** Only the mock agent produces a fee breakdown. The live agent never opens checkout. Show the price flip as a concept animation.
- **Telegram "Alert distributor".** Approving a recommendation in Telegram works in the code. ShelfSense does not contact a distributor itself. The approved text is just the recommendation being approved.

---

## 3. Visual Style (from the code)

Source files: `frontend/src/app/globals.css`, `frontend/src/app/layout.tsx`, `frontend/src/lib/motion.ts`, `design/MOTION.md`.

### Palette ("Holst", CSS variables in `globals.css`)

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#0D1B2A` | Text, borders, hard shadows, dark backgrounds |
| `--deep` | `#1B263B` | Dark panels, sidebar |
| `--slate` | `#415A77` | Primary buttons, active tabs, selected pin outline |
| `--sage` | `#778D7A` | "In stock" |
| `--sand` | `#D4C4A8` | "Price gap", stickers, logo tile |
| `--linen` | `#F4F1DE` | Page background, cards |

Use no other colours. Map tiles in the app are greyscale with a warm sepia filter.

### Fonts

- **Fraunces** (Google Fonts, variable, SemiBold 600, axes `SOFT 0`, `WONK 1`) for headings and big numbers.
- **Inter** for body text, labels and UI.

### Shapes and shadows

| Element | Style |
|---|---|
| Card (`.card`) | Linen fill, 2 px ink border, 20 px radius, 6 px solid ink offset shadow (`6px 6px 0 #0D1B2A`) |
| Button (`.btn`) | 2 px ink border, 12 px radius, 4 px hard shadow (3 px when small); primary = slate fill with linen text |
| Pill (`.pill`) | 12 px radius, 3 px shadow; active = slate fill |
| Sticker (`.sticker`) | Sand fill, 2 px ink border, 6 px radius, tilted −4° |
| Input (`.input`) | Linen fill, 2 px ink border, 12 px radius, soft slate glow on focus |

The look is "soft brutalist": flat colour, thick outlines, solid offset shadows, no gradients, no blur shadows.

### Heatmap pins (`.ss-pin`, 32 px circles, 2 px ink border)

| Status | Fill | Mark |
|---|---|---|
| In stock | Sage `#778D7A`, linen icon | ✓ check |
| Out of stock | Linen, **dashed** border, no shadow | ✕ |
| Price gap | Sand `#D4C4A8` | ₹ |
| Stale / failed | Linen at 45% opacity | — |
| Selected | 3 px slate outline, 3 px offset | — |

The app always shows status with colour **plus** an icon and a label. Keep that in the video.

### Logo (`Logo` in `frontend/src/components/AppShell.tsx`)

A 40 px sand tile (12 px radius, 2 px ink border, 3 px ink shadow) holding the scan-frame icon `frontend/public/figma/shell/logo.svg` (four corner brackets, ink stroke). Next to it: the "ShelfSense" wordmark in Fraunces 24 px, with "INTELLIGENCE" below in 10 px bold uppercase, letter-spacing 2.2 px. On dark backgrounds the wordmark is linen and "INTELLIGENCE" is sand.

### Motion guidelines (match the site)

- **Easing:** `cubic-bezier(0.22, 1, 0.36, 1)` (the house `EASE` in `lib/motion.ts`) for every move.
- **Hover lift / button press:** the element moves down-right up to 3 px while its hard shadow shrinks by the same amount; on press it lands on its shadow (shadow becomes 0). 120 ms.
- **Tab underline:** a 3 px underline grows left to right under the active tab.
- **Pin pop:** scale 0 → 1.18 → 1 over 420 ms (`pin-pop`, easing `cubic-bezier(.2,.9,.3,1.3)`).
- **Hot zone:** one-time scale-in from 0.4 with a fade.
- **Staggered reveal (`<Reveal>`):** fade in and rise 16 px, 60 ms between items, at most 8 items.
- **Count-up (`<CountUp>`):** numbers count up over 1.2 s.
- **Page transition:** slate wipe.
- Animate only position, scale, opacity and clipping. No bouncy or elastic moves except the pin pop. No looping motion except loaders.

---

## 4. Scene-by-Scene Script

Routes are relative to `http://localhost:3000`. "Overlay" means a graphic built in the site's style and placed over the real recording, using Fact Sheet numbers.

| # | Time | Topic | On screen (route / component, or concept animation) | On-screen text | Voiceover | Motion | SFX |
|---|---|---|---|---|---|---|---|
| 1 | 0–4 s | Hook / intro | Linen background. One out-of-stock pin (`.ss-pin.out_of_stock` style) pops in at centre. Product label card fades in. **Concept animation** in site style | "Amul Taaza · 500 ml · Out of stock" then "Your shopper just left." | "Your milk is out of stock. And you'd never know." | Pin pop 420 ms; card rises 16 px | Soft whoosh 0.2 s; thud 1.0 s |
| 2 | 4–9 s | Problem statement | Three cards stagger in, styled like the home page problem section (`/`, `home-problem` design, icons `probStore.svg`, `probClock.svg`, `probBolt.svg`). **Recreate** as cards | "Every dark store has its own shelf." · "Listed price ≠ real price." · "Tools are built for big brands." | "Every dark store has its own shelf. Listed prices hide fees. Big-brand tools miss both." | Staggered reveal, 60 ms; each card lands with a press | Three stamps, one per card |
| 3 | 9–15 s | Proposed solution | **Record** `/products/[id]/heatmap` (`HeatmapMap` in `components/heatmap/HeatmapMap.tsx`) for the Amul product. Pins pop in across South Delhi. **Overlay** stat cards 9 / 4 / 1 / 14 and the 110017 tooltip. A small flow strip at top: Add product → Agents check → Heatmap → AI explains → Approve on Telegram | "14 pincodes" · "9 in stock" · "4 out of stock" · "1 price gap" · Tooltip: "110017 · Malviya Nagar · Out of stock · ₹29 · checked 1h ago" | "ShelfSense checks every pincode. Nine in stock. Four out in South Delhi. One price gap." | Pins pop in staggered; stat numbers count up; hot zone scales in over South Delhi; tooltip rises | Pops for pins; stamp per stat card |
| 4 | 15–20 s | Target users / use cases | Three user cards (site `.card` style). Background: blurred `/products` list (`ProductGridCard` in `components/products/ProductViews.tsx`). **Recreate** cards | "Small marketplace sellers" · "New D2C brands on quick commerce" · "Brand and sales teams" | "Built for small sellers, new D2C brands, and brand sales teams." | Staggered reveal; slight hover lift on each | Light tick per card |
| 5 | 20–26 s | Role of ML / AI | Price comparison card: listed ₹29 vs ₹27, then flip to checkout ₹29 vs ₹31 (₹4 fees). **Concept animation** (true checkout price is Prototype). Then **record** the AI summary and `RecommendationCard` (`components/RecommendationCard.tsx`) on `/products/[id]`, with the AI conclusion as overlay text | "Listed: Amul ₹29 · Mother Dairy ₹27" → "At checkout: Amul ₹29 · Mother Dairy ₹31 (₹4 fees)" → "You're ₹2 cheaper at checkout." → "Don't cut price. Restock 4 South Delhi pincodes." | "Mother Dairy looks cheaper. Add the fees, and you're two rupees cheaper. AI says: don't cut price. Restock." | Card flips on Y axis; numbers count; recommendation card rises | Ding on the flip; soft whoosh into recommendation |
| 6 | 26–32 s | Technical approach | Animated architecture diagram. **Concept animation** (diagram only, the parts are real): Next.js frontend → FastAPI backend → TinyFish · Gemini AI · Postgres/SQLite · Telegram bot | "Next.js · React · Tailwind" · "FastAPI · Python" · "TinyFish" · "Gemini" · "Postgres / Supabase" · "Telegram bot" | "Next.js and FastAPI, with Gemini AI, Postgres and a Telegram bot." | Boxes draw in left to right; connector lines grow; staggered reveal | Short whoosh per connection |
| 7 | 32–38 s | TinyFish integration | **Record** `/agents`: `AgentConsole` and `StepTimeline` (`components/agent/`) running a check, then `ScreenshotThumb` / `Lightbox` opening the evidence screenshot. Side chips for the four APIs | "Agent API · sets the pincode" · "Search + Fetch · Amazon, Flipkart" · "Browser API · built, not default" · "JSON + screenshot proof" | "TinyFish agents open real apps, set each pincode, and return JSON with screenshot proof." | Steps enter one by one (`ss-step-in`); spinner on current step; screenshot scales up | Soft ticks per step; camera shutter on screenshot |
| 8 | 38–42 s | Expected impact | Telegram message with **Approve** / **Details** buttons, tap Approve, text changes to "Approved ✓". **Recreate** the chat in Telegram style (live bot needs `TELEGRAM_BOT_TOKEN`). Then three impact lines | "Alert distributor: out of stock in 4 South Delhi pincodes" · "Approved ✓" · "Fewer invisible lost sales" · "No needless price wars" · "Proof for distributors" | "Fewer invisible lost sales. No needless price wars." | Message slides up; button press; lines stagger in | Notification blip; success chime on Approve |
| 9 | 42–45 s | Feasibility | Three stat cards. Background: **record** `/dashboard` lightly blurred | "Working today" · "Runs in mock mode, no keys" · "Free tiers" · "Built in 24 h" | "It works today, even in mock mode." | Cards stamp in, staggered | Stamp per card |
| 10 | 45–48 s | Future scope | Four sand stickers (`.sticker`, −4° tilt). **Concept animation** (all Planned) | "Seller APIs" · "More platforms & cities" · "Forecasting" · "Hindi alerts" | "Next: seller APIs, more cities, Hindi alerts." | Stickers pop in with a slight tilt | Light pop per sticker |
| 11 | 48–50 s | End card | Ink `#0D1B2A` background. Closing line, then the logo (linen wordmark), tagline, team line | "Others show the listed price. We show the real one." · "ShelfSense" · "See your market the way shoppers do." · "Team CodeCrunchers · USICT, GGSIPU ·" | "Others show the listed price. We show the real one." | Line fades up; logo tile presses in | Final hit on the logo |

**Timing check:** 4 + 5 + 6 + 5 + 6 + 6 + 6 + 4 + 3 + 3 + 2 = **50 s**.

"Built in 24 h" (scene 9) is the team's own claim. The code cannot confirm it, so the team must confirm it before export.

---

## 5. Full Voiceover Script

Voice: calm, warm, unhurried. Indian English is welcome. About 2.5 words per second.

| Time | Line |
|---|---|
| 0.3 s | Your milk is out of stock. And you'd never know. |
| 4.3 s | Every dark store has its own shelf. Listed prices hide fees. Big-brand tools miss both. |
| 9.3 s | ShelfSense checks every pincode. Nine in stock. Four out in South Delhi. One price gap. |
| 15.3 s | Built for small sellers, new D2C brands, and brand sales teams. |
| 20.3 s | Mother Dairy looks cheaper. Add the fees, and you're two rupees cheaper. AI says: don't cut price. Restock. |
| 26.3 s | Next.js and FastAPI, with Gemini AI, Postgres and a Telegram bot. |
| 32.3 s | TinyFish agents open real apps, set each pincode, and return JSON with screenshot proof. |
| 38.3 s | Fewer invisible lost sales. No needless price wars. |
| 42.3 s | It works today, even in mock mode. |
| 45.3 s | Next: seller APIs, more cities, Hindi alerts. |
| 48.0 s | Others show the listed price. We show the real one. |

**Word count:** 126 words.

**Muted viewing:** the video must make sense with the sound off. The on-screen text in Section 6 carries every key point. The voiceover only adds tone.

---

## 6. On-Screen Text List

In order of appearance. Minimum text size **28 px** at 1080p. Each key line stays on screen for **at least 1.5 s**.

1. Amul Taaza · 500 ml · Out of stock
2. Your shopper just left.
3. Every dark store has its own shelf.
4. Listed price ≠ real price.
5. Tools are built for big brands.
6. Add product → Agents check → Heatmap → AI explains → Approve on Telegram
7. 14 pincodes
8. 9 in stock
9. 4 out of stock
10. 1 price gap
11. 110017 · Malviya Nagar · Out of stock · ₹29 · checked 1h ago
12. Small marketplace sellers
13. New D2C brands on quick commerce
14. Brand and sales teams
15. Listed: Amul ₹29 · Mother Dairy ₹27
16. At checkout: Amul ₹29 · Mother Dairy ₹31 (₹4 fees)
17. You're ₹2 cheaper at checkout.
18. Don't cut price. Restock 4 South Delhi pincodes.
19. Next.js · React · Tailwind
20. FastAPI · Python
21. TinyFish
22. Gemini
23. Postgres / Supabase
24. Telegram bot
25. Agent API · sets the pincode
26. Search + Fetch · Amazon, Flipkart
27. Browser API · built, not default
28. JSON + screenshot proof
29. Alert distributor: out of stock in 4 South Delhi pincodes
30. Approve · Details
31. Approved ✓
32. Fewer invisible lost sales
33. No needless price wars
34. Proof for distributors
35. Working today
36. Runs in mock mode, no keys
37. Free tiers
38. Built in 24 h
39. Seller APIs
40. More platforms & cities
41. Forecasting
42. Hindi alerts
43. Others show the listed price. We show the real one.
44. ShelfSense · INTELLIGENCE
45. See your market the way shoppers do.
46. Team CodeCrunchers · USICT, GGSIPU ·

The flow strip (item 6) is small UI text. Keep it at 28 px or larger, or show each step one at a time.

---

## 7. Sound Design

**Music:** minimal electronic, about 120 BPM, warm synth pad with a soft pluck. Royalty-free only (for example YouTube Audio Library, Pixabay Music, or a licensed Artlist / Epidemic Sound track).

- **0–9 s:** sparse. Pad and a light pulse, leaving room for the thud.
- **9–26 s:** builds. Add a kick and the pluck melody as the heatmap fills and the price flips.
- **26–38 s:** steady groove under the tech and TinyFish scenes.
- **38–45 s:** lifts with the Approve chime.
- **45–50 s:** resolves. Drop to the pad, then one final hit on the logo.

Keep music about 12 dB under the voiceover.

**SFX cue list** (royalty-free, for example Pixabay or Freesound CC0):

| Time | Cue |
|---|---|
| 0.2 s | Soft whoosh (pin enters) |
| 1.0 s | Low thud (out of stock) |
| 4.5 / 5.8 / 7.1 s | Stamp ×3 (problem cards) |
| 9.5–12.0 s | Light pops, staggered (pins) |
| 12.0 / 12.4 / 12.8 / 13.2 s | Stamp ×4 (stat cards) |
| 15.5 / 16.5 / 17.5 s | Light tick ×3 (user cards) |
| 22.5 s | Ding (price flip) |
| 24.0 s | Soft whoosh (recommendation card) |
| 26.5–30.0 s | Short whooshes (architecture links) |
| 33.0–36.0 s | Soft ticks (agent steps) |
| 36.5 s | Camera shutter (screenshot) |
| 38.5 s | Notification blip (Telegram message) |
| 39.5 s | Success chime (Approve) |
| 42.5 / 43.2 / 43.9 s | Stamp ×3 (feasibility cards) |
| 45.5–47.0 s | Light pops ×4 (stickers) |
| 49.0 s | Final hit (logo) |

---

## 8. Recording / Asset List

### Run the app locally in mock mode (no keys needed)

From the repo root (see `README.md` and `backend/README.md`):

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
alembic upgrade head
python -m scripts.seed --with-demo-data   # demo user, Amul product, history
uvicorn app.main:app --reload             # http://127.0.0.1:8000

# Frontend (new terminal)
cd frontend
npm install
cp .env.example .env.local        # set NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                       # http://localhost:3000
```

Leave every key blank so the app stays in mock mode. `GET http://127.0.0.1:8000/api/health` confirms which parts are mocked. Do not open or record any `.env` file.

### Per-scene assets

| Scene | Route / source | Element to crop | State needed | Record or create |
|---|---|---|---|---|
| 1 | none | Pin and label card | none | **Concept animation** in site style (`.ss-pin.out_of_stock`) |
| 2 | `/` (home page problem section) | Problem cards and icons `public/figma/home/probStore.svg`, `probClock.svg`, `probBolt.svg` | none | Recreate cards with these icons |
| 3 | `/products/[id]/heatmap` | `HeatmapMap` map area, pins, hot zone | Amul product from demo seed, Blinkit selected, snapshot "now" | **Record** the map; **overlay** 9 / 4 / 1 / 14 stats and the 110017 tooltip (app shows "Saket" and random seed numbers) |
| 4 | `/products` | Product grid (`ProductGridCard`) as blurred background | Demo seed products | Record background; recreate user cards |
| 5 | `/products/[id]` | AI summary block and `RecommendationCard` | Amul product with a pending recommendation | **Concept animation** for the price flip (Prototype); record recommendation card; overlay Fact Sheet text |
| 6 | none | Architecture boxes | none | **Concept animation** (diagram) |
| 7 | `/agents` (or Run check on `/products/[id]/heatmap`) | `AgentConsole`, `StepTimeline`, `ScreenshotThumb` / `Lightbox` | Start a run in mock mode; steps stream live | **Record** (mock screenshots are simulated SVGs; the `ModeBadge` chip reads "TinyFish · Simulated"; keep it visible) |
| 8 | `/products/[id]/telegram` for the connect screen; Telegram chat | Approve / Details message | Live bot needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`; without them the bot is off | **Recreate** the Telegram chat, using the real message format: "[ShelfSense] Recommendation for … Impact: …" with buttons "Approve" and "Details", then "Approved ✓" |
| 9 | `/dashboard` | Whole page, blurred | Demo seed | Record background; recreate stat cards |
| 10 | none | Stickers | none | **Concept animation** (Planned features) |
| 11 | `frontend/public/figma/shell/logo.svg` | Logo icon | none | Recreate logo tile and wordmark per Section 3 |

**Fonts to install for editing:** Fraunces and Inter (both free on Google Fonts).

**Privacy:** the demo account is the fictional seller "Riya Sharma / Riya Store". Crop out the user menu and any email address. Never show the browser address bar with tokens, terminal windows with environment values, or `.env` files.

### Scenes that need concept animation (feature not in code, or diagram only)

- **Scene 1:** intro pin (stylised, not a real screen).
- **Scene 5:** true checkout price flip (**Prototype**: mock only; the live agent never opens checkout).
- **Scene 6:** architecture diagram (the parts are real; the diagram is a drawing).
- **Scene 8:** Telegram chat, recreated (approval works in code; a live bot needs a token; contacting a distributor is **Planned**).
- **Scene 10:** future scope (all **Planned**).
- **Scene 3 overlays:** Fact Sheet numbers and the "Malviya Nagar" tooltip (the seed data differs).

---

## 9. Delivery Specs

| Item | Spec |
|---|---|
| Main file | `ShelfSense_Video_50s.mp4` |
| Resolution | 1920×1080 |
| Frame rate | 30 fps (constant) |
| Video codec | H.264, High profile, about 12–16 Mbps |
| Audio | AAC, 48 kHz, stereo, 320 kbps |
| Loudness | About −14 LUFS integrated, true peak ≤ −1 dBTP |
| Captions | Optional `ShelfSense_Video_50s.srt` from Section 5 |
| Vertical version (optional) | `ShelfSense_Video_50s_vertical.mp4`, 1080×1920, same specs; stack the heatmap and cards vertically, keep text inside the centre safe area |
| Thumbnail | `ShelfSense_Thumbnail.png`, 1920×1080: frame at about 23 s (price flip showing "You're ₹2 cheaper at checkout.") or the heatmap frame at about 13 s |

---

## 10. Final Checklist

- [ ] Duration is between 48 and 52 seconds.
- [ ] All 9 topics are covered: problem, solution, users, AI, technical approach, TinyFish, impact, feasibility, future scope (scenes 2–10), plus intro and end card.
- [ ] Every number and quote matches the Fact Sheet (Section 2).
- [ ] Concept animations (scenes 1, 5 flip, 6, 8 chat, 10) do not look like recorded screens.
- [ ] No API keys, tokens, `.env` files, terminal output with values, or personal emails are visible.
- [ ] The video makes sense muted; every key line stays on screen 1.5 s or longer at 28 px or larger.
- [ ] Only Holst colours and the Fraunces / Inter fonts are used.
- [ ] "Built in 24 h" confirmed by the team.
- [ ] Spelling checked: "Malviya Nagar", "Mother Dairy", "CodeCrunchers", "USICT", "GGSIPU", "Vaibhav Singla", "Rohan Garg", "Jiya Aggarwal", "Bhavya Bansal".
- [ ] Music and SFX are royalty-free, with licences saved.
- [ ] Loudness is about −14 LUFS; export is MP4 H.264 + AAC.
