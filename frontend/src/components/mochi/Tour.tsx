"use client";

import { animate } from "motion";
import { usePathname, useRouter } from "next/navigation";
import { onMochi } from "@/lib/mochi-bus";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { confetti } from "./confetti";
import Dialogue, { useTypewriter } from "./Dialogue";
import type { Expression } from "./expressions";
import MochiFace, { MochiPortrait } from "./MochiFace";
import { CHAPTER_NAMES, CHAPTERS, FINALE_CHOICES, TOUR_LINES, type Chapter, type TourCtx, type TourStep } from "./script";
import { clamp, foreignModal, obstacles, overlap, topInset, usable, usePrefs, waitFor } from "./store";

/**
 * Guided tour runner (also used for "What's on this page?"): walks to each step's route, waits for
 * its target, scrolls it into view, cuts a spotlight hole around it, and flies Mochi beside it.
 * Everything positional is an inline style.
 */

export type TourExit = "done" | "skip" | "pause" | "detour";

export interface TourProps {
  kind: "tour" | "pagetour";
  steps: TourStep[];
  startIndex: number;
  initialCtx: TourCtx;
  reduced: boolean;
  mobile: boolean;
  voice: boolean;
  onExit: (reason: TourExit, ctx: TourCtx, stepId: string | null) => void;
  /** Persist progress on each shown step. */
  onProgress?: (stepId: string, ctx: TourCtx) => void;
  /** Chapters passed over before the tour started (e.g. the landing chapter when starting in the app). */
  skippedChapters?: Chapter[];
}

type Phase = "seeking" | "walking" | "show";
type Hole = { l: number; t: number; w: number; h: number; r: number } | null;
type Line = { text: string; mood: Expression };

const SPOT_Z = 1900;
const STAGE_Z = 1950;
const DIM = "rgba(13,27,42,.62)";
const MOVE = "cubic-bezier(.77,0,.175,1)";
/** Phones: Mochi perches on the sheet's top edge, just right of the "Mochi" name plate. */
const MOBILE_PERCH_X = 104;

function selectorsOf(step: TourStep): string[] {
  if (!step.target) return [];
  return Array.isArray(step.target) ? step.target : [step.target];
}

function settle(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let last = window.scrollY;
    let still = 0;
    const start = performance.now();
    const tick = () => {
      const y = window.scrollY;
      still = Math.abs(y - last) < 0.5 ? still + 1 : 0;
      last = y;
      if (still >= 4 || performance.now() - start > maxMs) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function scrollToTarget(el: HTMLElement, mobile: boolean, reduced: boolean) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  const top = topInset();
  if (mobile) {
    // Aim for the upper 55% of the screen, above the bottom sheet.
    const room = vh * 0.55 - top - 16;
    const y = r.height > room ? r.top + window.scrollY - top - 16 : r.top + window.scrollY - top - 16 - Math.max(0, (room - r.height) / 2);
    window.scrollTo({ top: Math.max(0, y), behavior });
  } else if (r.height > vh * 0.6) {
    window.scrollTo({ top: Math.max(0, r.top + window.scrollY - top - 16), behavior });
  } else {
    el.scrollIntoView({ block: "center", behavior });
  }
}

/** Lowest visible edge for a spotlit target: phones keep the target above the bottom sheet. */
const viewLimit = (mobile: boolean) => (mobile ? window.innerHeight * 0.6 : window.innerHeight);

/**
 * Is the target where scrollToTarget would put it? Short targets: fully inside the free band.
 * Tall ones (taller than the band): their top edge shows just under the top bar.
 */
function inView(el: HTMLElement, mobile: boolean) {
  const r = el.getBoundingClientRect();
  const top = topInset();
  const limit = viewLimit(mobile);
  const room = limit - top;
  if (r.height <= room - 16) return r.top >= top - 4 && r.bottom <= limit + 4;
  return r.top >= top - 4 && r.top <= top + room * 0.35;
}

/** At the end of the page there may be no more room to scroll: nothing more to do then. */
function canScrollTo(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return r.top < topInset() ? window.scrollY > 0 : window.scrollY < max - 1;
}

export default function Tour({ kind, steps, startIndex, initialCtx, reduced, mobile, voice, onExit, onProgress, skippedChapters }: TourProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [index, setIndex] = useState(startIndex);
  const [ctx, setCtx] = useState<TourCtx>(initialCtx);
  const [phase, setPhase] = useState<Phase>("seeking");
  const [slow, setSlow] = useState(false);
  const [override, setOverride] = useState<Line | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [hole, setHole] = useState<Hole>(null);
  const [modal, setModal] = useState(false);
  const [flying, setFlying] = useState(false);
  const [pointAngle, setPointAngle] = useState<number | null>(null);
  const [hop, setHop] = useState(0);
  const [boxH, setBoxH] = useState(170);
  const [retry, setRetry] = useState(0);
  const [skipped, setSkipped] = useState<Chapter[]>(() => skippedChapters ?? []);

  const step = steps[index];
  const finale = !!step.finale;
  const dir = useRef<1 | -1>(1);
  const pushed = useRef<string | null>(null);
  const lastPath = useRef(pathname);
  const misses = useRef<{ chapter: string; n: number }>({ chapter: "", n: 0 });
  const dimSaid = useRef(-1);
  const exited = useRef(false);
  /** Set when a route change already moved the tour along, so the step runner skips its stale-index pass. */
  const advanced = useRef(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mochiRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const mochiAt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const live = useRef({ ctx, index });
  live.current = { ctx, index };

  const exit = useCallback(
    (reason: TourExit) => {
      if (exited.current) return;
      exited.current = true;
      onExit(reason, live.current.ctx, steps[live.current.index]?.id ?? null);
    },
    [onExit, steps],
  );

  const go = useCallback(
    (to: number, d: 1 | -1 = 1) => {
      if (to >= steps.length) return exit("done");
      if (to < 0) return;
      dir.current = d;
      setOverride(null);
      setIndex(to);
    },
    [steps.length, exit],
  );

  const skipChapter = useCallback(
    (from: number) => {
      const ch = steps[from].chapter;
      setSkipped((list) => (list.includes(ch) ? list : [...list, ch]));
      let i = from + 1;
      while (i < steps.length && steps[i].chapter === ch) i++;
      go(i, 1);
    },
    [steps, go],
  );

  /* ------------------------------------------------ route-change interrupts */
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (pushed.current) {
      pushed.current = null;
      return;
    }
    if (kind === "pagetour") return exit("detour");
    const cur = steps[live.current.index];
    if (cur.route.test(pathname)) return;
    // Clicking the spotlighted link (e.g. "Products" in the sidebar) just moves the tour along.
    const nxt = steps[live.current.index + 1];
    if (nxt && nxt.route.test(pathname)) {
      advanced.current = true;
      return go(live.current.index + 1, 1);
    }
    exit("detour");
  }, [pathname, kind, steps, exit, go]);

  /* ------------------------------------------------------- app dialogs */
  useEffect(() => {
    let was = !!foreignModal();
    setModal(was);
    const mo = new MutationObserver(() => {
      const now = !!foreignModal();
      if (now === was) return;
      was = now;
      setModal(now);
      if (!now) {
        setOverride({ text: TOUR_LINES.modalBack, mood: "happy" });
        setRetry((r) => r + 1);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "role"] });
    return () => mo.disconnect();
  }, []);

  /* --------------------------------------------------------- step runner */
  useEffect(() => {
    if (advanced.current) {
      // Same commit as the route effect's go(): this pass still sees the old index. The next one won't.
      advanced.current = false;
      return;
    }
    if (modal) return;
    const token = { cancelled: false };
    let slowT = 0;
    setSlow(false);
    setTarget(null);
    setPointAngle(null);
    setPhase("seeking");

    if (mobile && step.desktopOnly) {
      go(index + dir.current, dir.current);
      return;
    }
    if (kind === "tour" && !step.route.test(pathname)) {
      const href = typeof step.href === "function" ? step.href(live.current.ctx) : step.href;
      if (!href) {
        skipChapter(index);
        return;
      }
      setPhase("walking");
      pushed.current = href;
      router.push(href);
      return;
    }
    if (finale || !selectorsOf(step).length) {
      setPhase("show");
      return;
    }
    slowT = window.setTimeout(() => !token.cancelled && setSlow(true), 350);
    (async () => {
      const el = await waitFor(selectorsOf(step), 8000, token);
      if (token.cancelled) return;
      window.clearTimeout(slowT);
      setSlow(false);
      if (!el) {
        const m = misses.current;
        m.n = m.chapter === step.chapter ? m.n + 1 : 1;
        m.chapter = step.chapter;
        if (m.n >= 2) {
          setPhase("show");
          setOverride({ text: TOUR_LINES.missing, mood: "worried" });
          window.setTimeout(() => !token.cancelled && go(index + dir.current, dir.current), 1800);
        } else {
          go(index + dir.current, dir.current);
        }
        return;
      }
      misses.current = { chapter: step.chapter, n: 0 };
      scrollToTarget(el, mobile, reduced);
      await settle(reduced ? 120 : 900);
      // Content loading above the target (skeletons filling in) can push it away mid-scroll: re-aim.
      for (let i = 0; i < 3 && !token.cancelled && el.isConnected && !inView(el, mobile) && canScrollTo(el); i++) {
        scrollToTarget(el, mobile, true);
        await settle(250);
      }
      if (token.cancelled) return;
      setTarget(el);
      setPhase("show");
    })();
    return () => {
      token.cancelled = true;
      window.clearTimeout(slowT);
    };
    // pathname: re-run once our navigation lands. retry: re-spotlight after an app dialog closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, pathname, modal, retry]);

  // Persist progress for resume.
  useEffect(() => {
    if (phase === "show" && kind === "tour") onProgress?.(step.id, ctx);
  }, [phase, kind, step.id, ctx, onProgress]);

  // Finale: confetti burst from centre stage.
  useEffect(() => {
    if (phase !== "show" || !finale) return;
    const r = mochiRef.current?.getBoundingClientRect();
    if (r) confetti(r.left + r.width / 2, r.top + r.height * 0.4, STAGE_Z + 1);
  }, [phase, finale]);

  /* ------------------------------------------- reactions (the happy dance) */
  useEffect(() => {
    let last = 0;
    const dance = () => {
      if (Date.now() - last < 1500) return;
      last = Date.now();
      setOverride({ text: TOUR_LINES.dance[Math.floor(Math.random() * TOUR_LINES.dance.length)], mood: "love" });
      setHop((h) => h + 1);
      const r = mochiRef.current?.getBoundingClientRect();
      if (r) confetti(r.left + r.width / 2, r.top + r.height * 0.3, STAGE_Z + 1);
    };
    const offs = [
      onMochi("rec", (e) => {
        if (e.verb === "approve" || e.verb === "done" || e.verb === "send-telegram") dance();
      }),
      onMochi("toast", (e) => {
        if (e.tone === "success") dance();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  /* ------------------------------------------------ phones: room to scroll */
  // The bottom sheet covers the lower part of the screen: give the page that much extra scroll so
  // targets at the very end can still rise above it.
  useEffect(() => {
    if (!mobile) return;
    const body = document.body;
    const prev = body.style.paddingBottom;
    body.style.paddingBottom = `${boxH}px`;
    return () => {
      body.style.paddingBottom = prev;
    };
  }, [mobile, boxH]);

  /* ---------------------------------------------------- spotlight loop */
  useEffect(() => {
    const spot = spotRef.current;
    if (!spot) return;
    const pad = step.pad ?? 8;
    let point: HTMLElement | null = null;
    if (step.point && target) {
      try {
        const p = document.querySelector(step.point);
        point = usable(p) ? p : null;
      } catch {
        point = null;
      }
    }
    // Ease the hole between steps, then follow the target 1:1.
    spot.style.transition = reduced ? "opacity 150ms ease-out" : `transform 260ms ${MOVE}, width 260ms ${MOVE}, height 260ms ${MOVE}, border-radius 260ms ${MOVE}`;
    const stopEase = window.setTimeout(() => {
      spot.style.transition = "none";
    }, 300);
    const radius = target ? (parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0) + pad : 0;
    let raf = 0;
    let lastHole = "";
    // Layout-shift guard: if the target's place in the page moves (data loading above it) during
    // the first seconds of a step, scroll it back into view. The user's own scrolling never moves
    // it in the page, so this never fights them.
    const since = performance.now();
    let docTop: number | null = null;
    let lastFix = 0;
    let bar = topInset();
    let barAt = since;
    const place = (l: number, t: number, w: number, h: number) => {
      spot.style.transform = `translate3d(${l}px, ${t}px, 0)`;
      spot.style.width = `${w}px`;
      spot.style.height = `${h}px`;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const b = blockRefs.current;
      const set = (el: HTMLDivElement | null, x: number, y: number, bw: number, bh: number) => {
        if (!el) return;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        el.style.width = `${Math.max(0, bw)}px`;
        el.style.height = `${Math.max(0, bh)}px`;
      };
      const top = Math.max(0, t);
      const bottom = Math.min(vh, t + h);
      set(b[0], 0, 0, vw, top);
      set(b[1], 0, bottom, vw, vh - bottom);
      set(b[2], 0, top, Math.max(0, l), bottom - top);
      set(b[3], l + w, top, vw - l - w, bottom - top);
    };
    const tick = () => {
      raf = 0;
      if (target && target.isConnected) {
        const now = performance.now();
        if (now - barAt > 500) {
          bar = topInset();
          barAt = now;
        }
        const r = target.getBoundingClientRect();
        const dt = r.top + window.scrollY;
        if (docTop === null) docTop = dt;
        else if (Math.abs(dt - docTop) > 16) {
          docTop = dt;
          if (now - since < 6000 && now - lastFix > 400 && !inView(target, mobile)) {
            lastFix = now;
            scrollToTarget(target, mobile, reduced);
          }
        }
        // Clamp the hole to the visible part of the target (very tall targets run off the screen).
        const vh = window.innerHeight;
        const l = r.left - pad;
        const t = clamp(r.top - pad, bar, vh);
        const w = r.width + pad * 2;
        const h = Math.max(0, Math.min(r.bottom + pad, vh) - t);
        place(l, t, w, h);
        const key = `${Math.round(l / 8)}:${Math.round(t / 8)}:${Math.round(w / 8)}:${Math.round(h / 8)}`;
        if (key !== lastHole) {
          lastHole = key;
          setHole({ l, t, w, h, r: radius });
        }
        if (point && ringRef.current) {
          const pr = point.getBoundingClientRect();
          ringRef.current.style.transform = `translate3d(${pr.left - 5}px, ${pr.top - 5}px, 0)`;
          ringRef.current.style.width = `${pr.width + 10}px`;
          ringRef.current.style.height = `${pr.height + 10}px`;
        }
      } else {
        const vw = document.documentElement.clientWidth;
        place(vw / 2, window.innerHeight / 2, 0, 0);
        if (lastHole !== "none") {
          lastHole = "none";
          setHole(null);
        }
      }
      if (document.visibilityState === "visible") raf = requestAnimationFrame(tick);
    };
    spot.style.borderRadius = `${radius}px`;
    spot.style.outline = target ? "3px solid #D4C4A8" : "none";
    if (ringRef.current) ringRef.current.style.display = point ? "block" : "none";
    tick();
    const onVis = () => {
      if (document.visibilityState === "visible" && !raf) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(stopEase);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [target, step, reduced, modal, mobile]);

  /* -------------------------------------------------------- dialogue box */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const sync = () => setBoxH(el.offsetHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [modal]);

  const [vh, setVh] = useState(() => window.innerHeight);
  const [vw, setVw] = useState(() => document.documentElement.clientWidth);
  useEffect(() => {
    const onResize = () => {
      setVh(window.innerHeight);
      setVw(document.documentElement.clientWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Rotation / resize mid-step (e.g. desktop to phone): bring the target back above the new layout.
  const layoutKey = `${mobile}:${Math.round(vh / 40)}`;
  const lastLayout = useRef(layoutKey);
  useEffect(() => {
    if (lastLayout.current === layoutKey) return;
    lastLayout.current = layoutKey;
    if (phase === "show" && target?.isConnected) scrollToTarget(target, mobile, reduced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Tall targets: put the box at whichever end covers fewer controls inside the spotlight.
  const [tallTop, setTallTop] = useState(false);
  const tallKey = hole ? [hole.l, hole.t, hole.w, hole.h].map((v) => Math.round(v / 48)).join(":") : "none";
  useEffect(() => {
    if (mobile || !hole) return setTallTop(false);
    const t = Math.max(hole.t, topInset());
    const b = Math.min(hole.t + hole.h, vh);
    if (b - t < vh * 0.6) return setTallTop(false);
    const boxes = obstacles().filter((o) => o.l < hole.l + hole.w && o.r > hole.l && o.t < b && o.b > t);
    const w = Math.min(560, vw - 32);
    const l = (vw - w) / 2;
    const topBand = topInset() + 16;
    const atTop = overlap(boxes, l, topBand, l + w, topBand + boxH);
    const atBottom = overlap(boxes, l, vh - 24 - boxH, l + w, vh - 24);
    setTallTop(atTop < atBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tallKey, mobile, vh, vw, boxH]);
  const boxAtTop = !mobile && !!hole && (tallTop || (hole.t + hole.h > vh - boxH - 48 && hole.t > topInset() + boxH + 40));

  /* ------------------------------------------------------ Mochi placement */
  const S = finale ? 120 : mobile ? 64 : 88;
  const center = (h: NonNullable<Hole>) => {
    const t = Math.max(h.t, topInset());
    const b = Math.min(h.t + h.h, vh);
    return { x: h.l + h.w / 2, y: (t + Math.max(t, b)) / 2 };
  };

  // Coarse hole key: Mochi re-flies only when the target moved noticeably (not on every scroll pixel).
  const holeKey = hole ? [hole.l, hole.t, hole.w, hole.h].map((v) => Math.round(v / 48)).join(":") : "none";

  const boxStep = Math.round(boxH / 24);

  // Initial spot: where the intro flight lands.
  useLayoutEffect(() => {
    if (mobile) return;
    const x = vw - 88 - 32;
    const y = vh * 0.38;
    mochiAt.current = { x, y };
    if (mochiRef.current) mochiRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile]);

  useEffect(() => {
    const el = mochiRef.current;
    if (!el || mobile || phase !== "show" || modal) return;
    const box = boxRef.current?.getBoundingClientRect();
    const top = topInset();
    let dest: { x: number; y: number };
    if (finale) {
      dest = { x: vw / 2 - S / 2, y: Math.max(top + 16, (box ? box.top : vh) - S - 24) };
    } else if (hole) {
      const vis = { l: hole.l, t: Math.max(hole.t, top), r: hole.l + hole.w, b: Math.min(hole.t + hole.h, vh) };
      const cy = (vis.t + Math.max(vis.t, vis.b)) / 2;
      const slots = [
        { x: vis.r + 12, y: cy - S / 2 },
        { x: vis.l - 12 - S, y: cy - S / 2 },
        { x: vis.l, y: vis.b + 12 },
        { x: vis.l, y: vis.t - 12 - S },
      ];
      const inside = (s: { x: number; y: number }) => s.x >= 8 && s.y >= top + 8 && s.x + S <= vw - 8 && s.y + S <= vh - 8;
      const hits = (s: { x: number; y: number }, r: { l: number; t: number; r: number; b: number }) =>
        s.x < r.r && s.x + S > r.l && s.y < r.b && s.y + S > r.t;
      const boxR = box ? { l: box.left, t: box.top - 20, r: box.right, b: box.bottom } : null;
      const ok = slots.find((s) => inside(s) && !hits(s, vis) && !(boxR && hits(s, boxR)));
      // No free slot (huge target): perch on the dialogue box's top edge, clear of the name plate.
      dest = ok ?? (box ? { x: box.right - S - 28, y: boxAtTop ? box.bottom - 14 : box.top - S + 14 } : { x: vw - S - 24, y: vh / 2 });
    } else {
      return;
    }
    dest = { x: clamp(dest.x, 8, vw - S - 8), y: clamp(dest.y, top + 4, vh - S - 4) };
    const from = mochiAt.current;
    mochiAt.current = dest;
    const aim = hole ? center(hole) : null;
    const angle = aim ? (Math.atan2(aim.y - (dest.y + S * 0.6), aim.x - (dest.x + S / 2)) * 180) / Math.PI : null;
    const to = `translate3d(${dest.x}px, ${dest.y}px, 0)`;
    if (reduced || (Math.abs(from.x - dest.x) < 2 && Math.abs(from.y - dest.y) < 2)) {
      el.style.transform = to;
      setPointAngle(angle);
      return;
    }
    setFlying(true);
    setPointAngle(null);
    const tilt = tiltRef.current;
    tilt?.animate([{ transform: "rotate(0deg)" }, { transform: `rotate(${dest.x > from.x ? 8 : -8}deg)` }, { transform: "rotate(0deg)" }], {
      duration: 650,
      easing: "ease-in-out",
    });
    const controls = animate(el, { transform: [`translate3d(${from.x}px, ${from.y}px, 0)`, to] }, { type: "spring", duration: 0.7, bounce: 0.25 });
    let live = true;
    controls.then(() => {
      if (!live) return;
      setFlying(false);
      setPointAngle(angle);
      tilt?.animate([{ transform: "scale(1.08,.88)" }, { transform: "scale(.97,1.04)" }, { transform: "scale(1)" }], { duration: 220, easing: "cubic-bezier(.23,1,.32,1)" });
    });
    return () => {
      live = false;
      setFlying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, holeKey, finale, boxAtTop, modal, mobile, vw, vh, boxStep]);

  // Phones: Mochi perches on the sheet and only turns its arm toward the target.
  useEffect(() => {
    if (!mobile) return;
    if (!hole) return setPointAngle(null);
    const c = center(hole);
    const mx = MOBILE_PERCH_X + S / 2;
    const my = vh - boxH - S / 2;
    setPointAngle((Math.atan2(c.y - my, c.x - mx) * 180) / Math.PI);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, hole?.l, hole?.t, hole?.w, hole?.h, boxH, vh]);

  /* ---------------------------------------------------------------- copy */
  // Copy may depend on the layout (e.g. "on the left" vs "below"): give it the live breakpoint.
  const stepText = typeof step.text === "function" ? step.text({ ...ctx, mobile }) : step.text;
  const line: Line =
    override ??
    (phase === "walking" || (phase === "seeking" && slow)
      ? { text: note ?? TOUR_LINES.walking, mood: "thinking" }
      : { text: stepText, mood: step.mood ?? "idle" });
  const speech = usePrefs().speech;
  const tw = useTypewriter(line.text, `${index}`, { reduced, voice, paused: modal, speak: { on: speech, mood: line.mood } });
  const expression: Expression = flying && !override ? "happy" : line.mood;

  // Short-lived lines go back to the step text (once Mochi has finished saying them).
  useEffect(() => {
    if (!override || override.text === TOUR_LINES.missing || tw.speaking) return;
    const t = window.setTimeout(() => setOverride(null), 1800);
    return () => window.clearTimeout(t);
  }, [override, tw.speaking]);
  useEffect(() => {
    if (phase !== "show") return;
    setNote(null);
    // Keyboard flow: land on Next once it is enabled (unless the user has focused something else in the box).
    const box = boxRef.current;
    const a = document.activeElement;
    if (box && (a === box || a === document.body || a?.hasAttribute("data-m2-focus") || !box.contains(a))) {
      requestAnimationFrame(() => box.querySelector<HTMLElement>('[data-m2-primary]:not([aria-disabled="true"])')?.focus({ preventScroll: true }));
    }
  }, [phase, index]);

  const next = () => {
    if (phase !== "show" && !finale) return;
    if (step.onNext) {
      const r = step.onNext(ctx);
      if (r === "skip-chapter") {
        setNote(TOUR_LINES.noProducts);
        setCtx((c) => ({ ...c, productId: null }));
        live.current.ctx = { ...ctx, productId: null };
      } else if (r) {
        const nextCtx = { ...ctx, ...r };
        setCtx(nextCtx);
        live.current.ctx = nextCtx;
      }
    }
    go(index + 1, 1);
  };
  const back = index > 0 ? () => go(index - 1, -1) : undefined;

  const onDimClick = () => {
    setHop((h) => h + 1);
    if (dimSaid.current === index) return;
    dimSaid.current = index;
    setOverride({ text: TOUR_LINES.dimClick, mood: "surprised" });
  };

  /* ------------------------------------------------------------- footer */
  const visibleSteps = steps.filter((s) => !(mobile && s.desktopOnly));
  const overall = Math.max(1, visibleSteps.indexOf(step) + 1);
  const chapterSteps = visibleSteps.filter((s) => s.chapter === step.chapter);
  const inChapter = Math.max(1, chapterSteps.indexOf(step) + 1);
  const chapterIdx = CHAPTERS.indexOf(step.chapter);
  const pipState = (c: Chapter, i: number) => (i === chapterIdx ? "current" : i < chapterIdx ? (skipped.includes(c) ? "skipped" : "done") : undefined);

  const footer = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 14 }}>
      {kind === "tour" ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: 6 }}
          aria-label={`${CHAPTER_NAMES[step.chapter]}, step ${inChapter} of ${chapterSteps.length}. Overall step ${overall} of ${visibleSteps.length}.`}
          role="img"
        >
          {CHAPTERS.map((c, i) => (
            <span key={c} className="m2-pip" data-state={pipState(c, i)} />
          ))}
          <span style={{ fontSize: 13, color: "#415A77", marginLeft: 6 }} aria-hidden="true">
            {CHAPTER_NAMES[step.chapter]} · {inChapter}/{chapterSteps.length}
          </span>
        </div>
      ) : (
        <span style={{ fontSize: 13, color: "#415A77" }} aria-label={`Tip ${overall} of ${visibleSteps.length}`}>
          {overall} / {visibleSteps.length}
        </span>
      )}
      {!finale && (
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={back} disabled={!back}>
            Back
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => exit("skip")}>
            {kind === "tour" ? "Skip tour" : "Close"}
          </button>
          {/* aria-disabled (not disabled), so focus stays on the button while the next step loads. */}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-m2-primary=""
            onClick={next}
            aria-disabled={phase !== "show"}
            style={phase !== "show" ? { opacity: 0.5, cursor: "wait" } : undefined}
          >
            {index === steps.length - 1 ? "Done" : step.nextLabel ?? "Next →"}
          </button>
        </div>
      )}
    </div>
  );

  const place: CSSProperties = mobile
    ? { left: 0, right: 0, bottom: 0, transition: "opacity 150ms ease-out" }
    : {
        left: 0,
        right: 0,
        marginLeft: "auto",
        marginRight: "auto",
        width: "min(560px, calc(100vw - 32px))",
        ...(boxAtTop ? { top: topInset() + 16 } : { bottom: 24 }),
      };

  const mochiStyle: CSSProperties = mobile
    ? { position: "fixed", left: MOBILE_PERCH_X, bottom: boxH - 14, width: S, height: S, zIndex: STAGE_Z + 1, pointerEvents: "none", transform: "none" }
    : { position: "fixed", left: 0, top: 0, width: S, height: S, zIndex: STAGE_Z + 1, pointerEvents: "none", willChange: "transform" };

  const blocker: CSSProperties = { position: "fixed", left: 0, top: 0, width: 0, height: 0, pointerEvents: "auto", background: "transparent" };

  return (
    <div className="m2" data-m2="tour" style={{ position: "fixed", inset: 0, zIndex: SPOT_Z, pointerEvents: "none" }}>
      {/* Spotlight: one div whose huge shadow dims everything but the hole. */}
      <div
        ref={spotRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          zIndex: SPOT_Z,
          pointerEvents: "none",
          boxShadow: `0 0 0 200vmax ${DIM}`,
          outlineOffset: 0,
          opacity: modal ? 0 : 1,
          willChange: "transform",
        }}
      />
      <div
        ref={ringRef}
        aria-hidden="true"
        style={{ position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: SPOT_Z, pointerEvents: "none", display: "none", borderRadius: 12, outline: "3px dashed #FAC775", outlineOffset: 0 }}
      />
      {/* Click blockers around the hole; the hole itself lets clicks through to the real element. */}
      {!modal &&
        [0, 1, 2, 3].map((i) => (
          <div
            key={i}
            ref={(el) => {
              blockRefs.current[i] = el;
            }}
            aria-hidden="true"
            style={{ ...blocker, zIndex: SPOT_Z }}
            onClick={onDimClick}
          />
        ))}

      {!modal && (
        <Dialogue
          boxRef={boxRef}
          mobile={mobile}
          text={line.text}
          tw={tw}
          active={!modal}
          onAdvance={finale ? () => undefined : next}
          onEscape={() => exit("pause")}
          onBack={back}
          choices={finale && phase === "show" ? FINALE_CHOICES.map((c) => ({ id: c.id, label: c.label })) : undefined}
          onChoose={(id) => {
            if (id === "finish") exit("done");
            else go(0, 1);
          }}
          portrait={<MochiPortrait expression={expression} talk={tw.frame} mobile={mobile} />}
          footer={footer}
          className={reduced ? "m2-fade-in" : "m2-sheet-in"}
          maxHeight={mobile ? "calc(42vh - 60px)" : undefined}
          textSize={mobile ? 15 : 16}
          place={place}
        />
      )}

      {modal && (
        <div
          className="m2-box m2-pop-in"
          role="status"
          style={{
            position: "fixed",
            right: 24,
            bottom: 24 + 88 + 8,
            zIndex: STAGE_Z,
            pointerEvents: "none",
            borderRadius: 16,
            padding: "10px 14px",
            boxShadow: "4px 4px 0 #0D1B2A",
            fontSize: 15,
            lineHeight: "22px",
          }}
        >
          {TOUR_LINES.modalWait}
        </div>
      )}

      <div
        ref={mochiRef}
        aria-hidden="true"
        style={
          modal
            ? { position: "fixed", right: 24, bottom: 24, left: "auto", top: "auto", width: 88, height: 88, zIndex: STAGE_Z, pointerEvents: "none", transform: "none" }
            : mochiStyle
        }
      >
        <div ref={tiltRef} style={{ width: "100%", height: "100%", transformOrigin: "50% 90%" }}>
          <MochiFace expression={modal ? "idle" : expression} talk={tw.frame} size={modal ? 88 : S} pointAngle={pointAngle} hop={hop} track={!flying} />
        </div>
      </div>
    </div>
  );
}
