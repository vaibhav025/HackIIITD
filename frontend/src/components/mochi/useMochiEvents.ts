"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onMochi } from "@/lib/mochi-bus";
import { EXPRESSIONS, type Expression } from "./expressions";
import { ACTIONS, GREETINGS, LANDING_SECTIONS, PAGE_INTROS, REACTIONS, routeKey, TOUR_LINES } from "./script";
import { getPrefs, sessionGet, sessionSet, SESSION_KEY, setPrefs } from "./store";

/**
 * Mochi's companion brain: bus subscriptions (toasts, runs, recommendations, `say`), a one-at-a-time
 * bubble queue with priorities, timed moods, idle sleep, page intros and greetings.
 */

export interface BubbleAction {
  label: string;
  primary?: boolean;
  run: () => void;
}
export interface Bubble {
  id: number;
  text: string;
  /** error 5 > rec 4 > run 3 > page intro 2 > toast success 1 > idle 0. Prompted lines use 6. */
  priority: number;
  /** Unprompted (dropped in quiet mode, badge-only on phones). */
  auto: boolean;
  actions?: BubbleAction[];
  /** Route key this line is about: dropped (or closed) when the user navigates elsewhere. */
  route?: string;
  /** Marked as seen in prefs only when the bubble actually shows. */
  seenKey?: string;
  /** Face while the line shows. */
  mood?: Expression;
  /** Little hop when the line shows. */
  hop?: boolean;
  /**
   * "reaction": the outcome of something the user just did (success toast, approve, dismiss…). It is
   * newer news, so it replaces any open or queued unprompted line (an older error or reaction, a page
   * intro, a run update) instead of waiting behind it. "error": a failed action, cleared by a later
   * reaction. "ask": a question waiting for an answer (resume tour), never replaced by a reaction.
   */
  kind?: "reaction" | "error" | "ask";
}
export type SayInput = Omit<Bubble, "id">;

const P = { prompted: 6, error: 5, rec: 4, run: 3, page: 2, toast: 1, idle: 0 };
const IDLE_MS = 45_000;
const GAP_MS = 2500;
const WOKE_KEY = "shelfsense.mochi.woke";

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** Does `b` take the place of the open (or pending) bubble `cur`? */
function outranks(b: Bubble, cur: Bubble) {
  if (b.kind === "reaction" && cur.auto && cur.kind !== "ask") return true;
  return b.priority > cur.priority;
}

export interface MochiEventsOpts {
  pathname: string;
  mobile: boolean;
  quiet: boolean;
  hasTips: boolean;
  /** Tour is paused/active: offer to resume on mount. */
  resume: { n: number; total: number } | null;
  /** First line to say when the companion appears (after the intro or a tour). */
  entry: SayInput & { mood?: Expression } | null;
  onPageTour: () => void;
  onAsk: (prefill?: string) => void;
  onResume: () => void;
  onLater: () => void;
  /** Where confetti bursts from (Mochi's centre). */
  confettiAt: () => void;
}

export function useMochiEvents(o: MochiEventsOpts) {
  const [moodS, setMoodS] = useState<{ expr: Expression; ms?: number; then?: Expression; thenMs?: number; n: number } | null>(null);
  const mood = moodS?.expr ?? null;
  const [sleeping, setSleeping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [badge, setBadge] = useState(false);

  const opts = useRef(o);
  opts.current = o;
  const bubbleRef = useRef<Bubble | null>(null);
  bubbleRef.current = bubble;
  const queue = useRef<Bubble[]>([]);
  const pending = useRef<Bubble | null>(null);
  const seq = useRef(0);
  const lastClosed = useRef(0);
  const pumpT = useRef(0);
  const moodN = useRef(0);
  const lastRecRun = useRef(0);
  const lastSuccessBubble = useRef(0);
  const successCount = useRef(0);
  const lastDoneConfetti = useRef(0);
  const runs = useRef(new Set<string>());
  const [hop, setHop] = useState(0);
  const routeNow = useRef(routeKey(o.pathname));
  const sleepingRef = useRef(false);
  sleepingRef.current = sleeping;

  /* ----------------------------------------------------------------- moods */
  /** Timed mood: returns to the base expression (idle, or sleepy while sleeping) after `ms`. */
  const setMood = useCallback((expr: Expression | null, opt: { ms?: number; then?: Expression; thenMs?: number } = {}) => {
    setMoodS(expr ? { expr, ...opt, n: ++moodN.current } : null);
  }, []);
  // The return timer lives in an effect, so it is rescheduled (never lost) when effects re-run.
  useEffect(() => {
    if (!moodS?.ms) return;
    const t = window.setTimeout(() => {
      setMoodS(moodS.then ? { expr: moodS.then, ms: moodS.thenMs ?? 1500, n: ++moodN.current } : null);
    }, moodS.ms);
    return () => window.clearTimeout(t);
  }, [moodS]);

  /* --------------------------------------------------------------- bubbles */
  const show = useCallback(
    (b: Bubble) => {
      setBadge(false);
      pending.current = null;
      setBubble(b);
      if (b.mood) setMood(b.mood, { ms: Math.max(3000, Array.from(b.text).length * 28 + 2000) });
      if (b.hop) setHop((h) => h + 1);
      const k = b.seenKey;
      if (k) setPrefs((p) => (p.seen.includes(k) ? {} : { seen: [...p.seen, k].slice(-40) }));
    },
    [setMood],
  );

  const pump = useCallback(() => {
    window.clearTimeout(pumpT.current);
    if (bubbleRef.current || !queue.current.length) return;
    const nextB = queue.current[0];
    const wait = nextB.auto && nextB.priority < P.error ? lastClosed.current + GAP_MS - Date.now() : 0;
    if (wait > 0) {
      pumpT.current = window.setTimeout(pump, wait);
      return;
    }
    queue.current.shift();
    show(nextB);
  }, [show]);

  const say = useCallback(
    (input: SayInput) => {
      const L = opts.current;
      if (input.auto && L.quiet) return;
      const b: Bubble = { ...input, id: ++seq.current };
      if (b.route && b.route !== routeNow.current) return;
      if (b.kind === "reaction") {
        // Older unprompted lines still waiting in line are stale next to this one.
        queue.current = queue.current.filter((q) => !q.auto || q.kind === "ask");
      }
      if (input.auto && L.mobile) {
        // Phones: unprompted tips wait behind a badge dot until Mochi is tapped.
        const cur = pending.current;
        if (!cur || outranks(b, cur) || b.priority >= cur.priority) pending.current = b;
        setBadge(true);
        return;
      }
      const cur = bubbleRef.current;
      if (cur) {
        if (!input.auto || (cur.auto && outranks(b, cur))) {
          show(b);
          return;
        }
        queue.current = [...queue.current, b].sort((x, y) => y.priority - x.priority).slice(0, 3);
        return;
      }
      // A reaction answers what the user just did: no breather gap before it.
      if (input.auto && b.kind !== "reaction" && b.priority < P.error && Date.now() - lastClosed.current < GAP_MS) {
        queue.current = [...queue.current, b].sort((x, y) => y.priority - x.priority).slice(0, 3);
        pump();
        return;
      }
      show(b);
    },
    [pump, show],
  );

  const closeBubble = useCallback(() => {
    setBubble(null);
    bubbleRef.current = null;
    lastClosed.current = Date.now();
    pumpT.current = window.setTimeout(pump, queue.current[0]?.priority >= P.error ? 50 : GAP_MS);
  }, [pump]);

  /** Phones: tapping Mochi with a badge shows the waiting tip. Returns true if it did. */
  const openPending = useCallback(() => {
    const b = pending.current;
    if (!b) return false;
    show({ ...b, auto: false });
    return true;
  }, [show]);

  /* ---------------------------------------------------------------- events */
  useEffect(() => {
    const offs = [
      onMochi("toast", (e) => {
        if (e.tone !== "error" && Date.now() - lastRecRun.current < 800) return;
        if (e.tone === "success") {
          setMood("excited", { ms: 1800 });
          setHop((h) => h + 1);
          successCount.current += 1;
          // An error line still up (or waiting on phones) is out of date now: always answer it.
          const staleError = bubbleRef.current?.kind === "error" || pending.current?.kind === "error";
          if (staleError || (successCount.current % 3 === 1 && Date.now() - lastSuccessBubble.current > 20_000)) {
            lastSuccessBubble.current = Date.now();
            say({ text: pick(REACTIONS.toastSuccess), priority: P.toast, auto: true, kind: "reaction" });
          }
        } else if (e.tone === "error") {
          setMood("worried", { ms: 4000 });
          const rule = REACTIONS.toastError.find(([re]) => re.test(e.message));
          say({
            text: rule ? rule[1] : REACTIONS.toastErrorDefault,
            priority: P.error,
            auto: true,
            kind: "error",
            actions: rule ? undefined : [{ label: ACTIONS.ask, primary: true, run: () => opts.current.onAsk(REACTIONS.askAbout(e.message)) }],
          });
        } else {
          setMood("curious", { ms: 1500 });
        }
      }),
      onMochi("run", (e) => {
        if (e.phase === "detach") {
          // The page following this run went away: stop waiting for it, quietly.
          runs.current.delete(e.runId);
          setBusy(runs.current.size > 0);
          return;
        }
        if (e.phase === "progress") {
          if (!runs.current.has(e.runId)) return;
          // Mood and hop ride on the bubble, so they play when the line actually shows.
          if (e.milestone === "oos") say({ text: REACTIONS.runOos, priority: P.run, auto: true, mood: "worried", hop: true });
          else if (e.milestone === "half")
            say({ text: REACTIONS.runHalf(e.done ?? 0, e.total ?? 0), priority: P.run, auto: true, mood: "excited", hop: true });
          else say({ text: REACTIONS.runFirst, priority: P.run, auto: true, mood: "happy", hop: true });
          return;
        }
        lastRecRun.current = Date.now();
        if (e.phase === "start") {
          runs.current.add(e.runId);
          setBusy(true);
          setMood(null);
          say({ text: REACTIONS.runStart(e.total), priority: P.run, auto: true });
          return;
        }
        runs.current.delete(e.runId);
        setBusy(runs.current.size > 0);
        if (e.phase === "failed") {
          setMood("worried", { ms: 4000 });
          say({ text: REACTIONS.runFailed, priority: P.error, auto: true, kind: "error" });
        } else if (e.failed && e.failed > 0) {
          setMood("happy", { ms: 2500 });
          say({ text: REACTIONS.runPartial(e.failed, e.total ?? e.failed), priority: P.run, auto: true });
        } else {
          setMood("celebrate", { ms: 2600 });
          opts.current.confettiAt();
          say({ text: REACTIONS.runDone, priority: P.run, auto: true });
        }
      }),
      onMochi("rec", (e) => {
        lastRecRun.current = Date.now();
        const L = opts.current;
        if (e.verb === "approve") {
          setMood("love", { ms: 2600 });
          L.confettiAt();
          say({ text: REACTIONS.recApprove, priority: P.rec, auto: true, kind: "reaction" });
        } else if (e.verb === "dismiss") {
          setMood("wink", { ms: 2000 });
          say({ text: REACTIONS.recDismiss, priority: P.rec, auto: true, kind: "reaction" });
        } else if (e.verb === "done") {
          setMood("celebrate", { ms: 2600 });
          if (Date.now() - lastDoneConfetti.current > 10_000) L.confettiAt();
          lastDoneConfetti.current = Date.now();
          say({ text: REACTIONS.recDone, priority: P.rec, auto: true, kind: "reaction" });
        } else if (e.verb === "send-telegram") {
          setMood("excited", { ms: 2000 });
          say({ text: REACTIONS.recTelegram, priority: P.rec, auto: true, kind: "reaction" });
        } else {
          setMood("curious", { ms: 2000 });
          say({ text: REACTIONS.recReopen, priority: P.rec, auto: true, kind: "reaction" });
        }
      }),
      onMochi("say", (e) => {
        const m = EXPRESSIONS.includes(e.mood as Expression) ? (e.mood as Expression) : "happy";
        setMood(m, { ms: 3000 });
        say({ text: e.text, priority: P.prompted, auto: false });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [say, setMood]);

  /* ----------------------------------------------------------- idle sleep */
  useEffect(() => {
    let last = Date.now();
    const wake = () => {
      last = Date.now();
      if (!sleepingRef.current) return;
      sleepingRef.current = false;
      setSleeping(false);
      setMood("surprised", { ms: 600, then: "happy", thenMs: 1500 });
      if (!sessionGet(WOKE_KEY)) {
        sessionSet(WOKE_KEY, "1");
        say({ text: GREETINGS.wake, priority: P.idle, auto: true });
      }
    };
    const evts = ["pointermove", "pointerdown", "keydown", "wheel", "scroll", "touchstart"] as const;
    evts.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    const id = window.setInterval(() => {
      if (sleepingRef.current || document.visibilityState !== "visible") {
        if (document.visibilityState !== "visible") last = Date.now();
        return;
      }
      if (Date.now() - last >= IDLE_MS) {
        sleepingRef.current = true;
        setSleeping(true);
      }
    }, 1000);
    return () => {
      evts.forEach((e) => window.removeEventListener(e, wake));
      window.clearInterval(id);
    };
  }, [say, setMood]);

  /* ------------------------------------------- mount: entry / resume / greet */
  useEffect(() => {
    const L = opts.current;
    const prefs = getPrefs();
    if (L.entry) {
      if (L.entry.mood) setMood(L.entry.mood, { ms: 2200, then: "happy" });
      say(L.entry);
    } else if (L.resume) {
      say({
        text: TOUR_LINES.resume(L.resume.n, L.resume.total),
        priority: P.rec,
        auto: true,
        kind: "ask",
        actions: [
          { label: ACTIONS.continue, primary: true, run: () => opts.current.onResume() },
          { label: ACTIONS.later, run: () => opts.current.onLater() },
        ],
      });
    } else if (prefs.intro === "done" && !sessionGet(SESSION_KEY)) {
      say({ text: GREETINGS.returning(prefs.name, new Date().getHours()), priority: P.page, auto: true, mood: "happy" });
    }
    sessionSet(SESSION_KEY, "1");
    return () => window.clearTimeout(pumpT.current);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ page intro */
  useEffect(() => {
    const key = routeKey(o.pathname);
    routeNow.current = key;
    // Lines about the page we just left are stale: close the open one, drop the queued ones.
    const stale = (b: Bubble | null) => !!b?.route && b.route !== key;
    queue.current = queue.current.filter((b) => !stale(b));
    if (stale(pending.current)) {
      pending.current = null;
      setBadge(false);
    }
    if (stale(bubbleRef.current)) closeBubble();

    const intro = PAGE_INTROS[key];
    if (!intro) return;
    const t = window.setTimeout(() => {
      const L = opts.current;
      const prefs = getPrefs();
      if (L.quiet || prefs.seen.includes(key)) return;
      say({
        text: typeof intro.text === "function" ? intro.text(prefs.name) : intro.text,
        mood: intro.mood,
        priority: P.page,
        auto: true,
        route: key,
        seenKey: key,
        actions: L.hasTips
          ? [
              { label: ACTIONS.showMe, primary: true, run: () => opts.current.onPageTour() },
              { label: ACTIONS.later, run: () => undefined },
            ]
          : undefined,
      });
    }, 900);
    return () => window.clearTimeout(t);
  }, [o.pathname, say, closeBubble]);

  /* --------------------------------------------- landing: section commentary */
  useEffect(() => {
    if (routeKey(o.pathname) !== "/" || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          const sec = LANDING_SECTIONS.find((x) => en.target.matches(x.selector));
          if (!sec || getPrefs().seen.includes(sec.key)) return;
          say({ text: sec.text, mood: sec.mood, priority: P.page, auto: true, route: "/", seenKey: sec.key });
        });
      },
      { threshold: 0.35 },
    );
    // Wait a beat so the welcome line (and any first-visit intro) goes first.
    const t = window.setTimeout(() => {
      LANDING_SECTIONS.forEach((sec) => {
        if (getPrefs().seen.includes(sec.key)) return;
        const el = document.querySelector(sec.selector);
        if (el) io.observe(el);
      });
    }, 1500);
    return () => {
      window.clearTimeout(t);
      io.disconnect();
    };
  }, [o.pathname, say]);

  return { mood, setMood, sleeping, busy, bubble, say, closeBubble, badge, openPending, hop, P };
}
