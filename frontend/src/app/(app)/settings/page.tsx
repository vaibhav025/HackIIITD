"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, downloadFile, errorMessage, useApi } from "@/lib/api";
import { AUTH_ENABLED, getSupabase, signOut } from "@/lib/auth";
import { setDisplayTimeZone } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { Health, Me, Pincode, PlanChange, PlanLimits, Plans, ProductCard, UserSettings } from "@/lib/types";
import { CardSkeleton, ErrorCard, Modal, useConfirm } from "@/components/ui";

const ASSET = "/figma/settings";

/** Section nav — icon sizes are the native SVG sizes from Figma. */
const SECTIONS = [
  { id: "profile", label: "Profile", icon: "imgNavProfile", w: 16.3388, h: 16.3388 },
  { id: "plan", label: "Plan & billing", icon: "imgNavPlan", w: 16.3388, h: 12.3388 },
  { id: "notifications", label: "Notifications", icon: "imgNavNotifications", w: 12.3388, h: 16.3936 },
  { id: "telegram", label: "Telegram", icon: "imgNavTelegram", w: 15.3537, h: 12.3188 },
  { id: "region", label: "Region", icon: "imgNavRegion", w: 16.3388, h: 16.3388 },
  { id: "security", label: "Security", icon: "imgNavSecurity", w: 12.3388, h: 17.284 },
  { id: "data", label: "Data & privacy", icon: "imgNavData", w: 13.3388, h: 16.3487 },
] as const;

const PLAN_COPY: Record<string, { price: string; blurb: string }> = {
  free: { price: "₹0", blurb: "Weekly refresh, Telegram alerts" },
  pro: { price: "₹999/mo", blurb: "Faster refresh, true-price checks, Telegram autopilot" },
  brand: { price: "Custom", blurb: "City-wide coverage, distributor reports, priority refresh" },
};

/** Must match `BusinessType` in backend/app/schemas/me.py (anything else is a 422). */
const BUSINESS_TYPES = [
  ["marketplace_seller", "Marketplace seller"],
  ["d2c_brand", "D2C brand on quick commerce"],
  ["brand_team", "Brand / sales team"],
] as const;

/** Common zones first; the full IANA list follows when the browser exposes it. */
const COMMON_ZONES = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"];
const ZONE_LABEL: Record<string, string> = { "Asia/Kolkata": "IST · Asia/Kolkata (UTC+5:30)", UTC: "UTC" };

function timeZoneOptions(current: string): (readonly [string, string])[] {
  let all: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    all = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {}
  const zones = Array.from(new Set([...COMMON_ZONES, ...(current ? [current] : []), ...all]));
  return zones.map((z) => [z, ZONE_LABEL[z] ?? z.replace(/_/g, " ")] as const);
}

/** Quiet-hour presets → quiet_hours_start / quiet_hours_end. Empty = off. */
const QUIET_PRESETS: [string, string][] = [
  ["", ""],
  ["21:00", "07:00"],
  ["22:00", "07:00"],
  ["22:00", "08:00"],
  ["23:00", "06:00"],
  ["23:00", "07:00"],
  ["00:00", "07:00"],
];

const BRIEFING_TIMES = Array.from({ length: 15 }, (_, i) => {
  const mins = 5 * 60 + i * 30;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
});

function clock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}
const briefingLabel = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const quietLabel = (s: string, e: string) => (s && e ? `${clock(s)} to ${clock(e)}` : "Off");

function initials(name: string | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/* ---------- Draft state (everything the save bar covers) ---------- */

type Draft = {
  name: string;
  business_name: string;
  business_type: string;
  timezone: string;
  default_city: string;
  briefing_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  telegram: boolean;
};
const PROFILE_KEYS = ["name", "business_name", "business_type", "timezone", "default_city"] as const;
const SETTINGS_KEYS = ["briefing_time", "quiet_hours_start", "quiet_hours_end", "telegram"] as const;

function toDraft(me: Me, s: UserSettings): Draft {
  const ch = (s.channels ?? {}) as Record<string, unknown>;
  return {
    name: me.profile.name ?? "",
    business_name: me.profile.business_name ?? "",
    business_type: me.profile.business_type ?? "marketplace_seller",
    timezone: me.profile.timezone ?? "Asia/Kolkata",
    default_city: me.profile.default_city ?? "",
    briefing_time: s.briefing_time ?? "09:00",
    quiet_hours_start: s.quiet_hours_start ?? "",
    quiet_hours_end: s.quiet_hours_end ?? "",
    // Alert delivery treats a missing flag as on (services/alerts.py), so the switch does too.
    telegram: ch.telegram !== false,
  };
}

/* ---------- Small design primitives (page-local) ---------- */

/** Recolourable icon: the Figma SVG used as a mask so the active nav item can turn linen. */
function MaskIcon({ name, w, h }: { name: string; w: number; h: number }) {
  const url = `url(${ASSET}/${name}.svg)`;
  return (
    <span
      aria-hidden
      className="shrink-0 bg-current"
      style={{ width: w, height: h, maskImage: url, WebkitMaskImage: url, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat" }}
    />
  );
}

/** Hover/focus tooltip explaining a fixed or unavailable control. */
function Tip({ tip, children, className = "" }: { tip: string; children: ReactNode; className?: string }) {
  return (
    <span className={`relative inline-flex group ${className}`} title={tip} tabIndex={0} aria-label={tip}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-[240px] -translate-x-1/2 rounded-[8px] bg-ink px-3 py-1.5 text-center text-[12px] font-semibold leading-4 text-linen group-hover:block group-focus:block"
      >
        {tip}
      </span>
    </span>
  );
}

function Card({ id, title, tight, children }: { id: string; title: string; tight?: boolean; children: ReactNode }) {
  return (
    <section id={id} data-section className="card w-full p-5 sm:p-[26px] scroll-mt-[96px]">
      <h2 className={`text-[28px] sm:text-[32px] leading-[40px] text-ink ${tight ? "pb-4" : "pb-6"}`}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-2 min-w-0">
      <span className="text-[14px] leading-5 font-semibold text-ink">
        {label}
        {hint ? <span className="ml-2 font-medium text-ink/75">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const INPUT = "input h-12 px-[18px] py-0 text-[16px] font-normal leading-6";

function Select({
  value,
  onChange,
  options,
  className = "",
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange?: (v: string) => void;
  options: readonly (readonly [string, string])[];
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        aria-label={ariaLabel}
        className={`${INPUT} appearance-none pr-[42px] cursor-pointer disabled:cursor-not-allowed`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <img
        src={`${ASSET}/imgChevron.svg`}
        alt=""
        width={10.3188}
        height={6.38135}
        className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2"
      />
    </div>
  );
}

/** 52×28 switch from the design (slate track + linen knob on; linen track + ink knob off). */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative h-[28px] w-[52px] shrink-0 rounded-full border-2 border-ink transition-colors before:absolute before:-inset-[7px] before:content-[''] disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "bg-slate" : "bg-linen"}`}
    >
      <span
        className={`absolute left-[3px] top-1/2 -translate-y-1/2 size-[20px] rounded-full transition-[translate,background-color] duration-200 ease-out ${checked ? "translate-x-[24px] bg-linen border border-ink" : "bg-ink"}`}
      />
    </button>
  );
}

function Row({ label, children, last }: { label: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4 ${last ? "" : "border-b border-ink/20"}`}>
      <div className="flex flex-wrap items-center gap-3 text-[16px] leading-6 font-semibold text-ink min-w-0">{label}</div>
      {children}
    </div>
  );
}

function UsageBar({ label, value, max }: { label: string; value: number; max: number | null | undefined }) {
  const ratio = max ? Math.min(1, value / max) : null;
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex justify-between text-[14px] leading-5 font-semibold text-linen">
        <span>{label}</span>
        <span>{max ? `${value}/${max}` : max === null && label !== "Checks this week" ? `${value} · unlimited` : value}</span>
      </div>
      <div className="h-[10px] rounded-full bg-deep overflow-hidden">
        {ratio !== null ? <div className="h-full rounded-full bg-sand transition-[width] duration-500" style={{ width: `${ratio * 100}%` }} /> : null}
      </div>
    </div>
  );
}

function StatusPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex h-9 items-center gap-[6px] rounded-[12px] border-2 border-ink bg-sage px-[14px] text-[14px] leading-5 font-semibold text-ink">
      <img src={`${ASSET}/imgCheck.svg`} alt="" width={9.75508} height={7.35906} />
      Connected
    </span>
  ) : (
    <span className="inline-flex h-9 items-center rounded-[12px] border-2 border-ink bg-sand px-[14px] text-[14px] leading-5 font-semibold text-ink">
      Not connected
    </span>
  );
}

/* ---------- Telegram: derive personal / group chats from per-product status ---------- */

/** One chat linked to one product (`TelegramChatLink` in GET /products/{id}/telegram/status). */
type TgLink = { id: string; chat_id: string; chat_title: string | null };
type TgStatus = { links: TgLink[] };
const isGroupChat = (chatId: string) => chatId.startsWith("-") || chatId.includes("group");

function useTelegramChats(products: ProductCard[] | undefined) {
  const [byProduct, setByProduct] = useState<Record<string, TgLink[]> | null>(null);
  const load = useCallback(async () => {
    if (!products) return;
    const connected = products.filter((p) => p.telegram_connected);
    const entries = await Promise.all(
      connected.map(async (p) => {
        try {
          const s = await api<TgStatus>(`/products/${p.id}/telegram/status`);
          return [p.id, s.links] as const;
        } catch {
          return [p.id, [] as TgLink[]] as const;
        }
      }),
    );
    setByProduct(Object.fromEntries(entries));
  }, [products]);
  useEffect(() => {
    void load();
  }, [load]);
  return { byProduct, reload: load };
}

/* ---------- Page ---------- */

export default function SettingsPage() {
  const me = useApi<Me>("/me");
  const plans = useApi<Plans>("/plans");
  const settings = useApi<UserSettings>("/me/settings");
  const products = useApi<ProductCard[]>("/products");
  const health = useApi<Health>("/health");
  const pincodes = useApi<Pincode[]>("/pincodes");
  const tg = useTelegramChats(products.data);

  const baseline = useMemo(() => (me.data && settings.data ? toDraft(me.data, settings.data) : null), [me.data, settings.data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanChange | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [confirmUi, confirm] = useConfirm();
  const [active, setActive] = useState<string>("profile");
  const spyLock = useRef(0); // ignore scroll-spy briefly after a nav click

  useEffect(() => {
    if (baseline) setDraft(baseline);
  }, [baseline]);

  // Dates across the app render in the saved time zone.
  const savedTz = me.data?.profile.timezone;
  useEffect(() => {
    if (savedTz) setDisplayTimeZone(savedTz);
  }, [savedTz]);

  const dirty = !!(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Scroll-spy: the last section whose top has passed below the sticky header.
  const ready = !!draft;

  // Deep links (/settings#plan, #telegram) arrive while the skeleton is showing, so the browser
  // can't scroll to them. Once the sections exist, scroll to the hash ourselves.
  useEffect(() => {
    if (!ready) return;
    const scrollToHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      spyLock.current = Date.now() + 1000;
      setActive(id);
      el.scrollIntoView({ block: "start" });
    };
    const frame = requestAnimationFrame(scrollToHash);
    window.addEventListener("hashchange", scrollToHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", scrollToHash);
    };
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const onScroll = () => {
      if (Date.now() < spyLock.current) return;
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("section[data-section]"));
      let current = nodes[0]?.id ?? "profile";
      for (const n of nodes) if (n.getBoundingClientRect().top <= 140) current = n.id;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = nodes[nodes.length - 1]?.id ?? current;
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ready]);

  if (me.error && !me.data) return <ErrorCard error={me.error} onRetry={() => me.mutate()} />;
  if (settings.error && !settings.data) return <ErrorCard error={settings.error} onRetry={() => settings.mutate()} />;
  if (!me.data || !settings.data || !draft || !baseline) return <CardSkeleton rows={8} />;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setNotice(null);
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  };

  async function saveAll() {
    if (!draft || !baseline) return;
    if (!draft.name.trim()) {
      setNotice({ kind: "err", text: "Name can't be empty." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const profilePatch = Object.fromEntries(
        PROFILE_KEYS.filter((k) => draft[k] !== baseline[k]).map((k) => [k, k === "business_name" || k === "default_city" ? draft[k] || null : draft[k]]),
      );
      const settingsChanged = SETTINGS_KEYS.some((k) => draft[k] !== baseline[k]);
      const jobs: Promise<unknown>[] = [];
      if (Object.keys(profilePatch).length) jobs.push(api("/me", { method: "PATCH", json: profilePatch }));
      if (settingsChanged)
        jobs.push(
          api("/me/settings", {
            method: "PATCH",
            json: {
              briefing_time: draft.briefing_time,
              quiet_hours_start: draft.quiet_hours_start || null,
              quiet_hours_end: draft.quiet_hours_end || null,
              // Other channel flags (e.g. a legacy `email`) are kept as they are.
              channels: { ...((settings.data?.channels ?? {}) as Record<string, unknown>), telegram: draft.telegram },
            },
          }),
        );
      await Promise.all(jobs);
      await Promise.all([me.mutate(), settings.mutate()]);
      if (draft.timezone !== baseline.timezone) setDisplayTimeZone(draft.timezone);
      setNotice({ kind: "ok", text: "All changes saved" });
      toast("Settings saved");
    } catch (e) {
      const text = errorMessage(e, "Couldn't save changes");
      setNotice({ kind: "err", text });
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function switchPlan(plan: string) {
    if (planBusy) return;
    setPlanBusy(plan);
    try {
      const r = await api<PlanChange>("/me/plan", { method: "POST", json: { plan } });
      await Promise.all([me.mutate(), plans.mutate(), products.mutate()]);
      setPlanOpen(false);
      setPlanResult(r);
      const notes: string[] = [];
      if (r.adjusted_products) notes.push(`${r.adjusted_products} product${r.adjusted_products === 1 ? "" : "s"} moved to a slower check schedule`);
      if (r.paused_products) notes.push(`${r.paused_products} product${r.paused_products === 1 ? "" : "s"} paused to fit the plan`);
      if (r.over_limit?.length) notes.push(`${r.over_limit.length} product${r.over_limit.length === 1 ? "" : "s"} over the new limits`);
      toast(`Switched to ${plan} (test mode)${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
    } catch (e) {
      toast.error(
        e instanceof ApiError && (e.status === 403 || e.status === 409)
          ? `${e.message || "Plan changes are only available in test mode"}`
          : errorMessage(e, "Couldn't change plan"),
      );
    } finally {
      setPlanBusy(null);
    }
  }

  const plan = me.data.plan;
  const limits: PlanLimits | undefined = plans.data?.plans.find((p) => p.plan === plan);
  const usage = me.data.usage;
  // Production refuses POST /me/plan: plans change through billing there.
  const liveBilling = health.data?.billing_mode === "live";

  // Option lists that always include the saved value.
  const briefingOpts = Array.from(new Set([...BRIEFING_TIMES, draft.briefing_time])).sort().map((t) => [t, briefingLabel(t)] as const);
  const quietKey = `${draft.quiet_hours_start}|${draft.quiet_hours_end}`;
  const quietOpts = [...QUIET_PRESETS];
  if (!quietOpts.some(([s, e]) => `${s}|${e}` === quietKey)) quietOpts.push([draft.quiet_hours_start, draft.quiet_hours_end]);
  const cities = Array.from(new Set([...(pincodes.data ?? []).map((p) => p.city), ...(draft.default_city ? [draft.default_city] : [])])).sort();
  const cityOpts = [["", "Not set"] as const, ...cities.map((c) => [c, c] as const)];
  const tzOpts = timeZoneOptions(draft.timezone);

  // Telegram chats.
  const productList = products.data ?? [];
  const chats = new Map<string, { title: string | null; group: boolean; productIds: string[] }>();
  for (const [pid, links] of Object.entries(tg.byProduct ?? {}))
    for (const l of links) {
      const c = chats.get(l.chat_id) ?? { title: l.chat_title, group: isGroupChat(l.chat_id), productIds: [] };
      c.productIds.push(pid);
      chats.set(l.chat_id, c);
    }
  const firstName = draft.name.trim().split(/\s+/)[0] || "Your";
  const personal = [...chats.entries()].filter(([, c]) => !c.group);
  const groups = [...chats.entries()].filter(([, c]) => c.group);
  const connectHref = (wantGroup: boolean) => {
    const target =
      productList.find((p) => !(tg.byProduct?.[p.id] ?? []).some((l) => isGroupChat(l.chat_id) === wantGroup)) ?? productList[0];
    return target ? `/products/${target.id}/telegram${wantGroup ? "?mode=group" : ""}` : "/products";
  };

  async function disconnectChat(chatId: string) {
    const chat = chats.get(chatId);
    if (!chat || !tg.byProduct) return;
    // Every product this chat is linked to, with that product's link id for this chat.
    const targets = chat.productIds.flatMap((pid) =>
      (tg.byProduct![pid] ?? []).filter((l) => l.chat_id === chatId).map((l) => ({ pid, linkId: l.id })),
    );
    const names = chat.productIds.map((pid) => productList.find((x) => x.id === pid)?.name).filter(Boolean) as string[];
    const ok = await confirm({
      title: `Disconnect "${chat.title ?? "this chat"}"?`,
      body: (
        <>
          It stops getting alerts for {names.length === 1 ? names[0] : `all ${targets.length} products it's linked to`}. Other chats stay connected.
        </>
      ),
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy(`tg-${chatId}`);
    try {
      const results = await Promise.allSettled(
        targets.map((t) => api(`/products/${encodeURIComponent(t.pid)}/telegram/links/${encodeURIComponent(t.linkId)}`, { method: "DELETE" })),
      );
      // A link that's already gone (404) counts as disconnected.
      const failed = results.filter((r) => r.status === "rejected" && !(r.reason instanceof ApiError && r.reason.status === 404));
      await products.mutate();
      await tg.reload();
      if (failed.length) {
        const reason = (failed[0] as PromiseRejectedResult).reason;
        toast.error(`Disconnected from ${targets.length - failed.length} of ${targets.length} products · ${errorMessage(reason, "try again")}`);
      } else {
        toast("Chat disconnected");
      }
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't disconnect"));
    } finally {
      setBusy(null);
    }
  }

  const chatRows: { key: string; label: string; connected: boolean; count?: number; chatId?: string; group: boolean }[] = [
    ...(personal.length
      ? personal.map(([id, c]) => ({ key: id, label: c.title ?? `${firstName}'s personal chat`, connected: true, count: c.productIds.length, chatId: id, group: false }))
      : [{ key: "personal", label: `${firstName === "Your" ? "Your" : `${firstName}'s`} personal chat`, connected: false, group: false }]),
    ...(groups.length
      ? groups.map(([id, c]) => ({ key: id, label: c.title ?? "Team group", connected: true, count: c.productIds.length, chatId: id, group: true }))
      : [{ key: "group", label: "Team group", connected: false, group: true }]),
  ];

  const devAuth = health.data ? (health.data.auth_mode ? health.data.auth_mode === "dev" : !!health.data.integrations.dev_auth) : false;

  async function exportData(format: "csv" | "json") {
    if (busy) return;
    setBusy(`export-${format}`);
    try {
      await downloadFile(`/me/export${format === "json" ? "?format=json" : ""}`, `shelfsense-export.${format}`);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't export your data"));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount() {
    if (devAuth) return;
    const ok = await confirm({
      title: "Delete your account?",
      body: "Every product, check, alert and Telegram link is removed. This cannot be undone.",
      confirmLabel: "Delete account",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api("/me", { method: "DELETE" });
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't delete account"));
      setBusy(null);
      return;
    }
    toast("Account deleted");
    // The ShelfSense data is gone; end the sign-in session too, or the next request would
    // silently provision a fresh, empty account for the same login.
    if (AUTH_ENABLED) {
      await signOut().catch(() => window.location.assign("/login"));
    } else {
      window.location.href = "/";
    }
  }

  return (
    <div className="w-full max-w-[940px] min-w-0">
      {/* Page header */}
      <header className="flex flex-col gap-2 pb-8 lg:pb-10">
        <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px] text-ink">Settings</h1>
        <p className="text-[16px] leading-6 text-ink">Manage your profile, plan and alerts.</p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
        {/* Section nav: sticky column on desktop, scrollable strip on mobile */}
        <nav
          aria-label="Settings sections"
          className="sticky top-[72px] z-10 -mx-4 bg-linen px-4 py-3 lg:col-span-3 lg:top-[96px] lg:mx-0 lg:self-start lg:bg-transparent lg:p-0"
        >
          <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {SECTIONS.map((s) => {
              const on = active === s.id;
              return (
                <li key={s.id} className="shrink-0">
                  <a
                    href={`#${s.id}`}
                    aria-current={on ? "true" : undefined}
                    onClick={() => {
                      spyLock.current = Date.now() + 1000;
                      setActive(s.id);
                    }}
                    className={`flex h-12 items-center gap-3 rounded-[12px] border-2 text-[16px] leading-6 whitespace-nowrap transition-colors ${
                      on
                        ? "border-ink bg-slate px-[18px] font-semibold text-linen shadow-[4px_4px_0_var(--ink)]"
                        : "border-transparent px-4 font-medium text-ink hover:bg-ink/5"
                    }`}
                  >
                    <MaskIcon name={s.icon} w={s.w} h={s.h} />
                    {s.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-8 lg:col-span-9">
          {/* 1. Profile */}
          <Card id="profile" title="Profile">
            <div className="flex flex-wrap items-center gap-6 pb-6">
              <div className="flex size-[72px] items-center justify-center rounded-full border-2 border-ink bg-sand shadow-[2px_2px_0_var(--ink)]" aria-hidden>
                <span className="font-display text-[24px] leading-8 text-ink">{initials(draft.name)}</span>
              </div>
              <p className="text-[14px] leading-5 text-ink/80">Your initials appear on the sidebar and top bar.</p>
            </div>
            <div className="grid grid-cols-1 gap-6 pb-6 sm:grid-cols-2">
              <Field label="Name">
                <input className={INPUT} value={draft.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" maxLength={200} />
              </Field>
              <Field label="Business name">
                <input
                  className={INPUT}
                  value={draft.business_name}
                  onChange={(e) => set("business_name", e.target.value)}
                  autoComplete="organization"
                  maxLength={200}
                />
              </Field>
              <Field label="Email" hint={devAuth ? "Demo account" : "Your sign-in email"}>
                <input className={`${INPUT} cursor-not-allowed text-ink/70`} value={me.data.profile.email} readOnly title="Your sign-in email can't be changed here" />
              </Field>
              <Field label="Business type">
                <Select
                  value={draft.business_type}
                  onChange={(v) => set("business_type", v)}
                  options={
                    BUSINESS_TYPES.some(([v]) => v === draft.business_type)
                      ? BUSINESS_TYPES
                      : [...BUSINESS_TYPES, [draft.business_type, draft.business_type.replace(/_/g, " ")] as const]
                  }
                />
              </Field>
            </div>
          </Card>

          {/* 2. Plan & billing */}
          <Card id="plan" title="Plan & billing">
            <div className="rounded-[20px] bg-ink p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-ink bg-sand px-[13px] py-[5px] text-[14px] leading-5 font-bold tracking-[0.35px] text-ink uppercase">{plan}</span>
                  <span className="font-display text-[22px] sm:text-[24px] leading-8 text-linen capitalize">ShelfSense {plan} Plan</span>
                </div>
                {!liveBilling && <span className="text-[16px] leading-6 font-semibold text-sand">Test mode</span>}
              </div>
              <div className="flex flex-col gap-4">
                <UsageBar label="Products" value={usage.products} max={limits?.products} />
                {/* Pincode and competitor limits are per product: show the busiest product. */}
                <UsageBar label="Pincodes (busiest product)" value={usage.max_pincodes_per_product ?? usage.pincodes} max={limits?.pincodes} />
                {limits?.competitors != null && (
                  <UsageBar label="Competitors (busiest product)" value={usage.max_competitors_per_product ?? 0} max={limits.competitors} />
                )}
                <UsageBar label="Checks this week" value={usage.checks_this_week} max={undefined} />
              </div>
              <p className="pt-4 text-[13px] leading-5 text-linen/80">
                {usage.pincodes} distinct pincode{usage.pincodes === 1 ? "" : "s"} tracked across all products.
              </p>
            </div>
            {planResult?.over_limit?.length ? (
              <div role="status" className="mt-6 rounded-[16px] border-2 border-ink bg-sand p-4 text-[14px] leading-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">
                    {planResult.over_limit.length} product{planResult.over_limit.length === 1 ? " tracks" : "s track"} more than the {planResult.plan} plan
                    allows. Nothing was deleted — trim them to keep checks within your plan.
                  </p>
                  <button type="button" className="text-[13px] font-semibold underline shrink-0" onClick={() => setPlanResult(null)}>
                    Dismiss
                  </button>
                </div>
                <ul className="mt-3 flex flex-col gap-2">
                  {planResult.over_limit.map((p) => (
                    <li key={p.product_id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-semibold">{p.name}</span>
                        {p.pincode_limit != null && p.pincodes > p.pincode_limit ? ` · ${p.pincodes}/${p.pincode_limit} pincodes` : ""}
                        {p.competitors > p.competitor_limit ? ` · ${p.competitors}/${p.competitor_limit} competitors` : ""}
                      </span>
                      <Link href={`/products/${p.product_id}/settings`} className="font-semibold text-slate underline underline-offset-2">
                        Edit product
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {liveBilling ? (
              <p className="pt-6 text-[14px] leading-5 text-ink">
                Plan changes go through billing on this server. Contact your ShelfSense account manager to upgrade or downgrade.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-4 pt-6 pb-4">
                  <button type="button" className="btn btn-primary h-12 py-0 px-[26px]" onClick={() => setPlanOpen(true)}>
                    Change plan
                  </button>
                </div>
                <p className="text-[14px] leading-5 text-ink">Payments are in test mode for the demo: plan changes apply instantly and nothing is charged.</p>
              </>
            )}
          </Card>

          {/* 3. Notifications */}
          <Card id="notifications" title="Notifications" tight>
            <Row label="Daily briefing time">
              <Select ariaLabel="Daily briefing time" className="w-[176px]" value={draft.briefing_time} onChange={(v) => set("briefing_time", v)} options={briefingOpts} />
            </Row>
            <Row label="Quiet hours">
              <Select
                ariaLabel="Quiet hours"
                className="w-[192px]"
                value={quietKey}
                onChange={(v) => {
                  const [s, e] = v.split("|");
                  setNotice(null);
                  setDraft((d) => (d ? { ...d, quiet_hours_start: s, quiet_hours_end: e } : d));
                }}
                options={quietOpts.map(([s, e]) => [`${s}|${e}`, quietLabel(s, e)] as const)}
              />
            </Row>
            <Row label="Telegram alerts" last>
              <Switch label="Telegram alerts" checked={draft.telegram} onChange={(v) => set("telegram", v)} />
            </Row>
            <p className="pt-2 text-[14px] leading-5 text-ink/80">
              Turning Telegram alerts off pauses alert messages to every linked chat. Alerts still appear in the bell and on the{" "}
              <Link href="/alerts" className="font-semibold underline underline-offset-2">
                Alerts page
              </Link>
              .
            </p>
          </Card>

          {/* 4. Telegram */}
          <Card id="telegram" title="Telegram" tight>
            {chatRows.map((r, i) => (
              <Row
                key={r.key}
                last={i === chatRows.length - 1}
                label={
                  <>
                    <span>{r.label}</span>
                    <StatusPill connected={r.connected} />
                    {r.count ? (
                      <span className="text-[14px] leading-5 font-medium text-ink/80">
                        {r.count} product{r.count === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </>
                }
              >
                {r.connected && r.chatId ? (
                  <button type="button" className="btn btn-ghost h-12 py-0" disabled={busy === `tg-${r.chatId}`} onClick={() => disconnectChat(r.chatId!)}>
                    {busy === `tg-${r.chatId}` ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : (
                  <Link href={connectHref(r.group)} className="btn btn-primary h-12 py-0 px-[26px]">
                    Connect
                  </Link>
                )}
              </Row>
            ))}
            {productList.length ? (
              <details className="mt-2 text-[14px] leading-5">
                <summary className="cursor-pointer font-semibold text-slate">Per-product Telegram ({productList.filter((p) => p.telegram_connected).length}/{productList.length} connected)</summary>
                <ul className="mt-3 flex flex-col gap-2">
                  {productList.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{p.name}</span>
                      <Link href={`/products/${p.id}/telegram`} className="font-semibold text-slate underline underline-offset-2">
                        {p.telegram_connected ? "Manage" : "Connect"}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>

          {/* 5. Region */}
          <Card id="region" title="Region">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <Field label="Currency">
                <Tip tip="ShelfSense tracks Indian quick-commerce prices in rupees only." className="w-full">
                  <Select className="w-full" value="INR" options={[["INR", "₹ INR"]]} disabled ariaLabel="Currency" />
                </Tip>
              </Field>
              <Field label="Time zone">
                <Select value={draft.timezone} onChange={(v) => set("timezone", v)} options={tzOpts} />
              </Field>
              <Field label="Default city">
                <Select value={draft.default_city} onChange={(v) => set("default_city", v)} options={cityOpts} />
              </Field>
            </div>
          </Card>

          {/* 6. Security */}
          <Card id="security" title="Security" tight>
            {AUTH_ENABLED ? (
              <Row label="Password" last>
                <button type="button" className="btn btn-ghost h-12 py-0" onClick={() => setPasswordOpen(true)}>
                  Change password
                </button>
              </Row>
            ) : null}
            <p className="pt-2 text-[14px] leading-5 text-ink/80">
              {devAuth
                ? "Demo sign-in: every request uses the demo account."
                : "Signed in with Supabase. Sessions are verified on every request."}{" "}
              API keys stay on the server, and ShelfSense never logs into shopper accounts.
            </p>
          </Card>

          {/* 7. Data & privacy */}
          <Card id="data" title="Data & privacy">
            <div className="flex flex-wrap items-center gap-4 pb-6">
              <button type="button" className="btn btn-ghost h-12 py-0 px-[26px]" disabled={!!busy} onClick={() => exportData("csv")} title="Every stock and price check, as a CSV file">
                {busy === "export-csv" ? "Exporting…" : "Export checks (CSV)"}
              </button>
              <button type="button" className="btn btn-ghost h-12 py-0 px-[26px]" disabled={!!busy} onClick={() => exportData("json")} title="Your whole account: profile, products, rules, results, alerts and chats">
                {busy === "export-json" ? "Exporting…" : "Export account (JSON)"}
              </button>
            </div>
            <p className="pb-4 text-[14px] leading-5 text-ink/80">
              Each check&apos;s screenshot link is included in the JSON export; open a product&apos;s check results to view them.
            </p>
            <div className="h-px w-full bg-ink/20 my-2" />
            <div className="flex flex-wrap items-center justify-between gap-4 pt-4">
              <div>
                <p className="text-[16px] leading-6 font-semibold text-ink">Delete account</p>
                <p className="text-[14px] leading-5 text-ink/80">
                  {devAuth
                    ? "Not available in demo mode: everyone shares the demo account. Re-run the seed script to reset it."
                    : "Removes every product, check, alert and Telegram link, then signs you out. This cannot be undone."}
                </p>
              </div>
              {!devAuth && (
                <button type="button" className="btn btn-ink h-12 py-0 px-[26px]" disabled={busy === "delete" || !health.data} onClick={deleteAccount}>
                  {busy === "delete" ? "Deleting…" : "Delete account"}
                </button>
              )}
            </div>
          </Card>

          {/* Save bar — sticks to the bottom of the viewport while there are unsaved edits */}
          <div
            role="region"
            aria-label="Save changes"
            aria-live="polite"
            className={`${dirty ? "sticky bottom-4 z-20" : ""} flex min-h-[72px] flex-wrap items-center justify-between gap-3 rounded-[20px] border-2 border-ink bg-sand px-5 py-3 shadow-[6px_6px_0_var(--ink)] sm:px-[26px]`}
          >
            <span className={`text-[16px] leading-6 font-semibold ${notice?.kind === "err" ? "text-[#8a2b2b]" : "text-ink"}`}>
              {notice?.kind === "err" ? notice.text : dirty ? "You have unsaved changes" : notice?.text ?? "All changes saved"}
            </span>
            <div className="flex items-center gap-4">
              <button
                type="button"
                className="btn btn-ghost h-12 py-0"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(baseline);
                  setNotice(null);
                }}
              >
                Discard
              </button>
              <button type="button" className="btn btn-primary h-12 py-0 px-[26px]" disabled={!dirty || saving} onClick={saveAll}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Plan picker */}
      <Modal open={planOpen} onClose={() => !planBusy && setPlanOpen(false)} labelledBy="plan-picker-title" className="max-w-[760px] p-5 sm:p-[26px]">
            <div className="flex items-start justify-between gap-4 pb-2">
              <h2 id="plan-picker-title" className="text-[28px] leading-9 text-ink">Change plan</h2>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!!planBusy} onClick={() => setPlanOpen(false)}>
                Close
              </button>
            </div>
            <p className="pb-5 text-[14px] leading-5 text-ink">Test mode: plan changes apply instantly and no payment is taken.</p>
            {plans.error && !plans.data ? (
              <ErrorCard error={plans.error} onRetry={() => plans.mutate()} />
            ) : !plans.data ? (
              <CardSkeleton rows={4} />
            ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {plans.data.plans.map((p) => {
                const current = p.plan === plan;
                return (
                  <div key={p.plan} className={`flex flex-col rounded-[16px] border-2 border-ink p-4 ${current ? "bg-sand shadow-[4px_4px_0_var(--ink)]" : "bg-linen"}`}>
                    <p className="eyebrow">{p.plan}</p>
                    <p className="font-display mt-1 text-[24px] leading-8">{PLAN_COPY[p.plan]?.price ?? "—"}</p>
                    <p className="mt-2 flex-1 text-[13px] leading-5 text-deep">
                      {p.products ?? "Unlimited"} products · {p.pincodes ?? "Unlimited"} pincodes per product
                      {p.competitors != null ? ` · ${p.competitors} competitors per product` : ""}
                      {PLAN_COPY[p.plan] ? <><br />{PLAN_COPY[p.plan].blurb}</> : null}
                    </p>
                    <button
                      type="button"
                      className={`btn btn-sm mt-4 w-full ${current ? "btn-ghost" : "btn-primary"}`}
                      disabled={current || planBusy !== null}
                      onClick={() => switchPlan(p.plan)}
                    >
                      {current ? "Current plan" : planBusy === p.plan ? "Switching…" : `Switch to ${p.plan}`}
                    </button>
                  </div>
                );
              })}
            </div>
            )}
      </Modal>
      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {confirmUi}
    </div>
  );
}

/* ---------- Change password (Supabase sign-in only) ---------- */

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setPassword("");
    setAgain("");
    setError(null);
    onClose();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== again) return setError("The two passwords don't match.");
    const client = getSupabase();
    if (!client) return setError("Sign-in isn't configured in this frontend.");
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await (await client).auth.updateUser({ password });
      if (err) throw err;
      toast("Password changed");
      setBusy(false);
      setPassword("");
      setAgain("");
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't change your password"));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} labelledBy="password-title" className="max-w-[460px]">
      <h2 id="password-title" className="text-[26px] leading-8 tracking-[-0.5px]">
        Change password
      </h2>
      <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
        <Field label="New password">
          <input className={INPUT} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Repeat new password">
          <input className={INPUT} type="password" autoComplete="new-password" minLength={8} required value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="rounded-[12px] border-2 border-ink bg-sand px-4 py-3 text-[14px] font-semibold">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !password || !again}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
