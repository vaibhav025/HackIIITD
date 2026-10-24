import { useSyncExternalStore } from "react";

export const PLATFORM_LABEL: Record<string, string> = {
  blinkit: "Blinkit",
  zepto: "Zepto",
  instamart: "Instamart",
  amazon: "Amazon",
  flipkart: "Flipkart",
};

export const platformLabel = (p: string | null | undefined) => (p ? PLATFORM_LABEL[p] ?? p : "All platforms");

export function rupees(v: number | null | undefined, digits = 0) {
  if (v == null) return "—";
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const FREQUENCY_LABEL: Record<string, string> = {
  "3h": "Every 3 hours",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  daily: "Daily",
  weekly: "Weekly",
};

export const ALERT_KIND_LABEL: Record<string, string> = {
  oos_any: "Out of stock",
  oos_area: "Out of stock in an area",
  rival_oos: "Rival out of stock",
  price_change_pct: "Price change",
  price_gap_pct: "Price gap",
  price_gap: "Price gap",
  rating_below: "Rating drop",
  rating_drop: "Rating drop",
  custom: "Custom rule",
};

export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

// ---- Display time zone ------------------------------------------------------
// Dates render in the user's chosen IANA zone (Settings → Timezone) rather than the browser's.
// Settings calls `setDisplayTimeZone(me.profile.timezone)`; components re-render via `useDisplayTimeZone()`.

const TZ_KEY = "shelfsense.tz";
let displayTimeZone: string | undefined;
const tzListeners = new Set<() => void>();

function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  try {
    const saved = window.localStorage.getItem(TZ_KEY);
    if (saved && isValidTimeZone(saved)) displayTimeZone = saved;
  } catch {}
}

/** Sets the zone every formatter below uses; null/invalid falls back to the browser zone. */
export function setDisplayTimeZone(tz: string | null | undefined) {
  const next = tz && isValidTimeZone(tz) ? tz : undefined;
  if (next === displayTimeZone) return;
  displayTimeZone = next;
  try {
    if (next) window.localStorage.setItem(TZ_KEY, next);
    else window.localStorage.removeItem(TZ_KEY);
  } catch {}
  tzListeners.forEach((l) => l());
}

export const getDisplayTimeZone = () => displayTimeZone;

export function subscribeDisplayTimeZone(listener: () => void) {
  tzListeners.add(listener);
  return () => {
    tzListeners.delete(listener);
  };
}

/** Re-renders the caller when the display zone changes; returns the zone (undefined = browser). */
export function useDisplayTimeZone() {
  return useSyncExternalStore(subscribeDisplayTimeZone, getDisplayTimeZone, () => undefined);
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Locale-formatted date/time in the display zone. */
export function formatInZone(
  v: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions,
  fallback = "—",
) {
  const d = toDate(v);
  if (!d) return fallback;
  try {
    return new Intl.DateTimeFormat("en-IN", { ...opts, timeZone: displayTimeZone }).format(d);
  } catch {
    return d.toLocaleString("en-IN", opts);
  }
}

/** "18 Oct 2026" */
export const formatDate = (v: string | number | Date | null | undefined) =>
  formatInZone(v, { day: "numeric", month: "short", year: "numeric" });

/** "2:05 pm" */
export const formatTime = (v: string | number | Date | null | undefined) =>
  formatInZone(v, { hour: "numeric", minute: "2-digit" });

/** "18 Oct, 2:05 pm" */
export const formatDateTime = (v: string | number | Date | null | undefined) =>
  formatInZone(v, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** "1.4s", "820ms", "2m 05s" — agent step and run durations. */
export function duration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/** Rupees with paise when the amount isn't whole (small price gaps like ₹0.50). */
export function rupeesPrecise(v: number | null | undefined) {
  if (v == null) return "—";
  return rupees(v, Math.abs(v - Math.round(v)) > 0.004 ? 2 : 0);
}

/** Delivery estimate: minutes for quick commerce ("12m"), days for marketplaces ("3d"). */
export function etaLabel(minutes: number | null | undefined) {
  if (minutes == null) return "";
  if (minutes < 120) return `${minutes}m`;
  const days = Math.max(1, Math.round(minutes / 1440));
  return `${days}d`;
}
