"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, useApi } from "@/lib/api";
import { platformLabel } from "@/lib/format";
import { toast } from "@/lib/toast";
import { SENSITIVITY_OPTIONS } from "@/lib/pricing";
import type { Me, Pincode, Plans, PriceSensitivity, Product } from "@/lib/types";
import { useDialogA11y } from "./ui";

/** Apps checked live by TinyFish (Blinkit blocks automated browsers). */
const DEFAULT_PLATFORMS = ["zepto", "instamart", "amazon", "flipkart"];

interface Suggestion { name: string; platform: string; url: string | null; search_query: string | null; confirmed: boolean }

const STEP_TITLES = ["Add a product", "Confirm competitors", "Where do you sell?"];

/** Backend limits (schemas/products.py): name 300 chars, brand 200; the name is also the search query (500). */
const NAME_MAX = 300;
const BRAND_MAX = 200;

/** Path segments that are routing noise or IDs, never the product's name. */
const NOISE = /^(dp|gp|prn|prid|pid|p|pd|ip|itm|item|items|product|products|buy|s|search|en|in|www|html?)$/i;

/** Platform a product link belongs to, if we know it. */
function platformOf(url: URL): string | null {
  const h = url.hostname.replace(/^www\./, "");
  if (h.endsWith("blinkit.com")) return "blinkit";
  if (h.endsWith("zepto.com") || h.endsWith("zeptonow.com")) return "zepto";
  if (h.endsWith("swiggy.com")) return "instamart";
  if (/(^|\.)amazon\.[a-z.]+$/.test(h) || h === "amzn.in" || h === "amzn.to") return "amazon";
  if (h.endsWith("flipkart.com")) return "flipkart";
  return null;
}

function safeDecode(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Turns a pasted link into a readable product name: the path segment with the most words
 * (e.g. `/prn/amul-taaza-toned-milk/prid/123` → "Amul Taaza Toned Milk"). Falls back to `?q=`, then null.
 */
function nameFromUrl(url: URL): string | null {
  const words = (seg: string) =>
    safeDecode(seg)
      .replace(/\.[a-z]{2,5}$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const candidates = url.pathname
    .split("/")
    .filter((seg) => seg && !NOISE.test(seg))
    .map(words)
    .filter((w) => /[a-z]{3,}/i.test(w) && !/^[A-Z0-9]{8,}$/.test(w.replace(/\s/g, "")));
  let best = candidates.sort((a, b) => b.split(" ").length - a.split(" ").length)[0];
  if (!best) best = words(url.searchParams.get("q") ?? url.searchParams.get("query") ?? "");
  if (!best) return null;
  return best
    .split(" ")
    .map((w) => (w.length > 2 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .slice(0, 120);
}

function parseInput(raw: string): { name: string; link: { url: string; platform: string | null } | null } {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return { name: text, link: null };
  try {
    const url = new URL(text);
    return { name: nameFromUrl(url) ?? "New product", link: { url: url.toString(), platform: platformOf(url) } };
  } catch {
    // Looked like a link but isn't one; treat it as a name.
    return { name: text.replace(/^https?:\/\//i, "").slice(0, 120) || "New product", link: null };
  }
}

const keyOf = (s: Suggestion) => `${s.platform}:${s.name.trim().toLowerCase()}`;

const toggle = <T,>(set: Set<T>, v: T) => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

/**
 * Add product → confirm competitors → pick pincodes → first check.
 * Each step is resumable: a retry reuses the product already created and skips competitors already saved.
 * Closing midway offers to keep the draft product or discard it (DELETE).
 */
export default function AddProductDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const plans = useApi<Plans>("/plans");
  const me = useApi<Me>("/me");
  const pincodes = useApi<Pincode[]>("/pincodes");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [input, setInput] = useState("");
  const [brand, setBrand] = useState("");
  // Optional "Advanced pricing": the same fields as Settings → Price guardrails.
  const [pricing, setPricing] = useState<{ cost: string; commission: string; mrp: string; sensitivity: PriceSensitivity }>({
    cost: "",
    commission: "",
    mrp: "",
    sensitivity: "regular",
  });
  const [product, setProduct] = useState<Product | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // "tinyfish" = live search results; "demo"/"mock" = generic placeholders.
  const [suggestSource, setSuggestSource] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // Competitors already POSTed, keyed by platform + name, so retries never duplicate them.
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(DEFAULT_PLATFORMS));
  const [codes, setCodes] = useState<Set<string>>(new Set());
  const [pinFilter, setPinFilter] = useState("");
  const [pinsSaved, setPinsSaved] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const planName = me.data?.plan ?? plans.data?.current;
  const planLimits = plans.data?.plans.find((p) => p.plan === planName);
  const limit = planLimits?.pincodes ?? null;
  const competitorLimit = planLimits?.competitors ?? null;
  const preview = parseInput(input);
  const nameTooLong = preview.name.length > NAME_MAX;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const costValue = num(pricing.cost);
  const commissionValue = num(pricing.commission);
  const mrpValue = num(pricing.mrp);
  const pricingError =
    costValue != null && !(Number.isFinite(costValue) && costValue >= 0)
      ? "Cost price must be 0 or more"
      : commissionValue != null && !(Number.isFinite(commissionValue) && commissionValue >= 0 && commissionValue <= 60)
        ? "Commission must be from 0 to 60%"
        : mrpValue != null && !(Number.isFinite(mrpValue) && mrpValue > 0)
          ? "MRP must be above 0"
          : mrpValue != null && costValue != null && mrpValue < costValue
            ? "MRP is below your cost price"
            : null;

  function requestClose() {
    if (busy) return; // never abandon a request halfway
    if (product && !leaving) setLeaving(true);
    else if (!product) onClose();
  }
  useDialogA11y(dialogRef, true, () => (leaving ? setLeaving(false) : requestClose()), inputRef);

  // Move focus to the new step's heading so screen readers announce it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step, leaving]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  async function createProduct() {
    const { name, link } = parseInput(input);
    await run(async () => {
      let p = product;
      const fields = {
        name,
        brand: brand.trim() || null,
        search_query: name,
        cost_price: costValue,
        commission_pct: commissionValue,
        mrp: mrpValue,
        price_sensitivity: pricing.sensitivity,
      };
      if (!p) {
        // check_frequency is omitted on purpose: the backend defaults it to the plan minimum.
        p = await api<Product>("/products", { method: "POST", json: fields });
        setProduct(p);
      } else if (
        p.name !== fields.name ||
        (p.brand ?? null) !== fields.brand ||
        (p.cost_price ?? null) !== fields.cost_price ||
        (p.commission_pct ?? null) !== fields.commission_pct ||
        (p.mrp ?? null) !== fields.mrp ||
        p.price_sensitivity !== fields.price_sensitivity
      ) {
        p = await api<Product>(`/products/${p.id}`, { method: "PATCH", json: fields });
        setProduct(p);
      }
      if (link?.platform) {
        setPlatforms((s) => new Set([...s, link.platform!]));
        try {
          await api(`/products/${p.id}/listings`, { method: "PUT", json: { listings: [{ platform: link.platform, url: link.url }] } });
        } catch {
          toast.info("Couldn't save the product link — you can add it later in settings");
        }
      }
      const found = await api<{ suggestions: Suggestion[]; source?: string }>(`/products/${p.id}/competitors/discover`, { method: "POST", json: {} });
      setSuggestions(found.suggestions);
      setSuggestSource(found.source ?? null);
      setPicked(new Set(found.suggestions.map((_, i) => i).slice(0, Math.min(3, competitorLimit ?? 3))));
      setStep(2);
    });
  }

  async function saveCompetitors() {
    if (!product) return;
    await run(async () => {
      let duplicates = 0;
      for (const i of picked) {
        if (saved.has(keyOf(suggestions[i]))) continue;
        try {
          await api(`/products/${product.id}/competitors`, { method: "POST", json: { ...suggestions[i], confirmed: true } });
        } catch (e) {
          // Already tracked (e.g. saved before a network blip, or the same rival twice): count it as saved.
          // Any other conflict (like a plan limit) is a real error.
          const duplicate = e instanceof ApiError && e.status === 409 && (e.code === "duplicate_competitor" || e.code === "conflict");
          if (!duplicate) throw e;
          duplicates++;
        }
        setSaved((s) => new Set(s).add(keyOf(suggestions[i])));
      }
      if (duplicates) toast.info(`${duplicates} competitor${duplicates === 1 ? " was" : "s were"} already tracked`);
      setStep(3);
    });
  }

  async function finish() {
    if (!product) return;
    await run(async () => {
      if (!pinsSaved) {
        await api(`/products/${product.id}/pincodes`, { method: "PUT", json: { platforms: [...platforms], pincodes: [...codes] } });
        setPinsSaved(true);
      }
      try {
        await api(`/products/${product.id}/runs`, { method: "POST", json: {} });
        toast("First check started");
        router.push(`/heatmap?product=${product.id}`);
      } catch (e) {
        // The product is fully set up; only the first run couldn't start (e.g. daily credit budget).
        toast.error(`${product.name} is saved, but the first check didn't start: ${errorMessage(e)}`);
        router.push(`/products/${product.id}`);
      }
      onClose();
    });
  }

  async function discard() {
    if (!product) return onClose();
    await run(async () => {
      await api(`/products/${product.id}`, { method: "DELETE" });
      toast("Draft product discarded");
      onClose();
    });
  }

  const shownPins = (pincodes.data ?? []).filter((pc) => {
    const t = pinFilter.trim().toLowerCase();
    return !t || pc.code.includes(t) || pc.area_name.toLowerCase().includes(t) || pc.city.toLowerCase().includes(t);
  });
  const overLimit = limit != null && codes.size > limit;
  const competitorsOver = competitorLimit != null && picked.size > competitorLimit;

  return (
    <div
      className="fixed inset-0 z-[2000] bg-ink/60 grid place-items-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-product-title"
        aria-busy={busy}
        className="card w-full max-w-[560px] p-[26px] max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                aria-hidden
                className={`grid place-items-center size-7 rounded-full border-2 border-ink font-display text-[13px] leading-none ${
                  n < step ? "bg-sage" : n === step ? "bg-sand shadow-[2px_2px_0_var(--ink)]" : "bg-linen text-ink/75"
                }`}
              >
                {n < step ? "✓" : n}
              </span>
            ))}
            <span className="eyebrow text-slate ml-2">Step {step} of 3</span>
          </div>
          <button
            type="button"
            className="grid place-items-center size-9 rounded-[10px] border-2 border-ink bg-linen text-[20px] leading-none font-bold hover:bg-sand transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {leaving ? (
          <>
            <h2 id="add-product-title" ref={headingRef} tabIndex={-1} className="text-[32px] leading-10 tracking-[-0.64px] mt-5 outline-none">
              Leave setup?
            </h2>
            <p className="text-[16px] leading-6 text-ink/80 mt-1">
              <b className="font-semibold text-ink">{product?.name}</b> is already saved. Keep it to finish later in its settings, or discard it.
            </p>
            <div className="flex flex-col sm:flex-row flex-wrap gap-3 mt-6">
              <button type="button" className="btn btn-primary h-12" disabled={busy} onClick={() => setLeaving(false)}>
                Keep setting up
              </button>
              <button type="button" className="btn btn-ghost h-12" disabled={busy} onClick={onClose}>
                Keep product & close
              </button>
              <button type="button" className="btn btn-ink h-12" disabled={busy} onClick={discard}>
                {busy ? "Discarding…" : "Discard product"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="add-product-title" ref={headingRef} tabIndex={-1} className="text-[32px] leading-10 tracking-[-0.64px] mt-5 outline-none">
              {STEP_TITLES[step - 1]}
            </h2>

            {step === 1 && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (input.trim() && !nameTooLong && !pricingError && !busy) void createProduct();
                }}
              >
                <p className="text-[16px] leading-6 text-ink/80 mt-1">Paste a product link or type its name.</p>
                <div className="flex flex-col gap-5 mt-6">
                  <label className="flex flex-col gap-2">
                    <span className="text-[14px] leading-5 font-semibold">Product link or name</span>
                    <input
                      ref={inputRef}
                      className="input h-12 px-[18px] text-[16px] font-normal"
                      placeholder="Amul Taaza Toned Milk 500 ml"
                      value={input}
                      // Links can be long (the name is taken from them); typed names are checked against NAME_MAX.
                      maxLength={2000}
                      onChange={(e) => setInput(e.target.value)}
                      aria-invalid={nameTooLong || undefined}
                      aria-describedby={nameTooLong ? "add-product-name-error" : preview.link ? "add-product-preview" : undefined}
                    />
                  </label>
                  {nameTooLong && (
                    <p id="add-product-name-error" className="text-[14px] leading-5 -mt-3 font-semibold" role="alert">
                      Product names can be up to {NAME_MAX} characters ({preview.name.length} now).
                    </p>
                  )}
                  {preview.link && (
                    <p id="add-product-preview" className="text-[14px] leading-5 -mt-3 text-ink/80">
                      We&apos;ll call it <b className="font-semibold text-ink">{preview.name}</b>
                      {preview.link.platform ? ` and save it as your ${platformLabel(preview.link.platform)} link` : ""}. You can rename it later.
                    </p>
                  )}
                  <label className="flex flex-col gap-2">
                    <span className="text-[14px] leading-5 font-semibold">
                      Brand <span className="font-medium text-ink/75">(optional)</span>
                    </span>
                    <input className="input h-12 px-[18px] text-[16px] font-normal" placeholder="Amul" value={brand} maxLength={BRAND_MAX} onChange={(e) => setBrand(e.target.value)} />
                  </label>
                  <details className="group border-t border-ink/20 pt-4">
                    <summary className="cursor-pointer text-[14px] font-semibold text-slate select-none">
                      Advanced pricing <span className="font-medium text-ink/75">(optional — you can set this later in Settings)</span>
                    </summary>
                    <div className="grid gap-4 sm:grid-cols-3 pt-4">
                      <label className="flex flex-col gap-2 min-w-0">
                        <span className="text-[14px] leading-5 font-semibold">Cost price (₹)</span>
                        <input type="number" inputMode="decimal" min={0} step="0.01" className="input h-12 px-[18px] text-[16px] font-normal" value={pricing.cost} onChange={(e) => setPricing({ ...pricing, cost: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-2 min-w-0">
                        <span className="text-[14px] leading-5 font-semibold">Commission (%)</span>
                        <input type="number" inputMode="decimal" min={0} max={60} step="0.1" placeholder="e.g. 25" className="input h-12 px-[18px] text-[16px] font-normal" value={pricing.commission} onChange={(e) => setPricing({ ...pricing, commission: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-2 min-w-0">
                        <span className="text-[14px] leading-5 font-semibold">MRP (₹)</span>
                        <input type="number" inputMode="decimal" min={0} step="0.01" className="input h-12 px-[18px] text-[16px] font-normal" value={pricing.mrp} onChange={(e) => setPricing({ ...pricing, mrp: e.target.value })} />
                      </label>
                    </div>
                    <label className="flex flex-col gap-2 pt-4">
                      <span className="text-[14px] leading-5 font-semibold">Price sensitivity</span>
                      <select
                        className="input h-12 px-[18px] text-[16px] font-normal cursor-pointer"
                        value={pricing.sensitivity}
                        onChange={(e) => setPricing({ ...pricing, sensitivity: e.target.value as PriceSensitivity })}
                      >
                        {SENSITIVITY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label} — suggest a price change above a {o.pct}% gap
                          </option>
                        ))}
                      </select>
                      <span className="text-[13px] leading-5 text-ink/80">{SENSITIVITY_OPTIONS.find((o) => o.value === pricing.sensitivity)?.blurb}</span>
                    </label>
                    {pricingError && (
                      <p className="text-[13px] leading-5 font-semibold bg-sand border-2 border-ink rounded-[8px] px-2 py-1 mt-3" role="alert">
                        {pricingError}
                      </p>
                    )}
                  </details>
                </div>
                <button type="submit" className="btn btn-primary h-12 mt-6 w-full" disabled={!input.trim() || nameTooLong || !!pricingError || busy}>
                  {busy ? "Finding competitors…" : product ? "Try again →" : "Find competitors →"}
                </button>
              </form>
            )}

            {step === 2 && (
              <>
                <p className="text-[16px] leading-6 text-ink/80 mt-1">We found similar products. Pick the ones to track.</p>
                {suggestSource && suggestSource !== "tinyfish" && suggestions.length > 0 && (
                  <p className="mt-3 inline-flex items-center gap-2 rounded-[10px] border-2 border-ink bg-sand px-3 py-1.5 text-[13px] leading-5 font-semibold">
                    Demo suggestions · live competitor search needs a TinyFish API key. Edit or add real rivals later in settings.
                  </p>
                )}
                <ul className="flex flex-col gap-3 mt-6 stagger">
                  {suggestions.length === 0 && <li className="text-[15px] text-ink/75">No suggestions found — you can add rivals later in settings.</li>}
                  {suggestions.map((s, i) => {
                    const isSaved = saved.has(keyOf(s));
                    const on = isSaved || picked.has(i);
                    return (
                    <li key={i}>
                      <label
                        className={`flex items-center gap-3 border-2 border-ink rounded-[12px] px-4 py-3 transition-colors ${isSaved ? "cursor-default" : "cursor-pointer"} ${
                          on ? "bg-sage/50 shadow-[3px_3px_0_var(--ink)]" : "bg-linen hover:bg-ink/5"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={isSaved || busy}
                          onChange={() => setPicked(toggle(picked, i))}
                          className="accent-[var(--slate)] size-4 shrink-0"
                        />
                        <span className="font-semibold text-[15px] flex-1 min-w-0 break-words">{s.name}</span>
                        {isSaved && <span className="chip bg-sage shrink-0">✓ Saved</span>}
                        <span className="chip bg-linen shrink-0">{platformLabel(s.platform)}</span>
                      </label>
                    </li>
                    );
                  })}
                </ul>
                {competitorsOver && (
                  <p className="text-[14px] mt-3 font-semibold" role="alert">
                    Your plan tracks up to {competitorLimit} competitors per product. Unselect {picked.size - competitorLimit!}, or upgrade in Settings.
                  </p>
                )}
                <div className="flex gap-3 mt-6">
                  <button type="button" className="btn btn-ghost h-12" disabled={busy} onClick={() => setStep(1)}>
                    Back
                  </button>
                  <button type="button" className="btn btn-primary h-12 flex-1" disabled={busy || competitorsOver} onClick={saveCompetitors}>
                    {busy ? "Saving…" : picked.size ? `Track ${picked.size} competitor${picked.size === 1 ? "" : "s"} →` : "Skip for now →"}
                  </button>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <p className="text-[14px] leading-5 font-semibold mt-6 mb-2" id="add-product-platforms">
                  Platforms
                </p>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="add-product-platforms">
                  {(plans.data?.platforms ?? ["zepto", "instamart", "amazon", "flipkart", "blinkit"]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="pill"
                      data-active={platforms.has(p)}
                      aria-pressed={platforms.has(p)}
                      disabled={busy}
                      onClick={() => {
                        setPlatforms(toggle(platforms, p));
                        setPinsSaved(false);
                      }}
                    >
                      {platforms.has(p) ? "✓ " : ""}
                      {platformLabel(p)}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-6 mb-2">
                  <p className="text-[14px] leading-5 font-semibold">Pincodes</p>
                  <span className={`text-[14px] font-medium ${overLimit ? "text-ink font-semibold bg-sand px-2 rounded-md" : "text-ink/80"}`} aria-live="polite">
                    {codes.size} selected{limit != null ? ` · plan allows ${limit}` : ""}
                  </span>
                </div>
                <label className="block mb-3">
                  <span className="sr-only">Filter pincodes</span>
                  <input
                    className="input h-10 px-4 text-[15px] font-normal"
                    placeholder="Filter by pincode, area or city"
                    value={pinFilter}
                    onChange={(e) => setPinFilter(e.target.value)}
                  />
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto p-1 -m-1">
                  {!pincodes.data && pincodes.error && (
                    <div className="col-span-full flex flex-wrap items-center gap-3 text-[14px]" role="alert">
                      <span className="font-semibold">Couldn&apos;t load pincodes: {errorMessage(pincodes.error)}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => pincodes.mutate()}>
                        Try again
                      </button>
                    </div>
                  )}
                  {!pincodes.data && !pincodes.error && <p className="text-[14px] text-ink/75 col-span-full">Loading pincodes…</p>}
                  {pincodes.data && shownPins.length === 0 && <p className="text-[14px] text-ink/75 col-span-full">No pincodes match “{pinFilter}”.</p>}
                  {shownPins.map((pc) => (
                    <label
                      key={pc.code}
                      className={`flex items-center gap-2 border-2 border-ink rounded-[12px] px-3 py-2 text-[14px] cursor-pointer transition-colors ${codes.has(pc.code) ? "bg-sage/50" : "bg-linen hover:bg-ink/5"}`}
                    >
                      <input
                        type="checkbox"
                        checked={codes.has(pc.code)}
                        disabled={busy}
                        onChange={() => {
                          setCodes(toggle(codes, pc.code));
                          setPinsSaved(false);
                        }}
                        className="accent-[var(--slate)] size-4 shrink-0"
                      />
                      <b className="font-semibold">{pc.code}</b> <span className="truncate text-ink/80">{pc.area_name}</span>
                    </label>
                  ))}
                </div>
                {overLimit && <p className="text-[14px] mt-3">Your plan allows {limit} pincodes per product. Unselect a few, or upgrade in Settings.</p>}
                <div className="flex gap-3 mt-6">
                  <button type="button" className="btn btn-ghost h-12" disabled={busy} onClick={() => setStep(2)}>
                    Back
                  </button>
                  <button type="button" className="btn btn-primary h-12 flex-1" disabled={busy || !codes.size || !platforms.size || overLimit} onClick={finish}>
                    {busy ? "Starting first check…" : "Start first check →"}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {error && (
          <p className="text-[14px] font-semibold mt-4 bg-sand border-2 border-ink rounded-[12px] px-4 py-3" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
