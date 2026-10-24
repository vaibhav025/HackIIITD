"use client";

import "./mochi.css";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import Companion from "./Companion";
import type { Expression } from "./expressions";
import Intro, { type IntroResult } from "./Intro";
import { MOCHI_TIPS, type MochiCtx } from "./messages";
import { INTRO_OUTRO, MENU, routeKey, TOUR, TOUR_APP_START, TOUR_LINES, type Chapter, type TourCtx, type TourStep } from "./script";
import { foreignModal, getPrefs, MOBILE_QUERY, REDUCED_QUERY, sessionSet, SESSION_KEY, setPrefs, useMedia, usePrefs } from "./store";
import Tour, { type TourExit } from "./Tour";
import type { SayInput } from "./useMochiEvents";

/**
 * Mochi v2: ShelfSense's game-style guide. A first-visit intro (dialogue box + big Mochi), a guided
 * tour with a spotlight across the app, and a docked companion that reacts to what happens.
 * Copy lives in ./script.ts (intro, tour, reactions) and ./messages.ts (per-page tips).
 *
 * Every positioning-critical style is inline; ./mochi.css is cosmetic only.
 */

type Mode = "boot" | "intro" | "tour" | "pagetour" | "companion";
type Run = { kind: "tour" | "pagetour"; steps: TourStep[]; start: number; ctx: TourCtx; key: number; skipped?: Chapter[] };
type Entry = (SayInput & { mood?: Expression }) | null;

const noopSubscribe = () => () => {};
const MOODS: Expression[] = ["happy", "curious", "excited", "wink"];

/** After the intro or a tour closes, don't leave keyboard focus on <body>. Two frames: the companion
 * (the fallback target, e.g. on the landing page, which has no #main) mounts first. */
function refocus() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      (document.getElementById("main") ?? document.getElementById("m2-companion-btn"))?.focus({ preventScroll: true });
    }),
  );
}

function editable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export default function Mochi() {
  // Client-only: nothing renders on the server or during hydration.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return mounted ? <MochiRoot /> : null;
}

function MochiRoot() {
  const pathname = usePathname();
  const { cache } = useSWRConfig();
  const prefs = usePrefs();
  const mobile = useMedia(MOBILE_QUERY);
  const reduced = useMedia(REDUCED_QUERY);

  const [mode, setMode] = useState<Mode>("boot");
  const [run, setRun] = useState<Run | null>(null);
  const [entry, setEntry] = useState<Entry>(null);
  const [menuSignal, setMenuSignal] = useState(0);
  const [loginOpen, setLoginOpen] = useState(false);
  const onLogin = pathname === "/login";

  /* ---------------------------------------------------------------- boot */
  useEffect(() => {
    if (mode !== "boot" && mode !== "companion") return;
    if (prefs.intro !== "pending" || onLogin) {
      if (mode === "boot") setMode("companion");
      return;
    }
    // First visit: the intro starts 1.2s after mount, once the tab is visible and no app dialog is open.
    let t = 0;
    const tryStart = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", tryStart);
      t = window.setTimeout(() => {
        if (foreignModal()) {
          if (mode === "boot") setMode("companion");
          return;
        }
        setEntry(null);
        setMode("intro");
      }, 1200);
    };
    tryStart();
    if (document.visibilityState !== "visible") document.addEventListener("visibilitychange", tryStart);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", tryStart);
    };
  }, [mode, prefs.intro, onLogin]);

  /* ---------------------------------------------------------------- tour */
  const tourIndex = prefs.tour.stepId ? TOUR.findIndex((s) => s.id === prefs.tour.stepId) : -1;
  const resumable = (prefs.tour.status === "active" || prefs.tour.status === "paused") && tourIndex >= 0;

  const startTour = useCallback(
    (fresh = false) => {
      const p = getPrefs();
      const idx = p.tour.stepId ? TOUR.findIndex((s) => s.id === p.tour.stepId) : -1;
      const resume = !fresh && (p.tour.status === "active" || p.tour.status === "paused") && idx >= 0;
      const start = resume ? idx : window.location.pathname === "/" ? 0 : Math.max(0, TOUR.findIndex((s) => s.id === TOUR_APP_START));
      const productId = resume ? p.tour.productId : null;
      setPrefs({ tour: { status: "active", stepId: TOUR[start].id, productId } });
      setEntry(null);
      // A fresh tour started inside the app passes over the landing chapter(s): show those pips as skipped.
      const skipped = resume ? [] : Array.from(new Set(TOUR.slice(0, start).map((s) => s.chapter)));
      setRun({ kind: "tour", steps: TOUR, start, ctx: { productId, name: p.name, mobile: window.matchMedia(MOBILE_QUERY).matches }, key: Date.now(), skipped });
      setMode("tour");
    },
    [],
  );

  const startPageTour = useCallback(() => {
    const ctx: MochiCtx = {
      pathname,
      productId: pathname.match(/^\/products\/([^/]+)/)?.[1],
      data: <T,>(key: string) => cache.get(key)?.data as T | undefined,
    };
    const steps: TourStep[] = [];
    MOCHI_TIPS.filter((t) => t.route.test(pathname) && t.section).forEach((t) => {
      const text = typeof t.text === "function" ? t.text(ctx) : t.text;
      if (!text) return;
      const point = typeof t.point === "function" ? t.point(ctx) : t.point;
      steps.push({
        id: t.id,
        chapter: "help",
        route: /.*/,
        href: pathname,
        target: t.section,
        point: point ?? null,
        text,
        mood: MOODS[steps.length % MOODS.length],
      });
    });
    if (!steps.length) return;
    setEntry(null);
    setRun({ kind: "pagetour", steps, start: 0, ctx: { productId: null, name: getPrefs().name, mobile }, key: Date.now() });
    setMode("pagetour");
  }, [pathname, cache, mobile]);

  const onProgress = useCallback((stepId: string, ctx: TourCtx) => {
    setPrefs({ tour: { status: "active", stepId, productId: ctx.productId } });
  }, []);

  const onTourExit = useCallback(
    (reason: TourExit, ctx: TourCtx, stepId: string | null) => {
      const isTour = run?.kind === "tour";
      let next: Entry = null;
      if (isTour) {
        if (reason === "done") {
          setPrefs({ tour: { status: "done", stepId: null, productId: ctx.productId } });
        } else if (reason === "skip") {
          setPrefs({ tour: { status: "done", stepId: null, productId: ctx.productId } });
          next = { text: TOUR_LINES.skip, priority: 6, auto: false, mood: "sad" };
        } else {
          setPrefs({ tour: { status: "paused", stepId, productId: ctx.productId } });
          next = {
            text: reason === "pause" ? TOUR_LINES.pause : TOUR_LINES.detour,
            priority: 6,
            auto: false,
            mood: reason === "pause" ? "wink" : "curious",
            actions: [{ label: "Resume", primary: true, run: () => startTour() }],
          };
        }
      }
      setEntry(next);
      setRun(null);
      setMode("companion");
      refocus();
    },
    [run?.kind, startTour],
  );

  /* --------------------------------------------------------------- intro */
  const onIntroDone = useCallback(
    ({ goal, name }: IntroResult) => {
      const key = routeKey(window.location.pathname);
      setPrefs((p) => ({
        intro: "done",
        name: name ?? p.name,
        goal: goal === "skipped" ? p.goal : goal,
        seen: p.seen.includes(key) ? p.seen : [...p.seen, key],
      }));
      sessionSet(SESSION_KEY, "1");
      if (goal === "tour") {
        startTour(true);
        return;
      }
      setEntry(goal === "skipped" ? { text: INTRO_OUTRO.skipped.text, priority: 6, auto: false, mood: INTRO_OUTRO.skipped.mood } : null);
      setMode("companion");
      refocus();
    },
    [startTour],
  );

  const replayIntro = useCallback(() => {
    setPrefs({ intro: "pending", hidden: false });
    setEntry(null);
    setMode("intro");
  }, []);

  /* -------------------------------------------------------------- hotkey */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || editable(e.target) || mode !== "companion" || foreignModal()) return;
      e.preventDefault();
      if (getPrefs().hidden) setPrefs({ hidden: false });
      if (onLogin) setLoginOpen(true);
      setMenuSignal((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onLogin]);

  /* -------------------------------------------------------------- render */
  if (mode === "intro") return <Intro reduced={reduced} mobile={mobile} voice={prefs.voice} onDone={onIntroDone} />;

  if ((mode === "tour" || mode === "pagetour") && run)
    return (
      <Tour
        key={run.key}
        kind={run.kind}
        steps={run.steps}
        startIndex={run.start}
        initialCtx={run.ctx}
        reduced={reduced}
        mobile={mobile}
        voice={prefs.voice}
        onExit={onTourExit}
        onProgress={run.kind === "tour" ? onProgress : undefined}
        skippedChapters={run.skipped}
      />
    );

  if (mode !== "companion") return null;

  const tourLabel =
    prefs.tour.status === "done" ? MENU.replay : resumable ? MENU.resume(tourIndex + 1, TOUR.length) : MENU.tour;

  return (
    <Companion
      prefs={prefs}
      pathname={pathname}
      mobile={mobile}
      reduced={reduced}
      tabOnly={onLogin && !loginOpen}
      hasTips={MOCHI_TIPS.some((t) => t.route.test(pathname) && !!t.section)}
      entry={entry}
      menuSignal={menuSignal}
      tour={{ label: tourLabel, resume: resumable ? { n: tourIndex + 1, total: TOUR.length } : null }}
      onStartTour={() => startTour(prefs.tour.status === "done")}
      onPageTour={startPageTour}
      onLaterTour={() => undefined}
      onShow={() => {
        if (onLogin) setLoginOpen(true);
        setPrefs({ hidden: false });
      }}
      onReplayIntro={replayIntro}
    />
  );
}
