"use client";

/* eslint-disable @next/next/no-img-element */
import { useRouter } from "next/navigation";
import { use, useEffect, useId, useState, type ReactNode } from "react";
import { api, ApiError, errorMessage, useApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { AlertRule, Competitor, Me, Pincode, Plans, PriceSensitivity, Product } from "@/lib/types";
import { ALERT_KIND_LABEL, FREQUENCY_LABEL, platformLabel, rupees } from "@/lib/format";
import { MIN_CONSECUTIVE_RUNS, MIN_GAP_RUPEES, SENSITIVITY_OPTIONS, priceBounds, sensitivityPct } from "@/lib/pricing";
import ProductHeader from "@/components/ProductHeader";
import { CardSkeleton, ErrorCard, Toggle, useConfirm } from "@/components/ui";

const SECTIONS = [
  { id: "links", label: "Product & links" },
  { id: "competitors", label: "Competitors" },
  { id: "pincodes", label: "Pincodes & platforms" },
  { id: "frequency", label: "Check frequency" },
  { id: "rules", label: "Alert rules" },
  { id: "guardrails", label: "Price guardrails" },
  { id: "danger", label: "Pause or delete" },
];

/* ---------- Settings-frame primitives (node 4:579) ---------- */

/** Card: linen, 2px ink, 20px radius, 6px shadow, 26px padding, Fraunces 32/40 title + 16px gap. */
function Panel({ id, title, hint, children }: { id: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card p-[26px] scroll-mt-24 min-w-0" aria-labelledby={`${id}-title`}>
      <div className="pb-4">
        <h2 id={`${id}-title`} className="text-[28px] sm:text-[32px] leading-10 tracking-[-0.64px]">
          {title}
        </h2>
        {hint && <p className="text-[15px] leading-[22.5px] text-ink/80 mt-1">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Labelled input: 14px semibold label, 8px gap, 48px input, optional hint/error underneath. */
function Field({ label, className = "", hint, error, children }: { label: string; className?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className={`flex flex-col gap-2 min-w-0 ${className}`}>
      <span className="text-[14px] leading-5 font-semibold">{label}</span>
      {children}
      {error ? (
        <span className="text-[13px] leading-5 font-semibold bg-sand border-2 border-ink rounded-[8px] px-2 py-1" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[13px] leading-5 text-ink/80">{hint}</span>
      ) : null}
    </label>
  );
}
const INPUT = "input h-12 px-[18px] text-[16px] font-normal";

function Select({
  value,
  onChange,
  children,
  className = "",
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        className={`${INPUT} appearance-none pr-[42px] cursor-pointer disabled:cursor-not-allowed`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <img src="/figma/product-pages/chevron.svg" alt="" width={10} height={6} className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2" />
    </div>
  );
}

/** Setting row: label left, control right, 1px ink/20 divider (last row has none). */
function Row({ label, sub, children }: { label: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 pt-4 pb-[17px] border-b border-ink/20 last:border-0 last:pb-4">
      <div className="min-w-0">
        <div className="text-[16px] leading-6 font-semibold break-words">{label}</div>
        {sub && <p className="text-[14px] leading-5 text-ink/80">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

/** Toggle row: uses the shared Toggle, stretched so its label sits left and the switch right. */
function ToggleRow({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="pt-4 pb-[17px] border-b border-ink/20 last:border-0 last:pb-4 [&>label]:flex [&>label]:w-full [&>label]:justify-between [&>label]:text-[16px] [&>label]:leading-6">
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

function SaveRow({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 pt-6">
      {children}
      {status}
    </div>
  );
}

/**
 * Per-action busy flags + a transient "✓ Saved" per key. Failures always toast (and are shown inline
 * for save buttons), so no action fails silently.
 */
function useActions() {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  async function run(key: string, fn: () => Promise<unknown>, opts: { fail: string; ok?: string }) {
    if (busy[key]) return false;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
      setSaved((s) => ({ ...s, [key]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [key]: false })), 2000);
      if (opts.ok) toast(opts.ok);
      return true;
    } catch (e) {
      toast.error(errorMessage(e, opts.fail));
      return false;
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }
  return { busy, saved, run, any: Object.values(busy).some(Boolean) };
}

function useActiveSection(ready: boolean) {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ready]);
  return active;
}

const FREQUENCIES = ["3h", "6h", "12h", "daily", "weekly"];
const FREQUENCY_HOURS: Record<string, number> = { "3h": 3, "6h": 6, "12h": 12, daily: 24, weekly: 168 };

const toggleIn = <T,>(set: Set<T>, v: T) => {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
};

/** Number field text → value. "" → null (field cleared); NaN → undefined (invalid). */
function parseNum(v: string): number | null | undefined {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
const str = (n: number | null | undefined) => (n == null ? "" : String(n));
const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

type LinksDraft = { name: string; brand: string; search_query: string; urls: Record<string, string> };
type FreqDraft = { check_frequency: string; volatile_boost: boolean };
type GuardDraft = {
  cost_price: string;
  floor_price: string;
  min_margin_pct: string;
  max_change_pct: string;
  commission_pct: string;
  mrp: string;
  price_sensitivity: PriceSensitivity;
  round_to_price_point: boolean;
  approval_required: boolean;
};
type PinsDraft = { codes: Set<string>; platforms: Set<string> };

export default function ProductSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const uid = useId();
  const product = useApi<Product>(`/products/${id}`);
  const plans = useApi<Plans>("/plans");
  const me = useApi<Me>("/me");
  const allPincodes = useApi<Pincode[]>("/pincodes");
  const selection = useApi<{ platforms: string[]; pincodes: string[] }>(`/products/${id}/pincodes`);
  const listings = useApi<{ platform: string; url: string | null }[]>(`/products/${id}/listings`);
  const competitors = useApi<Competitor[]>(`/products/${id}/competitors`);
  const rules = useApi<AlertRule[]>(`/products/${id}/alert-rules`);
  const { busy, saved, run } = useActions();
  const [confirmUi, confirm] = useConfirm();
  const active = useActiveSection(!!product.data);

  // Each section keeps its own draft (null = untouched, show server values), so refreshing one
  // section after a save never wipes unsaved edits in another.
  const [linksDraft, setLinksDraft] = useState<LinksDraft | null>(null);
  const [freqDraft, setFreqDraft] = useState<FreqDraft | null>(null);
  const [guardDraft, setGuardDraft] = useState<GuardDraft | null>(null);
  const [pinsDraft, setPinsDraft] = useState<PinsDraft | null>(null);
  const [plain, setPlain] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [rival, setRival] = useState({ name: "", platform: "blinkit" });
  const [suggestions, setSuggestions] = useState<Omit<Competitor, "id" | "product_id">[]>([]);
  // "tinyfish" = live TinyFish Search results; "demo" = generic placeholders.
  const [suggestionSource, setSuggestionSource] = useState<string | null>(null);

  if (product.error) return <ErrorCard error={product.error} onRetry={() => product.mutate()} />;

  const p = product.data;
  const allPlatforms = plans.data?.platforms ?? ["blinkit", "zepto", "instamart", "amazon", "flipkart"];
  const planName = me.data?.plan ?? plans.data?.current;
  const limits = plans.data?.plans.find((x) => x.plan === planName);
  const minHours = limits?.minimum_frequency_hours ?? 0;
  const minFreq = FREQUENCIES.find((f) => FREQUENCY_HOURS[f] >= minHours) ?? "weekly";

  /* ---- current form values: draft ?? server ---- */
  const serverUrls = Object.fromEntries((listings.data ?? []).map((l) => [l.platform, l.url ?? ""]));
  const linksForm: LinksDraft = linksDraft ?? { name: p?.name ?? "", brand: p?.brand ?? "", search_query: p?.search_query ?? "", urls: serverUrls };
  const freqForm: FreqDraft = freqDraft ?? { check_frequency: p?.check_frequency ?? "weekly", volatile_boost: !!p?.volatile_boost };
  const guardForm: GuardDraft = guardDraft ?? {
    cost_price: str(p?.cost_price),
    floor_price: str(p?.floor_price),
    min_margin_pct: str(p?.min_margin_pct),
    max_change_pct: str(p?.max_change_pct),
    commission_pct: str(p?.commission_pct),
    mrp: str(p?.mrp),
    price_sensitivity: p?.price_sensitivity ?? "regular",
    round_to_price_point: !!p?.round_to_price_point,
    approval_required: p?.approval_required ?? true,
  };
  const pinsForm: PinsDraft = pinsDraft ?? { codes: new Set(selection.data?.pincodes ?? []), platforms: new Set(selection.data?.platforms ?? []) };
  const editLinks = (d: Partial<LinksDraft>) => setLinksDraft({ ...linksForm, ...d });
  const editFreq = (d: Partial<FreqDraft>) => setFreqDraft({ ...freqForm, ...d });
  const editGuard = (d: Partial<GuardDraft>) => setGuardDraft({ ...guardForm, ...d });
  const editPins = (d: Partial<PinsDraft>) => setPinsDraft({ ...pinsForm, ...d });

  const patch = async (fields: Partial<Product>) => {
    await api(`/products/${id}`, { method: "PATCH", json: fields });
    await product.mutate();
  };

  /* ---- validation ---- */
  const badUrls = Object.entries(linksForm.urls).filter(([, u]) => u.trim() && !isHttpUrl(u.trim()));
  const linksError = !linksForm.name.trim()
    ? "Name can't be empty"
    : !linksForm.search_query.trim()
      ? "Search query can't be empty"
      : badUrls.length
        ? `${platformLabel(badUrls[0][0])} link must start with http:// or https://`
        : null;

  const cost = parseNum(guardForm.cost_price);
  const floor = parseNum(guardForm.floor_price);
  const margin = parseNum(guardForm.min_margin_pct);
  const change = parseNum(guardForm.max_change_pct);
  const commission = parseNum(guardForm.commission_pct);
  const mrp = parseNum(guardForm.mrp);
  const guardErrors = {
    cost: cost === undefined || (cost != null && cost < 0) ? "Enter a price of 0 or more, or leave it empty" : null,
    floor:
      floor === undefined || (floor != null && floor < 0)
        ? "Enter a price of 0 or more, or leave it empty"
        : floor != null && cost != null && floor < cost
          ? "Floor price is below your cost price"
          : null,
    margin: margin == null || margin < 0 || margin > 100 ? "Enter a percentage from 0 to 100" : null,
    change: change == null || change < 0 || change > 50 ? "Enter a percentage from 0 to 50" : null,
    commission:
      commission === undefined || (commission != null && (commission < 0 || commission > 60))
        ? "Enter a percentage from 0 to 60, or leave it empty"
        : null,
    mrp:
      mrp === undefined || (mrp != null && mrp <= 0)
        ? "Enter a price above 0, or leave it empty"
        : mrp != null && floor != null && mrp < floor
          ? "MRP is below your floor price"
          : mrp != null && cost != null && mrp < cost
            ? "MRP is below your cost price"
            : null,
  };
  const bounds = priceBounds({
    cost: cost ?? null,
    commission: commission ?? null,
    margin: margin ?? null,
    floor: floor ?? null,
  });
  const triggerPct = sensitivityPct(guardForm.price_sensitivity);
  const guardInvalid = Object.values(guardErrors).some(Boolean);

  const overLimit = limits?.pincodes != null && pinsForm.codes.size > limits.pincodes;
  const freqTooFast = (FREQUENCY_HOURS[freqForm.check_frequency] ?? 0) < minHours;

  /* ---- rules: every change persists immediately (PUT replaces the list) ---- */
  const ruleList = rules.data ?? [];
  const putRules = (next: AlertRule[], key: string, ok: string) =>
    run(
      key,
      async () => {
        await api(`/products/${id}/alert-rules`, { method: "PUT", json: { rules: next } });
        await rules.mutate();
      },
      { fail: "Couldn't save alert rules", ok },
    );

  async function addRule() {
    const text = plain.trim();
    if (!text) return;
    setRuleError(null);
    await run(
      "parse",
      async () => {
        let rule: AlertRule;
        try {
          rule = await api<AlertRule>(`/products/${id}/alert-rules/parse`, { method: "POST", json: { text } });
        } catch (e) {
          // Unsupported wording: keep the explanation (and the examples it lists) next to the input.
          if (e instanceof ApiError && e.status === 422) setRuleError(e.message);
          throw e;
        }
        await api(`/products/${id}/alert-rules`, { method: "PUT", json: { rules: [...ruleList, { ...rule, active: true }] } });
        await rules.mutate();
        setPlain("");
      },
      { fail: "Couldn't add that rule", ok: "Rule added" },
    );
  }

  async function removeCompetitor(c: Competitor) {
    const ok = await confirm({
      title: `Stop tracking ${c.name}?`,
      body: "Its past checks are removed too. You can add it again later.",
      confirmLabel: "Remove rival",
      danger: true,
    });
    if (!ok) return;
    await run(
      `rm-${c.id}`,
      async () => {
        await api(`/competitors/${c.id}`, { method: "DELETE" });
        await competitors.mutate();
      },
      { fail: "Couldn't remove the rival", ok: `${c.name} removed` },
    );
  }

  async function deleteProduct() {
    if (!p) return;
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      body: "This removes the product and all of its history, alerts and Telegram links. This cannot be undone.",
      confirmLabel: "Delete product",
      danger: true,
    });
    if (!ok) return;
    await run(
      "delete",
      async () => {
        try {
          await api(`/products/${id}`, { method: "DELETE" });
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) throw new Error("A check is running for this product. Try again when it finishes.");
          throw e;
        }
        toast(`${p.name} deleted`);
        router.push("/products");
      },
      { fail: "Couldn't delete the product" },
    );
  }

  const Saved = ({ k }: { k: string }) =>
    saved[k] ? (
      <span className="text-[14px] font-semibold" role="status">
        ✓ Saved
      </span>
    ) : null;

  return (
    <div className="flex flex-col">
      <ProductHeader productId={id} active="settings" />
      {!p ? (
        <CardSkeleton rows={6} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[211px_minmax(0,1fr)] gap-8 pt-2">
          <aside className="hidden lg:block">
            <nav className="sticky top-24 flex flex-col gap-2" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  aria-current={active === s.id ? "true" : undefined}
                  className={`h-12 flex items-center px-4 rounded-[12px] text-[16px] leading-6 transition-colors ${
                    active === s.id ? "bg-slate text-linen font-semibold border-2 border-ink shadow-[4px_4px_0_var(--ink)]" : "font-medium hover:bg-ink/5"
                  }`}
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>

          <div className="flex flex-col gap-8 min-w-0 max-w-[760px]">
            {/* ---------------- Product & links ---------------- */}
            <Panel id="links" title="Product & links" hint="Where this product is listed on each platform.">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (linksError || !linksDraft) return;
                  void run(
                    "links",
                    async () => {
                      await patch({ name: linksForm.name.trim(), brand: linksForm.brand.trim() || null, search_query: linksForm.search_query.trim() });
                      await api(`/products/${id}/listings`, {
                        method: "PUT",
                        json: {
                          listings: Object.entries(linksForm.urls)
                            .filter(([, u]) => u.trim())
                            .map(([platform, url]) => ({ platform, url: url.trim() })),
                        },
                      });
                      await listings.mutate();
                      setLinksDraft(null);
                    },
                    { fail: "Couldn't save product details" },
                  );
                }}
              >
                <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2">
                  <Field label="Name">
                    <input className={INPUT} value={linksForm.name} maxLength={300} onChange={(e) => editLinks({ name: e.target.value })} />
                  </Field>
                  <Field label="Brand">
                    <input className={INPUT} value={linksForm.brand} maxLength={120} onChange={(e) => editLinks({ brand: e.target.value })} />
                  </Field>
                  <Field label="Search query used by agents" className="sm:col-span-2">
                    <input className={INPUT} value={linksForm.search_query} maxLength={300} onChange={(e) => editLinks({ search_query: e.target.value })} />
                  </Field>
                  {allPlatforms.map((pl) => (
                    <Field key={pl} label={`${platformLabel(pl)} link`}>
                      <input
                        className={INPUT}
                        type="url"
                        inputMode="url"
                        placeholder="https://…"
                        value={linksForm.urls[pl] ?? ""}
                        aria-invalid={badUrls.some(([b]) => b === pl) || undefined}
                        onChange={(e) => editLinks({ urls: { ...linksForm.urls, [pl]: e.target.value } })}
                      />
                    </Field>
                  ))}
                </div>
                {linksDraft && linksError && (
                  <p className="text-[14px] font-semibold mt-4" role="alert">
                    {linksError}
                  </p>
                )}
                <SaveRow status={<Saved k="links" />}>
                  <button type="submit" className="btn btn-primary h-12 px-[26px]" disabled={!linksDraft || !!linksError || busy.links}>
                    {busy.links ? "Saving…" : "Save changes"}
                  </button>
                  {linksDraft && (
                    <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={busy.links} onClick={() => setLinksDraft(null)}>
                      Discard
                    </button>
                  )}
                </SaveRow>
              </form>
            </Panel>

            {/* ---------------- Competitors ---------------- */}
            <Panel id="competitors" title="Competitors" hint="Rivals tracked alongside your product at every pincode.">
              <div className="flex flex-col">
                {competitors.error && <p className="text-[15px] py-4 border-b border-ink/20">Couldn&apos;t load rivals: {errorMessage(competitors.error)}</p>}
                {competitors.data?.length === 0 && <p className="text-[15px] text-ink/75 py-4 border-b border-ink/20">No rivals yet. Add one below or ask for suggestions.</p>}
                {competitors.data?.map((c) => (
                  <Row
                    key={c.id}
                    label={
                      <span className="flex flex-wrap items-center gap-3">
                        {c.name}
                        {c.confirmed ? (
                          <span className="inline-flex items-center gap-1.5 h-9 px-[14px] rounded-[12px] border-2 border-ink bg-sage text-[14px] leading-5 font-semibold">
                            <img src="/figma/product-pages/pill-check.svg" alt="" width={10} height={7} /> {platformLabel(c.platform)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center h-9 px-[14px] rounded-[12px] border-2 border-ink bg-sand text-[14px] leading-5 font-semibold">
                            {platformLabel(c.platform)} · unconfirmed
                          </span>
                        )}
                      </span>
                    }
                  >
                    <div className="flex gap-3">
                      {!c.confirmed && (
                        <button
                          type="button"
                          className="btn btn-sage btn-sm"
                          disabled={busy[`ok-${c.id}`] || busy[`rm-${c.id}`]}
                          onClick={() =>
                            run(
                              `ok-${c.id}`,
                              async () => {
                                await api(`/competitors/${c.id}/confirm`, { method: "POST" });
                                await competitors.mutate();
                              },
                              { fail: "Couldn't confirm the rival" },
                            )
                          }
                        >
                          {busy[`ok-${c.id}`] ? "Confirming…" : "Confirm"}
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy[`ok-${c.id}`] || busy[`rm-${c.id}`]} onClick={() => removeCompetitor(c)}>
                        {busy[`rm-${c.id}`] ? "Removing…" : "Remove"}
                        <span className="sr-only"> {c.name}</span>
                      </button>
                    </div>
                  </Row>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = rival.name.trim();
                  if (!name) return;
                  void run(
                    "rival",
                    async () => {
                      await api(`/products/${id}/competitors`, { method: "POST", json: { ...rival, name, search_query: name, confirmed: true } });
                      setRival({ ...rival, name: "" });
                      await competitors.mutate();
                    },
                    { fail: "Couldn't add the rival", ok: `${name} added` },
                  );
                }}
              >
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px] pt-6">
                  <Field label="Rival product name">
                    <input className={INPUT} placeholder="e.g. Mother Dairy Toned Milk 500 ml" value={rival.name} maxLength={300} onChange={(e) => setRival({ ...rival, name: e.target.value })} />
                  </Field>
                  <Field label="Platform">
                    <Select value={rival.platform} onChange={(v) => setRival({ ...rival, platform: v })}>
                      {allPlatforms.map((pl) => (
                        <option key={pl} value={pl}>
                          {platformLabel(pl)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <SaveRow>
                  <button type="submit" className="btn btn-primary h-12 px-[26px]" disabled={!rival.name.trim() || busy.rival}>
                    {busy.rival ? "Adding…" : "Add rival"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sand h-12 px-[22px]"
                    disabled={busy.suggest}
                    onClick={() =>
                      run(
                        "suggest",
                        async () => {
                          const r = await api<{ suggestions: typeof suggestions; source: string }>(`/products/${id}/competitors/discover`, { method: "POST", json: {} });
                          setSuggestions(r.suggestions);
                          setSuggestionSource(r.source);
                          if (!r.suggestions.length) toast.info("No new rivals found for this product");
                        },
                        { fail: "Couldn't find suggestions" },
                      )
                    }
                  >
                    {busy.suggest ? "Searching…" : "Suggest rivals"}
                  </button>
                </SaveRow>
              </form>
              {suggestions.length > 0 && (
                <div className="pt-5">
                  <p className="eyebrow text-slate mb-1">{suggestionSource === "demo" ? "Demo suggestions" : "Suggestions"} · tap to track</p>
                  <p className="text-[14px] leading-5 text-ink/80 mb-3">
                    {suggestionSource === "demo"
                      ? "Live rival search isn't available, so these are generic placeholders: each one tracks the top listing for your product category (your brand removed) on that platform."
                      : "Found by TinyFish Search. Rivals you already track are left out."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={`${s.platform}-${s.name}`}
                        type="button"
                        className="pill"
                        disabled={busy[`sg-${s.platform}-${s.name}`]}
                        onClick={() =>
                          run(
                            `sg-${s.platform}-${s.name}`,
                            async () => {
                              await api(`/products/${id}/competitors`, { method: "POST", json: { ...s, confirmed: true } });
                              setSuggestions((list) => list.filter((x) => x !== s));
                              await competitors.mutate();
                            },
                            { fail: `Couldn't add ${s.name}`, ok: `${s.name} added` },
                          )
                        }
                      >
                        {busy[`sg-${s.platform}-${s.name}`] ? "Adding…" : `+ ${s.name} · ${platformLabel(s.platform)}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Panel>

            {/* ---------------- Pincodes ---------------- */}
            <Panel
              id="pincodes"
              title="Pincodes & platforms"
              hint={limits ? (limits.pincodes != null ? `Your plan allows up to ${limits.pincodes} pincodes per product.` : "Your plan has no pincode limit.") : undefined}
            >
              <p className="text-[14px] leading-5 font-semibold mb-2" id={`${uid}-platforms`}>
                Platforms
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${uid}-platforms`}>
                {allPlatforms.map((pl) => (
                  <button
                    key={pl}
                    type="button"
                    className="pill"
                    data-active={pinsForm.platforms.has(pl)}
                    aria-pressed={pinsForm.platforms.has(pl)}
                    onClick={() => editPins({ platforms: toggleIn(pinsForm.platforms, pl) })}
                  >
                    {pinsForm.platforms.has(pl) ? "✓ " : ""}
                    {platformLabel(pl)}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between mt-6 mb-2">
                <p className="text-[14px] leading-5 font-semibold">Pincodes</p>
                <p className={`text-[14px] font-medium ${overLimit ? "font-semibold bg-sand px-2 rounded-md" : "text-ink/80"}`} aria-live="polite">
                  {pinsForm.codes.size} selected{limits?.pincodes != null ? ` of ${limits.pincodes}` : ""}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-80 overflow-y-auto p-1 -m-1">
                {allPincodes.data?.map((pc) => {
                  const on = pinsForm.codes.has(pc.code);
                  return (
                    <label
                      key={pc.code}
                      className={`flex items-center gap-2 border-2 border-ink rounded-[12px] px-3 py-2 text-[14px] cursor-pointer transition-colors ${on ? "bg-sage/50" : "bg-linen hover:bg-ink/5"}`}
                    >
                      <input type="checkbox" className="accent-[var(--slate)] size-4 shrink-0" checked={on} onChange={() => editPins({ codes: toggleIn(pinsForm.codes, pc.code) })} />
                      <b className="font-semibold">{pc.code}</b> <span className="truncate text-ink/80">{pc.area_name}</span>
                    </label>
                  );
                })}
              </div>
              {overLimit && <p className="text-[14px] mt-3">That&apos;s more than your plan allows. Unselect a few, or upgrade in Settings.</p>}
              <SaveRow status={<Saved k="pins" />}>
                <button
                  type="button"
                  className="btn btn-primary h-12 px-[26px]"
                  disabled={!pinsDraft || !pinsForm.codes.size || !pinsForm.platforms.size || overLimit || busy.pins}
                  onClick={() =>
                    run(
                      "pins",
                      async () => {
                        await api(`/products/${id}/pincodes`, { method: "PUT", json: { pincodes: [...pinsForm.codes], platforms: [...pinsForm.platforms] } });
                        await selection.mutate();
                        setPinsDraft(null);
                      },
                      { fail: "Couldn't save pincodes" },
                    )
                  }
                >
                  {busy.pins ? "Saving…" : `Save ${pinsForm.codes.size} pincode${pinsForm.codes.size === 1 ? "" : "s"}`}
                </button>
                {pinsDraft && (
                  <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={busy.pins} onClick={() => setPinsDraft(null)}>
                    Discard
                  </button>
                )}
              </SaveRow>
            </Panel>

            {/* ---------------- Frequency ---------------- */}
            <Panel
              id="frequency"
              title="Check frequency"
              hint={
                minHours > 3
                  ? `On the ${planName ?? "current"} plan, checks run at most ${(FREQUENCY_LABEL[minFreq] ?? minFreq).toLowerCase()}. Upgrade for faster checks.`
                  : "Products whose prices move often can be checked more often."
              }
            >
              <div className="flex flex-col">
                <Row label="How often to check">
                  <Select className="w-[200px]" ariaLabel="How often to check" value={freqForm.check_frequency} onChange={(v) => editFreq({ check_frequency: v })}>
                    {FREQUENCIES.map((f) => {
                      const locked = FREQUENCY_HOURS[f] < minHours;
                      return (
                        <option key={f} value={f} disabled={locked && f !== p.check_frequency}>
                          {FREQUENCY_LABEL[f]}
                          {locked ? " · upgrade" : ""}
                        </option>
                      );
                    })}
                  </Select>
                </Row>
                <ToggleRow label="Check more often when prices are volatile" checked={freqForm.volatile_boost} onChange={(v) => editFreq({ volatile_boost: v })} />
              </div>
              <p className="text-[14px] leading-5 text-ink/80">
                When your price or a rival&apos;s moves by 5% or more within 48 hours, scheduled checks run one step faster (for example daily → every 12 hours) until prices settle.
                {freqForm.volatile_boost && FREQUENCIES.indexOf(freqForm.check_frequency) <= FREQUENCIES.indexOf(minFreq)
                  ? ` You're already on your plan's fastest schedule (${(FREQUENCY_LABEL[minFreq] ?? minFreq).toLowerCase()}), so this has no effect unless you pick a slower one or upgrade.`
                  : ""}
              </p>
              {freqTooFast && <p className="text-[14px] font-semibold mt-2">Your plan doesn&apos;t allow this frequency any more. Pick a slower one.</p>}
              <SaveRow status={<Saved k="freq" />}>
                <button
                  type="button"
                  className="btn btn-primary h-12 px-[26px]"
                  disabled={!freqDraft || freqTooFast || busy.freq}
                  onClick={() =>
                    run(
                      "freq",
                      async () => {
                        await patch({ check_frequency: freqForm.check_frequency, volatile_boost: freqForm.volatile_boost });
                        setFreqDraft(null);
                      },
                      { fail: "Couldn't save the check frequency" },
                    )
                  }
                >
                  {busy.freq ? "Saving…" : "Save changes"}
                </button>
              </SaveRow>
            </Panel>

            {/* ---------------- Alert rules ---------------- */}
            <Panel id="rules" title="Alert rules" hint="Write a rule in plain English, or toggle the defaults. Changes save right away.">
              <form
                className="flex flex-col sm:flex-row gap-3 sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addRule();
                }}
              >
                <Field label="New rule" className="flex-1">
                  <input
                    className={INPUT}
                    placeholder="Alert me if we go out of stock in South Delhi"
                    value={plain}
                    maxLength={500}
                    aria-invalid={ruleError ? true : undefined}
                    onChange={(e) => {
                      setPlain(e.target.value);
                      setRuleError(null);
                    }}
                  />
                </Field>
                <button type="submit" className="btn btn-sand h-12 px-[22px]" disabled={!plain.trim() || busy.parse}>
                  {busy.parse ? "Adding…" : "Add rule"}
                </button>
              </form>
              {ruleError && (
                <p className="text-[14px] leading-5 font-semibold bg-sand border-2 border-ink rounded-[8px] px-3 py-2 mt-3" role="alert">
                  {ruleError}
                </p>
              )}
              <div className="flex flex-col pt-3" aria-busy={busy.rules}>
                {rules.error && <p className="text-[15px] py-4">Couldn&apos;t load rules: {errorMessage(rules.error)}</p>}
                {rules.data && ruleList.length === 0 && <p className="text-[15px] text-ink/75 py-4">No rules yet. Add one above.</p>}
                {ruleList.map((r, i) => {
                  const kind = ALERT_KIND_LABEL[r.kind] ?? r.kind;
                  const label = r.rule_text ?? kind;
                  const areas = Array.isArray(r.rule_json?.areas) ? (r.rule_json.areas as unknown[]).filter((a): a is string => typeof a === "string") : [];
                  return (
                    <Row
                      key={`${r.kind}-${r.rule_text ?? ""}-${i}`}
                      label={label}
                      sub={`${kind}${r.threshold != null ? ` · threshold ${r.threshold}` : ""}${areas.length ? ` · ${areas.join(", ")}` : ""}`}
                    >
                      <div className="flex items-center gap-4">
                        <Toggle
                          checked={r.active}
                          label={`${r.active ? "Turn off" : "Turn on"} rule: ${label}`}
                          hideLabel
                          disabled={busy.rules}
                          onChange={(v) => putRules(ruleList.map((x, j) => (j === i ? { ...x, active: v } : x)), "rules", v ? "Rule turned on" : "Rule turned off")}
                        />
                        <button
                          type="button"
                          className="grid place-items-center size-9 rounded-[10px] border-2 border-ink bg-linen text-[18px] font-bold hover:bg-sand transition-colors disabled:cursor-not-allowed"
                          aria-label={`Remove rule: ${label}`}
                          disabled={busy.rules}
                          onClick={async () => {
                            const ok = await confirm({ title: "Remove this rule?", body: label, confirmLabel: "Remove rule", danger: true });
                            if (ok) await putRules(ruleList.filter((_, j) => j !== i), "rules", "Rule removed");
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </Row>
                  );
                })}
              </div>
            </Panel>

            {/* ---------------- Guardrails ---------------- */}
            <Panel id="guardrails" title="Price guardrails" hint="Recommendations can never break these limits.">
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (guardInvalid || !guardDraft) return;
                  void run(
                    "guard",
                    async () => {
                      await patch({
                        cost_price: cost ?? null,
                        floor_price: floor ?? null,
                        min_margin_pct: margin as number,
                        max_change_pct: change as number,
                        commission_pct: commission ?? null,
                        mrp: mrp ?? null,
                        price_sensitivity: guardForm.price_sensitivity,
                        round_to_price_point: guardForm.round_to_price_point,
                        approval_required: guardForm.approval_required,
                      });
                      setGuardDraft(null);
                    },
                    { fail: "Couldn't save guardrails" },
                  );
                }}
              >
                <div className="grid gap-6 sm:grid-cols-2">
                  <Field label="Cost price (₹)" hint="Leave empty if you don't want margin checks." error={guardDraft ? guardErrors.cost : null}>
                    <input type="number" inputMode="decimal" min={0} step="0.01" className={INPUT} value={guardForm.cost_price} onChange={(e) => editGuard({ cost_price: e.target.value })} />
                  </Field>
                  <Field label="Floor price (₹)" hint="Never recommend a price below this. Must be at least your cost price." error={guardDraft ? guardErrors.floor : null}>
                    <input type="number" inputMode="decimal" min={0} step="0.01" className={INPUT} value={guardForm.floor_price} onChange={(e) => editGuard({ floor_price: e.target.value })} />
                  </Field>
                  <Field label="Minimum margin (%)" hint="0–100" error={guardDraft ? guardErrors.margin : null}>
                    <input type="number" inputMode="decimal" min={0} max={100} className={INPUT} value={guardForm.min_margin_pct} onChange={(e) => editGuard({ min_margin_pct: e.target.value })} />
                  </Field>
                  <Field label="Max price change per day (%)" hint="0–50" error={guardDraft ? guardErrors.change : null}>
                    <input type="number" inputMode="decimal" min={0} max={50} className={INPUT} value={guardForm.max_change_pct} onChange={(e) => editGuard({ max_change_pct: e.target.value })} />
                  </Field>
                  <Field label="Platform commission (%)" hint="What the app keeps from each sale (quick commerce is usually 18–35%). Raises your break-even." error={guardDraft ? guardErrors.commission : null}>
                    <input type="number" inputMode="decimal" min={0} max={60} step="0.1" placeholder="e.g. 25" className={INPUT} value={guardForm.commission_pct} onChange={(e) => editGuard({ commission_pct: e.target.value })} />
                  </Field>
                  <Field label="MRP (₹)" hint="Printed maximum retail price. We never suggest a price above it." error={guardDraft ? guardErrors.mrp : null}>
                    <input type="number" inputMode="decimal" min={0} step="0.01" className={INPUT} value={guardForm.mrp} onChange={(e) => editGuard({ mrp: e.target.value })} />
                  </Field>
                </div>
                <fieldset data-mochi="price-sensitivity" className="mt-6 min-w-0">
                  <legend className="text-[14px] leading-5 font-semibold pb-2">Price sensitivity</legend>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {SENSITIVITY_OPTIONS.map((o) => {
                      const on = guardForm.price_sensitivity === o.value;
                      return (
                        <label
                          key={o.value}
                          className={`flex flex-col gap-1 rounded-[14px] border-2 border-ink p-4 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-ink focus-within:ring-offset-2 ${on ? "bg-sand" : "bg-linen hover:bg-sand/40"}`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-[16px] font-semibold">
                              <input
                                type="radio"
                                name={`${uid}-sensitivity`}
                                value={o.value}
                                checked={on}
                                onChange={() => editGuard({ price_sensitivity: o.value })}
                                className="accent-ink"
                              />
                              {o.label}
                            </span>
                            <span className="chip bg-linen">{o.pct}%</span>
                          </span>
                          <span className="text-[13px] leading-5 text-ink/80">{o.blurb}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <div className="flex flex-col pt-3 mt-3 border-t border-ink/20">
                  <ToggleRow label="Round to price points (₹49, ₹99…)" checked={guardForm.round_to_price_point} onChange={(v) => editGuard({ round_to_price_point: v })} />
                  <ToggleRow label="Every action needs my approval" checked={guardForm.approval_required} onChange={(v) => editGuard({ approval_required: v })} />
                </div>
                <p data-mochi="safe-floor" className="mt-3 text-[14px] leading-[21px] bg-linen border-2 border-ink/20 rounded-[12px] px-4 py-3" aria-live="polite">
                  {bounds.safeFloor != null ? (
                    <>
                      Safe floor <b>{rupees(bounds.safeFloor, 2)}</b>
                      {bounds.breakEven != null && (
                        <>
                          {" · "}break-even <b>{rupees(bounds.breakEven, 2)}</b>
                        </>
                      )}
                      {mrp != null && (
                        <>
                          {" · "}ceiling <b>{rupees(mrp, 2)}</b> (MRP)
                        </>
                      )}
                      {" · "}
                    </>
                  ) : (
                    <>Add a cost price to protect your margin · </>
                  )}
                  we&apos;ll suggest a price change when you&apos;re more than <b>{triggerPct}%</b> (and ₹{MIN_GAP_RUPEES}) above the cheapest rival for {MIN_CONSECUTIVE_RUNS} checks in a row.
                </p>
                <SaveRow status={<Saved k="guard" />}>
                  <button type="submit" className="btn btn-primary h-12 px-[26px]" disabled={!guardDraft || guardInvalid || busy.guard}>
                    {busy.guard ? "Saving…" : "Save guardrails"}
                  </button>
                  {guardDraft && (
                    <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={busy.guard} onClick={() => setGuardDraft(null)}>
                      Discard
                    </button>
                  )}
                </SaveRow>
              </form>
            </Panel>

            {/* ---------------- Danger zone ---------------- */}
            <Panel id="danger" title="Pause or delete">
              <div className="flex flex-col">
                <Row label={p.paused ? "Checks are paused" : "Pause checks"} sub={p.paused ? "No scheduled checks run until you resume." : "Stop scheduled checks without losing history."}>
                  <div className="flex items-center gap-3">
                    <Saved k="pause" />
                    <button
                      type="button"
                      className="btn btn-ghost h-12 px-[22px]"
                      disabled={busy.pause}
                      onClick={() => run("pause", () => patch({ paused: !p.paused }), { fail: p.paused ? "Couldn't resume checks" : "Couldn't pause checks", ok: p.paused ? "Checks resumed" : "Checks paused" })}
                    >
                      {busy.pause ? "Saving…" : p.paused ? "▶ Resume checks" : "‖ Pause checks"}
                    </button>
                  </div>
                </Row>
                <Row label="Delete product" sub="Removes all its history. This cannot be undone.">
                  <button type="button" className="btn btn-ink h-12 px-[26px]" disabled={busy.delete} onClick={deleteProduct}>
                    {busy.delete ? "Deleting…" : "Delete product"}
                  </button>
                </Row>
              </div>
            </Panel>
          </div>
        </div>
      )}
      {confirmUi}
    </div>
  );
}
