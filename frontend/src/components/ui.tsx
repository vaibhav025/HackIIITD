"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { isNetworkError } from "@/lib/api";
import { platformLabel } from "@/lib/format";
import CountUp from "./motion/CountUp";

/* ---------------------------------------------------------------- status */

/**
 * Status is never colour alone: each one carries an icon and a label.
 * Colours meet 4.5:1 for their text (ink on sage/sand/linen, linen on deep);
 * de-emphasised states use a dotted border and ink/75 text instead of opacity.
 */
export const STATUS_META: Record<string, { label: string; icon: string; cls: string }> = {
  in_stock: { label: "In stock", icon: "✓", cls: "bg-sage text-ink" },
  out_of_stock: { label: "Out of stock", icon: "✕", cls: "bg-linen text-ink border-dashed" },
  price_gap: { label: "Price gap", icon: "₹", cls: "bg-sand text-ink" },
  stale: { label: "Not checked recently", icon: "…", cls: "bg-linen text-ink/75 border-dotted" },
  not_tracked: { label: "Not tracked", icon: "–", cls: "bg-linen text-ink/75 border-dotted" },
  failed: { label: "Check failed", icon: "!", cls: "bg-deep text-linen" },
};

const metaOf = (status: string) => STATUS_META[status] ?? STATUS_META.stale;

/**
 * 24px round status dot from the design (sage + check uses the Figma asset).
 * `context` (e.g. "110017 · Blinkit") is prefixed to the accessible name.
 */
export function StatusDot({ status, size = 24, context }: { status: string; size?: number; context?: string }) {
  const m = metaOf(status);
  const name = context ? `${context}: ${m.label}` : m.label;
  if (status === "in_stock")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/figma/shell/pin-in-stock.svg" alt={name} title={name} width={size} height={size} className="shrink-0" />;
  return (
    <span
      role="img"
      title={name}
      aria-label={name}
      className={`grid place-items-center shrink-0 rounded-full border-2 border-ink font-bold ${m.cls}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      <span aria-hidden>{m.icon}</span>
    </span>
  );
}

export function PincodeStrip({ strip, size = 24 }: { strip: { pincode: string; status: string; platform: string }[]; size?: number }) {
  if (!strip.length) return <p className="text-sm text-ink/75">No checks yet</p>;
  return (
    <div className="flex flex-wrap gap-1.5" role="list" aria-label="Pincode status">
      {strip.map((s) => (
        <span role="listitem" key={`${s.platform}-${s.pincode}`} className="contents">
          <StatusDot status={s.status} size={size} context={`${s.pincode} · ${platformLabel(s.platform)}`} />
        </span>
      ))}
    </div>
  );
}

/** Status chip: icon + visible label (compact keeps the label for screen readers only). */
export function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const m = metaOf(status);
  return (
    <span className={`chip ${m.cls}`} title={m.label}>
      <span aria-hidden>{m.icon}</span>
      {compact ? <span className="sr-only">{m.label}</span> : m.label}
    </span>
  );
}

const PRIORITY_META: Record<string, { cls: string; label: string }> = {
  high: { cls: "bg-ink text-linen", label: "High" },
  medium: { cls: "bg-sand", label: "Medium" },
  low: { cls: "bg-linen", label: "Low" },
};

export function PriorityBadge({ priority }: { priority: string }) {
  const m = PRIORITY_META[priority] ?? PRIORITY_META.low;
  return (
    <span className={`chip ${m.cls}`}>
      <span className="sr-only">Priority: </span>
      {m.label}
    </span>
  );
}

export function Sticker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`sticker ${className}`}>{children}</span>;
}

/* ----------------------------------------------------------------- tiles */

/**
 * Big coloured stat tile: eyebrow, 80px Fraunces number, caption.
 * Pass `count` (+ optional `format`, `suffix`) instead of `value` to count the number up.
 */
export function StatTile({
  eyebrow,
  value,
  count,
  format,
  suffix,
  caption,
  tone = "linen",
  height = 200,
  children,
}: {
  eyebrow: string;
  value?: ReactNode;
  count?: number;
  format?: (n: number) => string;
  suffix?: ReactNode;
  caption?: ReactNode;
  tone?: "ink" | "sand" | "sage" | "slate" | "linen";
  height?: number;
  children?: ReactNode;
}) {
  const bg = { ink: "bg-ink text-linen", sand: "bg-sand text-ink", sage: "bg-sage text-ink", slate: "bg-slate text-linen", linen: "bg-linen text-ink" }[tone];
  return (
    <div className={`card ${bg} flex flex-col gap-4 p-[26px] min-w-0`} style={{ minHeight: height }}>
      <p className="eyebrow">{eyebrow}</p>
      {/* Number sits a fixed step under the eyebrow and the caption pins to the bottom, so
          numbers line up across a row of tiles even when one caption wraps. */}
      {(count != null || value != null) && (
        <p className="font-display text-[64px] leading-[68px] sm:text-[80px] sm:leading-[80px] tracking-[-1.6px]">
          {count != null ? (
            <>
              <CountUp value={count} format={format} />
              {suffix}
            </>
          ) : (
            value
          )}
        </p>
      )}
      {caption != null && <p className="mt-auto text-[15px] leading-[22.5px] font-semibold">{caption}</p>}
      {children}
    </div>
  );
}

export function Skeleton({ className = "h-6 w-full" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card p-6 space-y-3" role="status" aria-label="Loading">
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- errors */

export function ErrorCard({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const network = isNetworkError(error);
  const message = error instanceof Error && error.message ? error.message.replace(/\.$/, "") : "Something went wrong";
  return (
    <div className="card p-6 bg-sand" role="alert">
      <p className="font-semibold text-lg">Couldn&apos;t load this.</p>
      <p className="text-[15px] mt-1">
        {network ? "We couldn't reach the ShelfSense server. Check your connection, or that the backend is running." : `${message}.`}
      </p>
      {onRetry && (
        <button className="btn btn-ghost btn-sm mt-4" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border-2 border-dashed border-ink/40 rounded-[20px] p-8 text-center">
      <p className="font-display text-2xl">{title}</p>
      {children && <div className="text-[15px] mt-2 text-ink/80">{children}</div>}
    </div>
  );
}

/** Section heading (Fraunces 32) with the design's 2px divider. */
export function SectionTitle({ children, action, size = 32 }: { children: ReactNode; action?: ReactNode; size?: number }) {
  return (
    <div className="section-head mb-6">
      <h2 style={{ fontSize: size, lineHeight: 1.25, letterSpacing: -size * 0.02 }}>{children}</h2>
      {action}
    </div>
  );
}

export function Sparkline({
  values,
  width = 120,
  height = 36,
  stroke = "var(--ink)",
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values
    .map((v, i) => (v == null ? null : `${i * step},${height - 4 - ((v - min) / span) * (height - 8)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Usage bar. `dark` = linen text on ink (plan tile); default = ink on linen.
 * `max == null` means the plan has no limit: shows "Unlimited" and an empty track.
 */
export function Meter({ value, max, label, dark }: { value: number; max: number | null | undefined; label: string; dark?: boolean }) {
  const limited = max != null && max > 0;
  const ratio = limited ? Math.min(1, value / max) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className={`flex justify-between gap-3 text-[14px] leading-[21px] font-medium ${dark ? "text-linen" : "text-ink"}`}>
        <span className="min-w-0">
          {label}{" "}
          <span className="whitespace-nowrap tabular-nums">
            <CountUp value={value} />
            {limited ? `/${max}` : ""}
          </span>
        </span>
        {!limited && <span className={dark ? "text-sand" : "text-slate"}>Unlimited</span>}
      </div>
      {/* Fill slides in with a transform; the rounded track clips it, so it looks like a width bar. */}
      <div
        className={`h-[10px] rounded-full overflow-hidden ${dark ? "bg-linen/20" : "bg-ink/15"}`}
        role={limited ? "progressbar" : undefined}
        aria-label={limited ? label : undefined}
        aria-valuenow={limited ? value : undefined}
        aria-valuemin={limited ? 0 : undefined}
        aria-valuemax={limited ? max : undefined}
      >
        {limited && (
          <div className="h-full bg-sand rounded-full transition-transform duration-500" style={{ transform: `translateX(${(ratio - 1) * 100}%)` }} />
        )}
      </div>
    </div>
  );
}

/**
 * Design toggle: slate track + linen knob when on, linen track when off.
 * `hideLabel` keeps `label` as the accessible name without showing it.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hideLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex items-center gap-3 select-none text-[15px] font-semibold ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      {label && !hideLabel && <span>{label}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-[52px] h-[28px] rounded-full border-2 border-ink transition-colors disabled:cursor-not-allowed ${checked ? "bg-slate" : "bg-linen"}`}
      >
        <span
          className={`absolute left-[3px] top-1/2 -translate-y-1/2 size-[20px] rounded-full border-2 border-ink transition-[translate,background-color] duration-200 ease-out ${checked ? "translate-x-[24px] bg-linen" : "bg-ink"}`}
        />
      </button>
    </label>
  );
}

/* --------------------------------------------------------------- dialogs */

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last: only the top one handles Esc / Tab. */
const dialogStack: HTMLElement[] = [];

function focusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}

/**
 * Modal dialog behaviour for `ref` while `open`:
 * - Esc calls `onClose` (the caller decides whether closing is allowed right now),
 * - Tab / Shift+Tab stay inside the dialog,
 * - initial focus goes to `initialFocus`, else the first `[data-autofocus]`, else the first focusable, else the dialog,
 * - focus returns to whatever was focused before the dialog opened,
 * - page scroll is locked while open.
 */
export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const first = initialFocus?.current ?? root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0];
    if (first) first.focus();
    else {
      if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      root.focus();
    }

    dialogStack.push(root);

    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== root) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === head || !root.contains(active))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (active === tail || !root.contains(active))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      dialogStack.splice(dialogStack.indexOf(root), 1);
      document.body.style.overflow = overflow;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open, ref, initialFocus]);
}

/** Holst modal shell: ink scrim + linen card. Click on the scrim or Esc → `onClose`. */
export function Modal({
  open = true,
  onClose,
  labelledBy,
  label,
  className = "max-w-[560px]",
  children,
  initialFocus,
}: {
  open?: boolean;
  onClose: () => void;
  labelledBy?: string;
  label?: string;
  className?: string;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y(ref, open, onClose, initialFocus);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[2000] bg-ink/60 grid place-items-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        className={`card w-full p-[26px] max-h-[90vh] overflow-y-auto outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean };

/**
 * Promise-based confirm in the Holst style (replaces window.confirm):
 * `const [confirmUi, confirm] = useConfirm(); … if (await confirm({ title: "Delete?" })) …; return <>{confirmUi}…</>`
 */
export function useConfirm(): [ReactNode, (o: ConfirmOptions) => Promise<boolean>] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  const settle = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
  };
  const ui = pending ? (
    <Modal onClose={() => settle(false)} labelledBy={`${id}-title`} className="max-w-[460px]" initialFocus={cancelRef}>
      <h2 id={`${id}-title`} className="text-[26px] leading-8 tracking-[-0.5px]">
        {pending.title}
      </h2>
      {pending.body && <div className="text-[15px] leading-[22.5px] text-ink/80 mt-2">{pending.body}</div>}
      <div className="flex flex-wrap justify-end gap-3 mt-6">
        <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => settle(false)}>
          {pending.cancelLabel ?? "Cancel"}
        </button>
        <button type="button" className={`btn ${pending.danger ? "btn-ink" : "btn-primary"}`} onClick={() => settle(true)}>
          {pending.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  ) : null;
  return [ui, ask];
}
