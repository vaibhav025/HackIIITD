"use client";

import { useState } from "react";
import { ScreenshotThumb } from "@/components/agent/parts";
import { CardSkeleton, ErrorCard } from "@/components/ui";
import { useApi } from "@/lib/api";
import { etaLabel, platformLabel, rupees, timeAgo } from "@/lib/format";
import type { CheckResultDetail, RunDetail, RunResultRef } from "@/lib/types";

const METHOD: Record<NonNullable<RunResultRef["method"]>, { label: string; hint: string }> = {
  agent: { label: "TinyFish Agent", hint: "Real browser session; delivery pincode set on the app" },
  fetch: { label: "TinyFish Fetch", hint: "Product page read directly; same for every pincode" },
  browser: { label: "TinyFish Browser", hint: "Remote browser session driven step by step" },
  cached: { label: "Cached", hint: "Saved result from an earlier live check (live check failed or demo mode)" },
  simulated: { label: "Simulated", hint: "Demo data from the built-in simulator" },
};

function outcome(r: RunResultRef) {
  if (r.status !== "ok") return { label: "Failed", cls: "bg-linen border-dashed" };
  if (r.exact_match === false) return { label: "Not listed", cls: "bg-linen border-dashed" };
  if (r.in_stock === true) return { label: "In stock", cls: "bg-sage text-ink" };
  if (r.in_stock === false) return { label: "Out of stock", cls: "bg-sand text-ink" };
  return { label: "Unknown", cls: "bg-linen" };
}

function Steps({ id }: { id: string }) {
  const detail = useApi<CheckResultDetail>(`/check-results/${id}`);
  if (detail.error) return <ErrorCard error={detail.error} onRetry={() => detail.mutate()} />;
  if (!detail.data) return <CardSkeleton rows={3} />;
  const steps = detail.data.agent?.steps ?? [];
  if (!steps.length) return <p className="text-[13px] text-ink/70">No step trace was stored for this check.</p>;
  return (
    <ol className="flex flex-col gap-1.5 text-[13px]">
      {steps.map((s) => (
        <li key={s.index} className="grid grid-cols-[52px_84px_1fr] gap-2 items-baseline min-w-0">
          <span className="tabular-nums text-ink/60">{(s.ms / 1000).toFixed(1)}s</span>
          <span className="font-semibold uppercase tracking-wide text-[11px] text-slate">{s.kind}</span>
          <span className="min-w-0 break-words">
            {s.label}
            {s.detail ? <span className="text-ink/60"> · {s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CheckRow({ r }: { r: RunResultRef }) {
  const [open, setOpen] = useState(false);
  const o = outcome(r);
  const method = METHOD[r.method ?? "simulated"];
  return (
    <li className="card p-5 flex flex-col gap-4 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <p className="font-semibold text-[17px] leading-tight">{platformLabel(r.platform)}</p>
          <p className="text-[13px] text-ink/75">
            {r.pincode}
            {r.area ? ` · ${r.area}` : ""}
            {r.competitor_id ? " · competitor" : " · your listing"}
          </p>
        </div>
        <span className={`rounded-full border-2 border-ink px-3 py-0.5 text-[12px] font-bold uppercase tracking-wide ${o.cls}`}>
          {o.label}
        </span>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-[14px]">
        <div className="min-w-0">
          <dt className="eyebrow text-[11px] text-slate">Price</dt>
          <dd className="font-semibold tabular-nums">
            {r.price != null ? rupees(r.price, 2) : "—"}
            {r.mrp != null && r.price != null && r.mrp > r.price ? (
              <span className="block text-[12px] text-ink/55 line-through font-normal">MRP {rupees(r.mrp, 2)}</span>
            ) : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow text-[11px] text-slate">Delivery</dt>
          <dd className="font-semibold">{r.delivery_text ?? (etaLabel(r.eta_minutes) || "—")}</dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow text-[11px] text-slate">Method</dt>
          <dd className="font-semibold" title={method.hint}>
            {method.label}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow text-[11px] text-slate">Checked</dt>
          <dd className="font-semibold">{r.checked_at ? timeAgo(r.checked_at) : "—"}</dd>
        </div>
      </dl>

      <p className="text-[13px] text-ink/75">
        {method.hint}
        {r.method === "fetch" || r.pincode_specific === false ? " (not specific to this pincode)." : "."}
      </p>
      {r.error ? <p className="text-[13px] font-semibold text-ink">Why it failed: {r.error}</p> : null}
      {r.notes?.length ? (
        <ul className="text-[13px] text-ink/75 list-disc pl-5">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {r.screenshot_url ? <ScreenshotThumb url={r.screenshot_url} alt={`${platformLabel(r.platform)} at ${r.pincode} — evidence`} className="max-w-[220px]" /> : null}
        {r.source_url ? (
          <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
            Open product page ↗
          </a>
        ) : null}
        {r.step_count ? (
          <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide steps" : `Show ${r.step_count} agent steps`}
          </button>
        ) : null}
      </div>
      {open ? <Steps id={r.id} /> : null}
    </li>
  );
}

/** Every check in a run with its full result, method, evidence and agent steps. */
export default function CheckDetails({ runId, active }: { runId: string; active: boolean }) {
  const run = useApi<RunDetail>(`/runs/${runId}`, { refreshInterval: active ? 5000 : 0 });
  if (run.error) return <ErrorCard error={run.error} onRetry={() => run.mutate()} />;
  if (!run.data) return <CardSkeleton rows={4} />;
  const results = run.data.results ?? [];
  return (
    <section className="flex flex-col gap-4" aria-label="Check details">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Check details</h2>
        <p className="text-[14px] text-ink/75">
          {results.length} of {run.data.total_jobs} checks recorded
        </p>
      </div>
      {results.length ? (
        <ul className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {results.map((r) => (
            <CheckRow key={r.id} r={r} />
          ))}
        </ul>
      ) : (
        <p className="text-[14px] text-ink/75">No results yet — they appear here as each check finishes.</p>
      )}
    </section>
  );
}
