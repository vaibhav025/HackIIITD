"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Mochi's persisted preferences: a tiny external store (like the toast module) backed by
 * localStorage, kept in sync across tabs through the `storage` event. Storage failures fall back
 * to in-memory state. Also home to the small DOM helpers the Mochi components share.
 */

export interface MochiPrefs {
  v: 2;
  intro: "pending" | "done";
  /** Optional, max 24 chars, trimmed, never sent anywhere. */
  name: string | null;
  goal: "tour" | "solo" | null;
  tour: { status: "none" | "active" | "paused" | "done"; stepId: string | null; productId: string | null };
  /** y = 0..1 fraction of viewport height. */
  dock: { side: "left" | "right"; y: number };
  /** No unprompted bubbles (expressions still react). */
  quiet: boolean;
  hidden: boolean;
  /** Page-intro keys already shown. */
  seen: string[];
  /** Retired typewriter blip sound effects; kept so saved prefs still parse. Not read anywhere. */
  voice: boolean;
  /** Mochi speaks its lines aloud (Web Speech API, see ./voice.ts). On by default. */
  speech: boolean;
}

export const PREFS_KEY = "shelfsense.mochi.v2";
export const SESSION_KEY = "shelfsense.mochi.session";

export const DEFAULT_PREFS: MochiPrefs = {
  v: 2,
  intro: "pending",
  name: null,
  goal: null,
  tour: { status: "none", stepId: null, productId: null },
  dock: { side: "right", y: 0.72 },
  quiet: false,
  hidden: false,
  seen: [],
  voice: false,
  speech: true,
};

let state: MochiPrefs = DEFAULT_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

function parse(raw: string | null): MochiPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<MochiPrefs>;
    if (!p || p.v !== 2) return DEFAULT_PREFS;
    return {
      ...DEFAULT_PREFS,
      ...p,
      tour: { ...DEFAULT_PREFS.tour, ...(p.tour ?? {}) },
      dock: { ...DEFAULT_PREFS.dock, ...(p.dock ?? {}) },
      seen: Array.isArray(p.seen) ? p.seen.filter((s) => typeof s === "string") : [],
      speech: typeof p.speech === "boolean" ? p.speech : DEFAULT_PREFS.speech,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function load() {
  loaded = true;
  try {
    state = parse(window.localStorage.getItem(PREFS_KEY));
  } catch {
    state = DEFAULT_PREFS;
  }
}

export function getPrefs(): MochiPrefs {
  if (!loaded && typeof window !== "undefined") load();
  return state;
}

export function setPrefs(patch: Partial<MochiPrefs> | ((p: MochiPrefs) => Partial<MochiPrefs>)) {
  const cur = getPrefs();
  const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
  state = next;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: lasts until reload */
  }
  listeners.forEach((l) => l());
}

function onStorage(e: StorageEvent) {
  if (e.key !== PREFS_KEY) return;
  state = parse(e.newValue);
  listeners.forEach((l) => l());
}

export function subscribePrefs(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

export function usePrefs(): MochiPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFS);
}

export function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function sessionSet(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- DOM helpers */

export function useMedia(query: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

export const MOBILE_QUERY = "(max-width: 640px)";
export const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
export const FINE_QUERY = "(hover: hover) and (pointer: fine)";
export const isReduced = () => typeof window !== "undefined" && window.matchMedia(REDUCED_QUERY).matches;

/** Bottom edge of the sticky/fixed page header (Mochi stays below it). */
export function topInset() {
  let bottom = 0;
  document.querySelectorAll("header").forEach((h) => {
    const pos = getComputedStyle(h).position;
    if (pos !== "sticky" && pos !== "fixed") return;
    const r = h.getBoundingClientRect();
    if (r.top <= 1 && r.height > 0) bottom = Math.max(bottom, r.bottom);
  });
  return bottom;
}

/** Width of the visible desktop sidebar (AppShell's sticky aside), else 0. */
export function leftInset() {
  const aside = document.querySelector("aside");
  if (!aside) return 0;
  const r = aside.getBoundingClientRect();
  if (r.width < 100 || r.left > 1 || getComputedStyle(aside).visibility === "hidden") return 0;
  return r.right;
}

/** A dialog that isn't Mochi's own (AddProduct, mobile search, agent modal…). */
export function foreignModal(): Element | null {
  const list = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  for (const el of Array.from(list)) if (!el.closest("[data-m2]")) return el;
  return null;
}

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="tab"], [role="option"], [tabindex]:not([tabindex="-1"])';

export type Box = { l: number; t: number; r: number; b: number };

/** On-screen rects of controls Mochi should never cover. */
export function obstacles(): Box[] {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const out: Box[] = [];
  document.querySelectorAll(INTERACTIVE).forEach((el) => {
    if (el.closest("[data-m2]") || el.closest("[data-toaster]")) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
    out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  });
  return out;
}

export function overlap(boxes: Box[], l: number, t: number, r: number, b: number) {
  let s = 0;
  for (const o of boxes) {
    const w = Math.min(r, o.r) - Math.max(l, o.l);
    const h = Math.min(b, o.b) - Math.max(t, o.t);
    if (w > 0 && h > 0) s += w * h;
  }
  return s;
}

/** Element is in the layout and visible (filters `hidden lg:block` wrappers). */
export function usable(el: Element | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function firstUsable(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    let list: NodeListOf<Element>;
    try {
      list = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of Array.from(list)) if (usable(el)) return el;
  }
  return null;
}

/** Resolves with the first usable element matching `selectors` (in order), or null after `ms`. */
export function waitFor(selectors: string[], ms = 8000, signal?: { cancelled: boolean }): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const found = firstUsable(selectors);
    if (found) return resolve(found);
    let raf = 0;
    let done = false;
    const finish = (el: HTMLElement | null) => {
      if (done) return;
      done = true;
      mo.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      resolve(el);
    };
    const check = () => {
      if (signal?.cancelled) return finish(null);
      const el = firstUsable(selectors);
      if (el) finish(el);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    const loop = () => {
      check();
      if (!done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setTimeout(() => finish(null), ms);
  });
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const COMPANION_SIZE = { desktop: 64, mobile: 52 };

/** Docked companion spot (before toast lift / obstacle nudges): viewport x, y and size. */
export function dockPosition(prefs: Pick<MochiPrefs, "dock">, mobile: boolean, lift = 0) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const S = mobile ? COMPANION_SIZE.mobile : COMPANION_SIZE.desktop;
  if (mobile) return { x: vw - S - 16, y: vh - S - 16 - lift, S, minY: topInset() + 12, maxY: vh - S - 16 - lift };
  const minY = topInset() + 12;
  const maxY = Math.max(minY, vh - S - 16 - lift);
  const x = prefs.dock.side === "right" ? vw - S - 16 : leftInset() + 16;
  const y = clamp(prefs.dock.y * vh, minY, maxY);
  return { x, y, S, minY, maxY };
}
