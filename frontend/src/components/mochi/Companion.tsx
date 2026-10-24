"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { mutate } from "swr";
import { api, ApiError } from "@/lib/api";
import { confetti } from "./confetti";
import { SpeakerToggle, speechHotkey, toggleSpeech, useTypewriter } from "./Dialogue";
import type { Expression } from "./expressions";
import MochiFace from "./MochiFace";
import { GREETINGS, MENU, REACTIONS } from "./script";
import {
  clamp,
  dockPosition,
  FINE_QUERY,
  foreignModal,
  leftInset,
  obstacles,
  overlap,
  setPrefs,
  topInset,
  useMedia,
  type MochiPrefs,
} from "./store";
import { useMochiEvents, type Bubble, type SayInput } from "./useMochiEvents";
import { cancel as cancelSpeech, speak, useVoice } from "./voice";

/**
 * Companion mode: Mochi docked at the screen edge (inline-positioned, never covering controls),
 * reacting to app events, with a speech bubble, a JRPG command window and a mini "Ask Mochi" chat.
 */

type ChatReply = { conversation_id: string; answer: string; actions?: Record<string, unknown>[] };
type ChatAction = { label: string; path: string };

/** Same allow-list as the Help Centre chat: actions may only deep-link to known in-app routes. */
const SAFE_ACTION_PATH = /^\/(dashboard|products(\/[\w-]+(\/(settings|telegram|heatmap))?)?|heatmap|help|settings|agents)(\?[^#\s]*)?(#[\w-]*)?$/;
const isSafeActionPath = (path: unknown): path is string =>
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && SAFE_ACTION_PATH.test(path);

function safeActions(list: unknown): ChatAction[] {
  if (!Array.isArray(list)) return [];
  const out: ChatAction[] = [];
  for (const a of list as Record<string, unknown>[]) {
    if (!a || !isSafeActionPath(a.path) || typeof a.label !== "string" || !a.label.trim()) continue;
    if (out.some((o) => o.path === a.path)) continue;
    out.push({ label: a.label.trim(), path: a.path });
  }
  return out.slice(0, 4);
}

const Z = 1050;
const OUT = "cubic-bezier(.23,1,.32,1)";
const DRAG_KEY = "shelfsense.mochi.dragged";

export interface CompanionProps {
  prefs: MochiPrefs;
  pathname: string;
  mobile: boolean;
  reduced: boolean;
  /** Render only the edge tab (Mochi hidden, or on /login). */
  tabOnly: boolean;
  hasTips: boolean;
  entry: (SayInput & { mood?: Expression }) | null;
  /** Increment to open the command window (Shift + ?). */
  menuSignal: number;
  tour: { label: string; resume: { n: number; total: number } | null };
  onStartTour: () => void;
  onPageTour: () => void;
  onLaterTour: () => void;
  onShow: () => void;
  onReplayIntro: () => void;
}

/** Strip markdown for the little chat box and cap its length. */
function plain(s: string) {
  const t = s
    .replace(/\*\*|__/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/`+/g, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
  return Array.from(t).length > 700 ? `${Array.from(t).slice(0, 700).join("").trimEnd()}…` : t;
}

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const useTabVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    /* ignore */
  }
}

export default function Companion(p: CompanionProps) {
  const { prefs, mobile, reduced } = p;
  const fine = useMedia(FINE_QUERY);
  const side = mobile ? "right" : prefs.dock.side;

  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const faceWrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuItems = useRef<(HTMLButtonElement | null)[]>([]);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const [vp, setVp] = useState(() => ({ w: document.documentElement.clientWidth, h: window.innerHeight }));
  const [lift, setLift] = useState(0);
  const [avoidDy, setAvoidDy] = useState(0);
  const [peek, setPeek] = useState(false);
  const [near, setNear] = useState(false);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState(false);
  const [chat, setChat] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; rot: number } | null>(null);
  const [panelH, setPanelH] = useState(0);

  // Chat state (kept for the session while the companion is mounted).
  const [draft, setDraft] = useState("");
  const [convId, setConvId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState<{ id: number; text: string; actions: ChatAction[] } | null>(null);
  const [chatErr, setChatErr] = useState<string | null>(null);

  /* ------------------------------------------------------------ brain */
  const burst = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) confetti(r.left + r.width / 2, r.top + r.height * 0.3, Z);
  }, []);
  const openChat = useCallback((prefill?: string) => {
    setMenu(false);
    setChat(true);
    setChatErr(null);
    if (prefill) setDraft(prefill);
  }, []);

  const ev = useMochiEvents({
    pathname: p.pathname,
    mobile,
    quiet: prefs.quiet,
    hasTips: p.hasTips,
    resume: p.tour.resume,
    entry: p.entry,
    onPageTour: p.onPageTour,
    onAsk: openChat,
    onResume: p.onStartTour,
    onLater: p.onLaterTour,
    confettiAt: burst,
  });
  const bubble: Bubble | null = menu || chat ? null : ev.bubble;

  /* --------------------------------------------------------- placement */
  useEffect(() => {
    const onResize = () => setVp({ w: document.documentElement.clientWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const base = dockPosition(prefs, mobile, lift);
  const S = base.S;
  const x = drag ? drag.x : base.x;
  const y = drag ? drag.y : clamp(base.y + avoidDy, base.minY, base.maxY);

  // Self-check: the inline styles keep Mochi working even if mochi.css is stale or missing.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" || !cs.getPropertyValue("--m2-out").trim()) console.warn("[mochi] layout CSS missing");
  }, []);

  // Toast lift: hop up when the toast stack would sit on Mochi's column.
  useEffect(() => {
    const host = document.querySelector<HTMLElement>("[data-toaster]");
    if (!host) return;
    const sync = () => {
      const r = host.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const mx = side === "right" ? vw - S - 16 : leftInset() + 16;
      const overlapsColumn = r.height > 0 && r.left < mx + S && r.right > mx;
      setLift(overlapsColumn ? r.height + 12 : 0);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(host);
    const mo = new MutationObserver(sync);
    mo.observe(host, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [side, S]);

  // Never cover controls: nudge along the edge, or tuck half off-screen ("peek").
  const avoid = useCallback(() => {
    if (drag) return;
    const pos = dockPosition(prefs, mobile, lift);
    const boxes = obstacles();
    const hit = (yy: number) => overlap(boxes, pos.x, yy, pos.x + pos.S, yy + pos.S);
    if (mobile) {
      setAvoidDy(0);
      setPeek(hit(pos.y) > 0);
      return;
    }
    if (hit(pos.y) === 0) {
      setAvoidDy(0);
      setPeek(false);
      return;
    }
    for (let d = 12; d <= 240; d += 12) {
      for (const dy of [-d, d]) {
        const yy = pos.y + dy;
        if (yy < pos.minY || yy > pos.maxY) continue;
        if (hit(yy) === 0) {
          setAvoidDy(dy);
          setPeek(false);
          return;
        }
      }
    }
    setAvoidDy(0);
    setPeek(true);
  }, [drag, prefs, mobile, lift]);

  useEffect(() => {
    let t = 0;
    const later = () => {
      window.clearTimeout(t);
      t = window.setTimeout(avoid, 200);
    };
    later();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    // Pages load data after mount: re-check when the DOM settles, or the layout shifts without one.
    const mo = new MutationObserver(later);
    mo.observe(document.body, { childList: true, subtree: true });
    const ro = new ResizeObserver(later);
    const main = document.getElementById("main") ?? document.querySelector("main");
    if (main) ro.observe(main);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      mo.disconnect();
      ro.disconnect();
    };
  }, [avoid, p.pathname]);

  // Peeking Mochi slides back out when the pointer comes close, but never over the control the
  // pointer is heading for: away from the visible sliver, it only untucks onto free space.
  useEffect(() => {
    if (!peek) {
      setNear(false);
      return;
    }
    let cache: { at: number; blocked: boolean } | null = null;
    const onMove = (e: PointerEvent) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      const vis = { l: Math.max(0, r.left), r: Math.min(vw, r.right), t: r.top, b: r.bottom };
      const dx = Math.max(vis.l - e.clientX, 0, e.clientX - vis.r);
      const dy = Math.max(vis.t - e.clientY, 0, e.clientY - vis.b);
      const d = Math.hypot(dx, dy);
      if (d <= 8) return setNear(true);
      if (d >= 80) return setNear(false);
      if (!cache || performance.now() - cache.at > 400) {
        const pos = dockPosition(prefs, mobile, lift);
        const ux = pos.x;
        const uy = mobile ? r.top : clamp(pos.y + avoidDy, pos.minY, pos.maxY);
        cache = { at: performance.now(), blocked: overlap(obstacles(), ux, uy, ux + pos.S, uy + pos.S) > 0 };
      }
      setNear(!cache.blocked);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [peek, prefs, mobile, lift, avoidDy]);

  const tucked = peek && !bubble && !menu && !chat && !hover && !focused && !near && !drag;

  /* ---------------------------------------------------------- expression */
  // Spoken voice: prompted lines always (voice on), unprompted ones only in a visible tab and not in
  // quiet mode. Hiding Mochi, closing the chat or the bubble cancels at once (the line goes away).
  const voiceState = useVoice();
  const tabVisible = useTabVisible();
  const speechOn = prefs.speech && !prefs.hidden && !p.tabOnly;
  const speakBubble = speechOn && !!bubble && (!bubble.auto || (tabVisible && !prefs.quiet));
  const replyTw = useTypewriter(reply?.text ?? "", reply?.id ?? 0, {
    reduced,
    voice: prefs.voice,
    // Same text as shown (already capped by plain()), spoken up to ~500 chars at a sentence end.
    speak: { on: speechOn && chat && !asking, mood: "happy", maxChars: 500 },
  });
  const bubbleTw = useTypewriter(bubble?.text ?? "", bubble?.id ?? 0, {
    reduced,
    voice: prefs.voice,
    speak: { on: speakBubble, mood: bubble?.mood ?? ev.mood ?? undefined },
  });

  // Chat errors are said too (no typewriter there).
  useEffect(() => {
    if (!chatErr || !chat || !speechOn) return;
    const token = speak(chatErr, { mood: "worried" });
    return () => cancelSpeech(token);
  }, [chatErr, chat, speechOn]);

  // Navigating elsewhere or pressing Esc silences Mochi.
  const firstPath = useRef(p.pathname);
  useEffect(() => {
    if (firstPath.current === p.pathname) return;
    firstPath.current = p.pathname;
    cancelSpeech();
  }, [p.pathname]);
  useEffect(() => {
    if (!voiceState.speaking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelSpeech();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [voiceState.speaking]);

  // Chat reply: keep the typing caret in view while it types, unless the user scrolled away.
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const follow = useRef({ on: true, at: -1 });
  useEffect(() => {
    follow.current = { on: true, at: -1 };
    const sc = chatScrollRef.current;
    if (sc) sc.scrollTop = 0;
  }, [reply?.id]);
  useLayoutEffect(() => {
    const sc = chatScrollRef.current;
    const caret = caretRef.current;
    const f = follow.current;
    if (!sc || !f.on) return;
    // Moved up since we last placed it (scroll event not dispatched yet): the user is reading back.
    if (f.at >= 0 && sc.scrollTop < f.at - 4) {
      f.on = false;
      return;
    }
    let want: number;
    if (replyTw.done) {
      // Finished: show the action links under the text when they are what is left below.
      want = caret ? Math.min(sc.scrollHeight - sc.clientHeight, caret.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight + 64) : sc.scrollTop;
    } else if (caret) {
      want = caret.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight + 8;
    } else return;
    want = Math.max(0, Math.round(want));
    if (want > sc.scrollTop) {
      sc.scrollTop = want;
      f.at = sc.scrollTop;
    }
  }, [replyTw.shown, replyTw.done, reply?.id]);
  const onChatScroll = () => {
    const sc = chatScrollRef.current;
    const f = follow.current;
    if (!sc || f.at < 0) return;
    // Scrolling up past where we put it means the user is reading back: stop following.
    if (sc.scrollTop < f.at - 4) f.on = false;
    else if (!f.on && sc.scrollTop >= f.at - 4) f.on = true;
  };
  const talk = chat ? (reply ? replyTw.frame : null) : bubble ? bubbleTw.frame : null;
  const hold: Expression | null = asking ? "thinking" : chat && reply && !replyTw.done ? "happy" : menu || hover ? "happy" : null;
  const expression: Expression = ev.mood ?? hold ?? (ev.busy ? "thinking" : ev.sleeping ? "sleepy" : "idle");

  /* ------------------------------------------------------------- bubble */
  // Auto-hide after max(4s, 60ms per char), held while hovered or focused.
  useEffect(() => {
    if (!bubble || !bubbleTw.done || bubbleTw.speaking) return;
    let t = 0;
    const len = Array.from(bubble.text).length;
    const wait = (ms: number) => {
      t = window.setTimeout(() => {
        const root = panelRef.current;
        if (root && (root.matches(":hover") || root.contains(document.activeElement))) wait(1500);
        else ev.closeBubble();
      }, ms);
    };
    // Once spoken, the line has already been on screen for a while: a shorter linger.
    const spokenAlready = speakBubble && voiceState.unlocked;
    wait((spokenAlready ? 2500 : Math.max(4000, len * 60)) * (bubble.actions ? 2 : 1));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble?.id, bubbleTw.done, bubbleTw.speaking]);

  // Phones: scrolling on closes the bubble.
  useEffect(() => {
    if (!mobile || !bubble) return;
    const y0 = window.scrollY;
    const onScroll = () => {
      if (Math.abs(window.scrollY - y0) > 80) ev.closeBubble();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, bubble?.id]);

  /* --------------------------------------------------------------- menu */
  const closeMenu = useCallback((refocus = true) => {
    setMenu(false);
    setChat(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!p.menuSignal) return;
    setChat(false);
    setMenu(true);
  }, [p.menuSignal]);

  useEffect(() => {
    if (menu) requestAnimationFrame(() => menuItems.current.find(Boolean)?.focus({ preventScroll: true }));
  }, [menu]);
  useEffect(() => {
    if (chat) requestAnimationFrame(() => chatInputRef.current?.focus({ preventScroll: true }));
  }, [chat]);

  // An app dialog opening on top takes over: close the menu/chat (focus belongs to the dialog).
  useEffect(() => {
    if (!menu && !chat) return;
    const check = () => {
      if (!foreignModal()) return;
      setMenu(false);
      setChat(false);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "role"] });
    return () => mo.disconnect();
  }, [menu, chat]);

  // Click outside closes the window.
  useEffect(() => {
    if (!menu && !chat) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || rootRef.current?.contains(t)) return;
      setMenu(false);
      setChat(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu, chat]);

  const items: { id: string; label: string; run: () => void; footer?: boolean }[] = [
    { id: "tour", label: p.tour.label, run: () => (setMenu(false), p.onStartTour()) },
    ...(p.hasTips ? [{ id: "page", label: MENU.page, run: () => (setMenu(false), p.onPageTour()) }] : []),
    { id: "ask", label: MENU.ask, run: () => openChat() },
    {
      id: "quiet",
      label: MENU.quiet(prefs.quiet),
      run: () => {
        const on = !prefs.quiet;
        setPrefs({ quiet: on });
        closeMenu();
        ev.setMood(on ? "wink" : "happy", { ms: 1800 });
        ev.say({ text: on ? GREETINGS.quietOn : GREETINGS.quietOff, priority: 6, auto: false });
      },
    },
    ...(!mobile
      ? [
          {
            id: "move",
            label: MENU.move(prefs.dock.side),
            run: () => {
              setPrefs({ dock: { ...prefs.dock, side: prefs.dock.side === "right" ? "left" : "right" } });
              closeMenu();
            },
          },
        ]
      : []),
    {
      id: "hide",
      label: MENU.hide,
      run: () => {
        setMenu(false);
        ev.setMood("sad", { ms: 1400 });
        ev.say({ text: GREETINGS.hidden, priority: 6, auto: false });
        window.setTimeout(() => setPrefs({ hidden: true }), 1600);
      },
    },
    { id: "intro", label: MENU.intro, footer: true, run: () => (setMenu(false), p.onReplayIntro()) },
    ...(voiceState.supported ? [{ id: "speech", label: MENU.speech(prefs.speech), footer: true, run: () => toggleSpeech() }] : []),
  ];

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = menuItems.current.filter(Boolean) as HTMLButtonElement[];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let to = -1;
    if (e.key === "ArrowDown") to = (i + 1) % list.length;
    else if (e.key === "ArrowUp") to = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    } else if (e.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (to >= 0) {
      e.preventDefault();
      list[to]?.focus();
    }
  };

  /* --------------------------------------------------------------- chat */
  const productId = p.pathname.match(/^\/products\/([^/]+)/)?.[1] ?? null;
  const send = async (text: string) => {
    const message = text.trim();
    if (!message || asking) return;
    setAsking(true);
    setChatErr(null);
    setReply(null);
    try {
      const res = await api<ChatReply>("/chat", {
        method: "POST",
        json: { message, conversation_id: convId, product_id: convId ? null : productId },
      });
      setConvId(res.conversation_id);
      setReply({ id: Date.now(), text: plain(res.answer || ""), actions: safeActions(res.actions) });
      setDraft("");
      void mutate("/chat/conversations");
    } catch (e) {
      const noAi =
        e instanceof ApiError && (e.status === 503 || /integration|not_configured|unavailable|disabled/i.test(`${e.code} ${e.message}`));
      setChatErr(noAi ? REACTIONS.chatNoAi : REACTIONS.chatError);
      ev.setMood("worried", { ms: 4000 });
    } finally {
      setAsking(false);
    }
  };

  /* --------------------------------------------------------- click/drag */
  const pets = useRef<number[]>([]);
  const dragInfo = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; lx: number; lt: number; vx: number; moved: boolean; first: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const now = Date.now();
    pets.current = [...pets.current.filter((t) => now - t < 2000), now];
    if (pets.current.length >= 5) {
      pets.current = [];
      setMenu(false);
      setChat(false);
      ev.setMood("love", { ms: 2200 });
      ev.say({ text: GREETINGS.pet, priority: 6, auto: false });
      return;
    }
    if (ev.badge && ev.openPending()) return;
    if (menu || chat) {
      setMenu(false);
      setChat(false);
      return;
    }
    if (bubble) ev.closeBubble();
    setMenu(true);
  };

  const canDrag = !mobile && fine;
  const onPointerDown = (e: React.PointerEvent) => {
    if (!canDrag || e.button !== 0 || dragInfo.current) return;
    dragInfo.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y, lx: e.clientX, lt: performance.now(), vx: 0, moved: false, first: true };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragInfo.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      d.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setMenu(false);
      setChat(false);
      ev.setMood("surprised", { ms: 350, then: "excited", thenMs: 60_000 });
      if (!readFlag(DRAG_KEY)) {
        writeFlag(DRAG_KEY);
        ev.say({ text: GREETINGS.dragFirst, priority: 6, auto: false });
      }
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lt);
    d.vx = d.vx * 0.6 + ((e.clientX - d.lx) / dt) * 0.4;
    d.lx = e.clientX;
    d.lt = now;
    const vw = document.documentElement.clientWidth;
    setDrag({
      x: clamp(d.ox + dx, 0, vw - S),
      y: clamp(d.oy + dy, topInset() + 4, window.innerHeight - S - 4),
      rot: clamp(d.vx * 4, -12, 12),
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragInfo.current;
    if (!d || e.pointerId !== d.id) return;
    dragInfo.current = null;
    if (!d.moved) return; // a click
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 0);
    const vw = document.documentElement.clientWidth;
    const cur = drag ?? { x, y, rot: 0 };
    const sideTo: "left" | "right" = d.vx > 0.5 ? "right" : d.vx < -0.5 ? "left" : cur.x + S / 2 < vw / 2 ? "left" : "right";
    setPrefs({ dock: { side: sideTo, y: clamp(cur.y / window.innerHeight, 0, 1) } });
    setDrag(null);
    setAvoidDy(0);
    ev.setMood("happy", { ms: 1200 });
    if (!reduced)
      window.setTimeout(
        () =>
          faceWrapRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.08,.88)" }, { transform: "scale(.97,1.04)" }, { transform: "scale(1)" }], {
            duration: 260,
            delay: 260,
            easing: OUT,
          }),
        0,
      );
  };

  /* ------------------------------------------------------- panel place */
  const panelOpen = !!bubble || menu || chat;
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (el && el.offsetHeight !== panelH) setPanelH(el.offsetHeight);
  }, [panelH, bubble?.id, menu, chat, reply, replyTw.done, asking, chatErr, mobile]);

  const sheet = mobile && (menu || chat);
  const above = y - 8 - panelH >= base.minY;
  const panelPlace: CSSProperties = sheet
    ? { left: 0, right: 0, bottom: 0, transformOrigin: "50% 100%" }
    : mobile
      ? { right: 16, bottom: window.innerHeight - y + 8, maxWidth: "calc(100vw - 32px)", transformOrigin: "85% 100%" }
      : above
        ? side === "right"
          ? { right: vp.w - (x + S * 0.8), bottom: vp.h - y + 8, transformOrigin: "90% 100%" }
          : { left: x + S * 0.2, bottom: vp.h - y + 8, transformOrigin: "10% 100%" }
        : side === "right"
          ? { right: vp.w - x + 10, top: clamp(y + S / 2 - panelH / 2, base.minY, vp.h - panelH - 8), transformOrigin: "100% 50%" }
          : { left: x + S + 10, top: clamp(y + S / 2 - panelH / 2, base.minY, vp.h - panelH - 8), transformOrigin: "0 50%" };

  const panelBox = (width: number | string, children: ReactNode, extra?: CSSProperties, attrs?: { role?: string; label?: string }) => (
    <div
      ref={panelRef}
      className={`m2 m2-box ${sheet ? "m2-sheet-in" : "m2-pop-in"}`}
      data-m2="panel"
      role={attrs?.role}
      aria-label={attrs?.label}
      style={{
        position: "fixed",
        zIndex: Z,
        pointerEvents: "auto",
        boxSizing: "border-box",
        width: sheet ? undefined : width,
        maxWidth: sheet ? undefined : "calc(100vw - 32px)",
        background: "#F4F1DE",
        border: "2px solid #0D1B2A",
        borderRadius: sheet ? "20px 20px 0 0" : 16,
        boxShadow: sheet ? "none" : "4px 4px 0 #0D1B2A",
        padding: sheet ? "22px 16px calc(16px + env(safe-area-inset-bottom))" : "18px 16px 14px",
        ...panelPlace,
        ...extra,
      }}
    >
      <span className="m2-plate" style={{ position: "absolute", top: -12, left: 14, fontSize: 10, lineHeight: "14px", padding: "1px 8px" }} aria-hidden="true">
        Mochi
      </span>
      {children}
      {!sheet && above && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: -8,
            [side === "right" ? "right" : "left"]: S * 0.3,
            width: 12,
            height: 12,
            background: "#F4F1DE",
            borderRight: "2px solid #0D1B2A",
            borderBottom: "2px solid #0D1B2A",
            transform: "rotate(45deg)",
          }}
        />
      )}
    </div>
  );

  /* ---------------------------------------------------------------- tab */
  if (p.tabOnly || prefs.hidden) {
    const tabSide = mobile ? "right" : prefs.dock.side;
    const ty = clamp(prefs.dock.y * window.innerHeight, topInset() + 12, window.innerHeight - 60);
    return (
      <div className="m2" data-m2="tab" style={{ position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: Z, pointerEvents: "none" }}>
        <button
          type="button"
          className="m2-btn"
          aria-label="Show Mochi"
          onClick={p.onShow}
          style={{
            position: "fixed",
            top: ty,
            [tabSide]: 0,
            width: 28,
            height: 44,
            zIndex: Z,
            pointerEvents: "auto",
            overflow: "hidden",
            background: "#E6F7F0",
            border: "2px solid #0D1B2A",
            [tabSide === "right" ? "borderRight" : "borderLeft"]: 0,
            borderRadius: tabSide === "right" ? "14px 0 0 14px" : "0 14px 14px 0",
          }}
        >
          <span style={{ position: "absolute", top: 2, [tabSide === "right" ? "left" : "right"]: -8, display: "block" }} aria-hidden="true">
            <MochiFace expression="idle" size={46} />
          </span>
        </button>
      </div>
    );
  }

  /* -------------------------------------------------------------- render */
  const peekX = tucked ? (side === "right" ? "62%" : "-62%") : "0px";
  const rootStyle: CSSProperties = mobile
    ? {
        position: "fixed",
        right: 16,
        bottom: `calc(16px + env(safe-area-inset-bottom) + ${lift}px)`,
        left: "auto",
        top: "auto",
        width: S,
        height: S,
        zIndex: Z,
        pointerEvents: "auto",
        transform: `translate3d(${peekX}, 0, 0)`,
        opacity: tucked ? 0.9 : 1,
        transition: `transform 220ms ${OUT}, bottom 220ms ease-out, opacity 150ms ease`,
      }
    : {
        position: "fixed",
        left: 0,
        top: 0,
        width: S,
        height: S,
        zIndex: Z,
        pointerEvents: "auto",
        touchAction: canDrag ? "none" : undefined,
        transform: `translate3d(${x}px, ${y}px, 0) translateX(${peekX}) rotate(${drag?.rot ?? 0}deg)`,
        opacity: tucked ? 0.9 : 1,
        transition: drag ? "none" : `transform 300ms ${OUT}, opacity 150ms ease`,
      };

  const menuId = "m2-menu";
  const mainItems = items.filter((i) => !i.footer);
  const footItems = items.filter((i) => i.footer);
  let itemIndex = 0;

  return (
    <>
      <div
        ref={rootRef}
        className="m2 m2-companion"
        data-m2="companion"
        data-expression={expression}
        style={rootStyle}
        onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
        onPointerLeave={() => setHover(false)}
      >
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {bubble
            ? `Mochi says: ${bubble.text}`
            : chat
              ? asking
                ? REACTIONS.chatThinking
                : chatErr
                  ? chatErr
                  : reply
                    ? `Mochi says: ${reply.text}`
                    : ""
              : ""}
        </div>
        {ev.busy && (
          <span aria-hidden="true" className="m2-busy" style={{ position: "absolute", inset: -6, borderRadius: "9999px", pointerEvents: "none" }} />
        )}
        <button
          ref={btnRef}
          id="m2-companion-btn"
          type="button"
          className="m2-btn"
          aria-label="Mochi, your guide. Open menu"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          style={{ position: "absolute", inset: 0, width: S, height: S, cursor: canDrag ? (drag ? "grabbing" : "grab") : "pointer" }}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          <div ref={faceWrapRef} style={{ width: S, height: S, transformOrigin: "50% 90%" }}>
            <MochiFace expression={expression} talk={talk} size={S} track={!drag} hop={ev.hop} />
          </div>
        </button>
        {ev.badge && !bubble && (
          <span
            aria-hidden="true"
            className="m2-badge"
            style={{ position: "absolute", top: 2, [side === "right" ? "left" : "right"]: 2, width: 12, height: 12, borderRadius: 9999, background: "#0f6e56", border: "2px solid #fff", pointerEvents: "none" }}
          />
        )}
      </div>

      {panelOpen && !drag && (
        <>
          {bubble &&
            panelBox(
              280,
              <div onClick={() => !bubbleTw.done && bubbleTw.finish()} onKeyDown={(e) => void speechHotkey(e)}>
                <SpeakerToggle style={{ position: "absolute", top: 4, right: 4 }} />
                <p className="m2-text" aria-hidden="true" style={{ fontSize: 15, lineHeight: "22px", fontWeight: 500, paddingRight: voiceState.supported ? 22 : 0 }}>
                  <span className="m2-ghost">{bubble.text}</span>
                  <span className="m2-typed">{bubbleTw.shown}</span>
                </p>
                {bubble.actions && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                    {bubble.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className={`btn btn-sm ${a.primary ? "btn-primary" : "btn-ghost"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          ev.closeBubble();
                          a.run();
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>,
              undefined,
              undefined,
            )}

          {menu &&
            panelBox(
              260,
              <div id={menuId} role="menu" aria-labelledby="m2-companion-btn" onKeyDown={onMenuKey} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {mainItems.map((it) => {
                  const k = itemIndex++;
                  return (
                    <button
                      key={it.id}
                      ref={(el) => {
                        menuItems.current[k] = el;
                      }}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="m2-menuitem"
                      style={{ minHeight: mobile ? 48 : undefined }}
                      onClick={it.run}
                    >
                      {it.label}
                    </button>
                  );
                })}
                <div role="none" style={{ borderTop: "2px solid rgba(13,27,42,.15)", margin: "6px 0 2px", paddingTop: 4, display: "flex", flexDirection: "column", gap: 0 }}>
                  {footItems.map((it) => {
                    const k = itemIndex++;
                    return (
                      <button
                        key={it.id}
                        ref={(el) => {
                          menuItems.current[k] = el;
                        }}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className="m2-menuitem m2-menuitem-foot"
                        style={{ fontSize: 13, lineHeight: "18px", fontWeight: 500, minHeight: mobile ? 44 : undefined, paddingTop: 5, paddingBottom: 5 }}
                        onClick={it.run}
                      >
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              </div>,
            )}

          {chat &&
            panelBox(
              "min(380px, calc(100vw - 32px))",
              <div
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeMenu();
                  } else speechHotkey(e);
                }}
              >
                <button
                  type="button"
                  className="m2-link"
                  aria-label="Close chat"
                  onClick={() => closeMenu()}
                  style={{ position: "absolute", top: 6, right: 10, fontSize: 18, lineHeight: "18px", padding: 6 }}
                >
                  ×
                </button>
                <div
                  ref={chatScrollRef}
                  onScroll={onChatScroll}
                  onWheel={(e) => {
                    if (e.deltaY < 0) follow.current.on = false;
                  }}
                  data-m2-chat-scroll=""
                  style={{ minHeight: 44, maxHeight: mobile ? "38vh" : 260, overflowY: "auto", fontSize: 15, lineHeight: "22px", paddingRight: 4 }}
                >
                  {asking ? (
                    <p style={{ margin: 0 }}>
                      {REACTIONS.chatThinking}{" "}
                      <span className="m2-ellipsis" aria-hidden="true">
                        <span>.</span>
                        <span>.</span>
                        <span>.</span>
                      </span>
                    </p>
                  ) : chatErr ? (
                    <p style={{ margin: 0 }}>{chatErr}</p>
                  ) : reply ? (
                    <>
                      <p className="m2-text" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        <span className="m2-ghost">{reply.text}</span>
                        <span className="m2-typed">
                          {replyTw.shown}
                          <span ref={caretRef} aria-hidden="true" />
                        </span>
                      </p>
                      {replyTw.done && reply.actions.length > 0 && (
                        <div data-m2-chat-actions="" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                          {reply.actions.map((a) => (
                            <Link key={a.path} href={a.path} className="btn btn-primary btn-sm" onClick={() => setChat(false)}>
                              {a.label}
                            </Link>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p style={{ margin: 0 }}>{REACTIONS.chatHello}</p>
                  )}
                </div>
                {!asking && !reply && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                    {REACTIONS.chatSuggestions.map((s) => (
                      <button key={s} type="button" className="m2-chip" onClick={() => void send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                <form
                  style={{ display: "flex", gap: 8, marginTop: 12 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(draft);
                  }}
                >
                  <label htmlFor="m2-chat-input" className="sr-only">
                    Ask Mochi
                  </label>
                  <input
                    ref={chatInputRef}
                    id="m2-chat-input"
                    className="m2-input"
                    style={{ flex: 1, fontSize: 16 }}
                    value={draft}
                    placeholder={REACTIONS.chatPlaceholder}
                    onChange={(e) => setDraft(e.target.value)}
                    autoComplete="off"
                  />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={asking || !draft.trim()}>
                    Send
                  </button>
                </form>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
                  <Link href="/help" className="m2-link" style={{ display: "inline-block", fontSize: 13 }} onClick={() => setChat(false)}>
                    {REACTIONS.chatContinue}
                  </Link>
                  <SpeakerToggle style={{ marginRight: -4 }} />
                </div>
              </div>,
              undefined,
              { role: "dialog", label: "Ask Mochi" },
            )}
        </>
      )}
    </>
  );
}
