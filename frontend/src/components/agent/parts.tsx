"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { useMediaSrc } from "@/lib/api";
import { useFocusTrap, useScrollLock } from "@/lib/a11y";
import { platformLabel, rupees, rupeesPrecise } from "@/lib/format";
import type { TinyFishMode, TruePrice } from "@/lib/types";

/** Platform identity chip colours: each brand's hue, held inside the Holst 2px-ink outline. */
export const PLATFORM_STYLE: Record<string, { bg: string; fg: string; mark: string }> = {
  blinkit: { bg: "#f8cb46", fg: "#0d1b2a", mark: "b" },
  zepto: { bg: "#5a2d82", fg: "#f4f1de", mark: "z" },
  instamart: { bg: "#fc8019", fg: "#0d1b2a", mark: "i" },
  amazon: { bg: "#232f3e", fg: "#ff9900", mark: "a" },
  flipkart: { bg: "#2874f0", fg: "#f4f1de", mark: "f" },
};

export function PlatformMark({ platform, size = 28 }: { platform: string; size?: number }) {
  const s = PLATFORM_STYLE[platform] ?? { bg: "var(--sand)", fg: "var(--ink)", mark: platform.slice(0, 1) || "?" };
  return (
    <span
      aria-hidden
      className="grid place-items-center shrink-0 rounded-[8px] border-2 border-ink font-display lowercase"
      style={{ width: size, height: size, background: s.bg, color: s.fg, fontSize: Math.round(size * 0.55), lineHeight: 1 }}
    >
      {s.mark}
    </span>
  );
}

/** `TinyFish · Simulated` / `TinyFish · Live` badge. */
export function ModeBadge({ mode, className = "" }: { mode: TinyFishMode | null | undefined; className?: string }) {
  const live = mode === "live";
  return (
    <span
      className={`inline-flex items-center gap-2 border-2 border-ink rounded-full px-3 py-[3px] text-[12px] font-bold tracking-[0.6px] uppercase whitespace-nowrap ${
        live ? "bg-sage text-ink" : "bg-sand text-ink"
      } ${className}`}
      title={live ? "Real TinyFish web agents are browsing the platforms" : "No TinyFish key configured: agents are simulated with deterministic data"}
    >
      <span aria-hidden className={live ? "ss-live-dot bg-ink!" : "size-2 rounded-full border-2 border-ink"} />
      TinyFish · {mode ? (live ? "Live" : "Simulated") : "…"}
    </span>
  );
}

/** Item + fees − offer = what a shopper really pays at checkout. */
export function TruePriceBreakdown({ price, compact }: { price: TruePrice; compact?: boolean }) {
  const rows: { label: string; value: string; strong?: boolean }[] = [];
  if (price.item != null) rows.push({ label: "Item", value: rupeesPrecise(price.item) });
  if (price.handling_fee != null) rows.push({ label: "Handling", value: `+ ${rupeesPrecise(price.handling_fee)}` });
  if (price.delivery_fee != null) rows.push({ label: "Delivery", value: price.delivery_fee === 0 ? "Free" : `+ ${rupeesPrecise(price.delivery_fee)}` });
  if (price.offer) rows.push({ label: "Offer", value: `− ${rupeesPrecise(Math.abs(price.offer))}` });
  if (!rows.length && price.final == null) return null;
  return (
    <div className={`border-2 border-ink rounded-[12px] bg-linen ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <p className="label text-ink! mb-1">True price at checkout</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-[13px] leading-5 tabular-nums">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink/75">{r.label}</dt>
            <dd className="text-right font-medium">{r.value}</dd>
          </div>
        ))}
        {price.final != null && (
          <div className="contents">
            <dt className="font-semibold border-t-2 border-ink mt-1 pt-1">Shopper pays</dt>
            <dd className="text-right font-display text-[18px] leading-6 border-t-2 border-ink mt-1 pt-1">{rupees(price.final, price.final % 1 ? 2 : 0)}</dd>
          </div>
        )}
      </dl>
      <p className="text-[11px] text-ink/70 mt-1">Read at checkout · no order is ever placed</p>
    </div>
  );
}

/** Evidence screenshot thumbnail; opens a focus-trapped lightbox. */
export function ScreenshotThumb({ url, alt, className = "" }: { url: string | null | undefined; alt: string; className?: string }) {
  const src = useMediaSrc(url);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!url) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!src || failed}
        className={`group relative block overflow-hidden rounded-[10px] border-2 border-ink bg-ink/5 aspect-[16/10] press press-2 ${className}`}
        aria-label={`View evidence screenshot: ${alt}`}
      >
        {src && !failed ? (
          <img src={src} alt="" loading="lazy" className="h-full w-full object-cover object-top" onError={() => setFailed(true)} />
        ) : (
          <span className="grid h-full place-items-center text-[12px] text-ink/70">{failed ? "Screenshot unavailable" : <span className="ss-spin" />}</span>
        )}
        <span className="absolute bottom-1 right-1 bg-ink text-linen text-[10px] font-bold uppercase tracking-[0.6px] rounded-[5px] px-1.5 py-px opacity-90">
          Evidence
        </span>
      </button>
      {open && src && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Lightbox({ src, alt, onClose, caption }: { src: string; alt: string; onClose: () => void; caption?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: onClose, initialFocus: "[data-close]" });
  useScrollLock(true);
  return (
    <div className="fixed inset-0 z-[2600] bg-ink/80 grid place-items-center p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={alt}
        className="card p-3 max-w-[min(960px,100%)] w-full"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "rise 200ms ease both" }}
      >
        <div className="flex items-center justify-between gap-3 px-1 pb-2">
          <p className="font-semibold text-[15px] truncate">{alt}</p>
          <button type="button" data-close className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <img src={src} alt={alt} className="w-full h-auto max-h-[75vh] object-contain rounded-[10px] border-2 border-ink bg-linen" />
        {caption && <div className="px-1 pt-2 text-[13px] text-ink/80">{caption}</div>}
      </div>
    </div>
  );
}

export const whoLabel = (competitorId: string | null, name?: string | null) =>
  competitorId ? name || "Rival listing" : "Your listing";

export const jobTitle = (platform: string, pincode: string, who: string) => `${platformLabel(platform)} · ${pincode} · ${who}`;
