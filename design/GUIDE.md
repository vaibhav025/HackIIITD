# ShelfSense — Figma → code guide (for page implementers)

Figma file key: `hmZN4kFakz0gpc9BP5GIH9` (signed-in account has a Full seat).

| Frame | Node | Route / file |
| --- | --- | --- |
| homepage | `8:943` | `/` → `frontend/src/app/page.tsx` |
| dashboard (DONE, reference) | `8:2724` | `frontend/src/app/(app)/dashboard/page.tsx` |
| product (= Products **list**) | `8:1740` | `frontend/src/app/(app)/products/page.tsx` |
| heatmaps | `3:2` | `frontend/src/app/(app)/heatmap/page.tsx` |
| help centre | `4:336` | `frontend/src/app/(app)/help/page.tsx` |
| settings | `4:579` | `frontend/src/app/(app)/settings/page.tsx` |

Screens with no frame (product overview, product settings, Telegram connection) must be restyled
in the same system, composed from the patterns above.

Reference renders of each frame: `design/<frame>.png`.

## Workflow (do all of it)

1. `get_design_context` for your frame (`skillNames: "figma-design-to-code"`). If it is too large it is
   saved to a file — extract `d[0]['text']` into `design/<frame>.ctx.tsx`, then:
   - `python3 design/tools/condense.py design/<frame>.ctx.tsx > design/<frame>.outline.txt` — a compact,
     faithful outline (node id, layer name, styling classes, text). Read the outline in full.
   - `python3 design/tools/assets.py design/<frame>.ctx.tsx <frame>` — downloads every asset to
     `frontend/public/figma/<frame>/<constName>.svg|png`. Reference them as `/figma/<frame>/<name>.svg`.
     Never leave figma.com asset URLs in code.
   - For a sub-tree, call `get_design_context` on a child node id from the outline.
2. Implement using exact values from the outline (sizes, padding, radii, colors, font sizes/weights,
   letter-spacing, line heights). Translate absolute positioning into flex/grid. Keep it responsive
   (works at 390px with no horizontal page scroll; desktop matches the frame at 1440).
3. Keep **all existing behaviour and API wiring** of the page you replace (read the current file first).
   Every number must come from the API; where the design shows sample data (e.g. "Riya Dairy Mart",
   "Renews 12 Nov", "8 products") render the live equivalent. If the design shows a metric the API
   can't provide, derive it honestly from what exists or drop it — never hardcode fake data — and list it
   in your report.
4. Verify visually: the dev server is already running on http://localhost:3000 (do NOT start another).
   Screenshot with `/private/tmp/claude-501/-Users-jiyaagrawal-Desktop-shelfsense/97bc4848-8c9b-4e30-96f6-8ab59051e6e5/scratchpad/shot.sh <path> <out.png> [w] [h]`
   (write outputs into that scratchpad's `shots/` folder) and compare side by side with `design/<frame>.png`.
   Iterate until it matches. Then run `cd frontend && npx tsc --noEmit && npx eslint <your files>`.

## Do not edit (shared — ask in your report if you need a change)

`src/app/globals.css`, `src/components/ui.tsx`, `src/components/AppShell.tsx`,
`src/components/ProductHeader.tsx`, `src/lib/*`, anything in `backend/`.
Put page-specific components inside your page file or a new file under `src/components/<page>/`.

## Tokens (exact, from Figma)

Ink `#0d1b2a` (`ink`), Deep `#1b263b` (`deep`), Slate `#415a77` (`slate`), Sage `#778d7a` (`sage`),
Sand `#d4c4a8` (`sand`), Linen `#f4f1de` (`linen`). Tailwind: `bg-ink`, `text-slate`, `border-ink`, `bg-linen/20`…
Fonts: Fraunces SemiBold for headings (`h1/h2/h3` default to it; `font-display` class elsewhere),
Inter for everything else (`font-sans` overrides a heading).
Figma `drop-shadow-[Npx_Npx_0px_#0d1b2a]` → use `shadow-[Npx_Npx_0_var(--ink)]` or the classes below.

## Shared classes (globals.css)

- `.card` — linen, 2px ink border, 20px radius, 6px shadow. `.card-lift` hover lift.
- `.btn` (12px radius, 4px shadow, presses down) + `.btn-primary` (slate) `.btn-ink` `.btn-sand` `.btn-sage`
  `.btn-ghost` (linen); `.btn-sm` (14px, 3px shadow).
- `.pill` filter/segment button (`data-active="true"` → slate fill).
- `.input` (linen, 2px ink, 12px radius, focus glow). `.sticker` (sand, −4° tilt, uppercase).
- `.chip`, `.eyebrow` (14px bold uppercase 0.7px tracking), `.label`, `.section-head` (heading row with
  2px ink/20 divider), `.tab`, `.skeleton`, `.stagger` (list reveal), `.dot-typing`.
- Map pins: `.ss-pin.in_stock|out_of_stock|price_gap|stale` (+ `.selected`).

## Shared components

- `ui.tsx`: `StatusDot` (24px sage/check asset, dashed ✕, sand ₹), `PincodeStrip`, `StatTile`
  (coloured 200px tile with 80px Fraunces number), `Meter` (`dark` for ink tiles), `Toggle`
  (slate track when on), `Sticker`, `SectionTitle`, `Skeleton`, `CardSkeleton`, `Empty`, `ErrorCard`,
  `StatusBadge`, `PriorityBadge`, `Sparkline`, `STATUS_META`.
- `ProductHeader.tsx`: product title + Overview/Heatmap/Telegram/Settings tabs + `RecheckButton`.
- `AppShell.tsx`: sidebar + top bar already wrap every `(app)` route — pages render only their content.
- `Map.tsx` (Leaflet, client-only), `WeeklyChart.tsx`, `RecommendationCard.tsx`, `AddProductDialog.tsx`.
- `lib/api.ts` (`api`, `useApi` SWR hook, `mediaUrl`, `API_URL`), `lib/useRun.ts` (start + SSE progress),
  `lib/format.ts`, `lib/types.ts`.
- Shell icons in `/figma/shell/`: logo, nav-*, search, bell, plus-circle, pin-in-stock, check, refresh,
  alert-store, alert-trend-down, alert-box, alert-bot.

Backend runs on :8000 in mock mode. A seeded product id for testing is in
`/private/tmp/claude-501/-Users-jiyaagrawal-Desktop-shelfsense/97bc4848-8c9b-4e30-96f6-8ab59051e6e5/scratchpad/pid`.
API docs: http://localhost:8000/docs (or `backend/app/api/*.py`).
