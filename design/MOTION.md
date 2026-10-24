# ShelfSense — motion guide (for page implementers)

**Only add motion. Do NOT change design, colours, layout, spacing or copy.** Read
`design/GUIDE.md` too (project structure, do-not-edit list, screenshot tooling).

Installed: `lenis`, `gsap` (+ `gsap/ScrollTrigger`, `@gsap/react` `useGSAP`), `motion` (`motion/react`).
Already done globally (don't redo): Lenis smooth scroll synced to ScrollTrigger
(`components/motion/SmoothScroll.tsx`, `useLenis()` hook gives the instance — `lenis.velocity`),
`<MotionConfig reducedMotion="user">`, page transitions (Slate wipe), `<Toaster>`.

## Hard rules
- Animate only `transform`, `opacity`, `clip-path`. (Sole exception: the shared `press` utility's
  box-shadow on hover/press.) No width/height/top/left/margin animation, no layout shift.
- Respect `prefers-reduced-motion`: Motion components already do via MotionConfig; for GSAP use
  `gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`; CSS animations are globally cut
  to 1ms under reduced motion.
- Pinning, tilt, magnetic and custom cursor: **only** when `FINE_POINTER_QUERY` matches
  (`(min-width: 1024px) and (hover: hover) and (pointer: fine)`) — use `gsap.matchMedia()` with that
  query, or `useFinePointer()` from `lib/motion.ts`.
- `"use client"` only where needed (a page that is a server component should get a small client
  child component for its motion, not become a client page).
- GSAP: use `useGSAP(() => {...}, { scope: ref })` — it reverts tweens and ScrollTriggers on unmount.
  `gsap.registerPlugin(ScrollTrigger, useGSAP)` in each file that uses them.
- No looping animations except the marquee and loaders (spinners, skeleton shimmer, typing dots).
- Keep it light (Lighthouse perf > 90): no heavy per-frame JS, prefer CSS/WAAPI and Motion; use
  `will-change` only while animating.

## Shared building blocks (use these; don't fork them)
- **Press**: Tailwind utility `press` + size `press-2|3|4|6` (= the element's hard-shadow px).
  `.btn`, `.pill`, `.card-lift`, `a.card`, `button.card` already have it. For any other clickable
  element that has its own `shadow-[Npx_Npx_0_var(--ink)]`, **replace** that shadow class with
  `press press-N` (press draws the shadow itself) and remove any custom `active:translate…`/press
  classes. Don't add press to static, non-clickable cards.
- **`<Reveal>`** (`components/motion/Reveal.tsx`): fade + rise 16px, once in view.
  `<Reveal className=…>` reveals itself; `<Reveal stagger className="grid …" itemClassName=…>`
  wraps each child and staggers 60ms (max 8). Use `itemAs`/`as` ("li", "tr", "tbody"…) to keep valid
  markup; for table rows use `<RevealItem as="tr" index={i}>`. The wrapper element replaces nothing
  — keep the same classes on it so layout is identical.
- **`<CountUp value={n} format={fn}>`**: counts up once in view (1.2s), then animates between
  values on change; tabular numbers; reserves the final width. Wrap only the numeric part, keep the
  surrounding element/classes (e.g. `"₹" + n.toFixed(2)` via `format`, or `"5/8"` → CountUp for 5 then
  "/8" as text).
- **`<ActiveIndicator id="…" className="bg-slate rounded-[12px]">`** + **`<IndicatorGroup>`**
  (`components/motion/ActiveIndicator.tsx`): sliding active background/underline via `layoutId`.
  Render it inside the active item only; the item needs `relative`, its label `relative z-[1]`, and
  the active item's own background must then come from the indicator (so remove the static active bg
  on that item, keep its text colour). Wrap each independent group in `<IndicatorGroup>`.
- **Toasts**: `import { toast } from "@/lib/toast"` → `toast("Approved")`, `toast.error(msg)`,
  `toast.info(msg)`. Use for user-triggered results (approve/dismiss/save/send/run start+finish).
- `lib/motion.ts`: `EASE`, `useFinePointer()`, `prefersReducedMotion()`, `FINE_POINTER_QUERY`.
- CSS (globals.css): `.stagger` (CSS list reveal, 60ms, cap 8), `.skeleton` (transform shimmer),
  `.ss-pin` (pin pop-in), `.ss-hotzone` (one-time scale-in), `@keyframes marquee|rise|pin-pop`.
  Don't edit globals.css — put page-specific keyframes in a CSS module next to your file or as inline
  Motion/GSAP animations.

## Verify
Dev server: http://localhost:3000 (already running; don't start another). Check every changed page
at 1440 and at 390 (use a CDP device-emulation screenshot for 390 — see the scratchpad tools from
earlier agents, e.g. `scratchpad/tools/cdp.mjs`), that nothing shifts (no CLS), that reduced motion
disables movement (CDP `Emulation.setEmulatedMedia` prefers-reduced-motion: reduce), and that
`npx tsc --noEmit` + `npx eslint <your files>` are clean. Report files changed and anything you
couldn't do.
