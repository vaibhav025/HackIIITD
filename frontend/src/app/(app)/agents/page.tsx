"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import AgentConsole from "@/components/agent/AgentConsole";
import CheckDetails from "@/components/agent/CheckDetails";
import { ModeBadge } from "@/components/agent/parts";
import { useReplayState, useRunTraces } from "@/components/agent/useReplay";
import { CardSkeleton, Empty, ErrorCard, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { duration, formatDateTime, timeAgo, useDisplayTimeZone } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import type { AppStatus, Competitor, ProductCard, RunSummary, TinyFishUsage } from "@/lib/types";
import { isActiveRunStatus, useRun } from "@/lib/useRun";

const STATUS: Record<string, { label: string; icon: string; cls: string }> = {
  done: { label: "Done", icon: "✓", cls: "bg-sage text-ink" },
  partial: { label: "Partial", icon: "!", cls: "bg-sand text-ink" },
  failed: { label: "Failed", icon: "✕", cls: "bg-linen border-dashed" },
  cancelled: { label: "Cancelled", icon: "–", cls: "bg-linen border-dashed" },
  running: { label: "Running", icon: "", cls: "bg-slate text-linen" },
  queued: { label: "Queued", icon: "…", cls: "bg-linen" },
};

function RunStatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, icon: "·", cls: "bg-linen" };
  return (
    <span className={`chip ${s.cls} whitespace-nowrap`}>
      {status === "running" ? <span className="ss-spin size-3! border-[1.5px]! border-linen/40! border-t-linen!" aria-hidden /> : <span aria-hidden>{s.icon}</span>}
      {s.label}
    </span>
  );
}

function UsageTiles({ usage }: { usage: TinyFishUsage }) {
  const budget = usage.daily_budget;
  const pctUsed = budget ? Math.min(1, usage.credits_today / budget) : 0;
  const tiles = [
    {
      eyebrow: "Credits today",
      value: String(usage.credits_today),
      caption: budget == null ? "Unlimited daily budget" : `of ${budget} daily budget`,
      tone: "bg-linen text-ink",
      meter: budget == null ? null : pctUsed,
    },
    { eyebrow: "Runs today", value: String(usage.runs_today), caption: "Manual + scheduled", tone: "bg-sand text-ink", meter: null },
    {
      eyebrow: "Success, 7 days",
      value: usage.success_rate_7d == null ? "—" : `${Math.round(usage.success_rate_7d * (usage.success_rate_7d <= 1 ? 100 : 1))}%`,
      caption: "Checks that returned data",
      tone: "bg-sage text-ink",
      meter: null,
    },
    { eyebrow: "Parallel agents", value: String(usage.concurrency), caption: "Browser sessions at once", tone: "bg-linen text-ink", meter: null },
  ];
  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 stagger" aria-label="TinyFish usage">
      {tiles.map((t) => (
        <div key={t.eyebrow} className={`card ${t.tone} p-[26px] flex flex-col justify-between gap-3 min-h-[170px] min-w-0`}>
          <p className="eyebrow">{t.eyebrow}</p>
          <p className="font-display text-[48px] leading-none tracking-[-1px] tabular-nums">{t.value}</p>
          <div className="flex flex-col gap-2">
            <p className="text-[14px] font-semibold">{t.caption}</p>
            {t.meter != null && (
              <span className="h-2 rounded-full bg-ink/15 overflow-hidden" aria-hidden>
                <span className="block h-full bg-sand origin-left" style={{ transform: `scaleX(${t.meter})` }} />
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

const APP_STATUS_STYLE: Record<AppStatus["status"], { label: string; tone: string }> = {
  live: { label: "Live", tone: "bg-sage text-ink" },
  cached: { label: "Cached", tone: "bg-sand text-ink" },
  unavailable: { label: "Unavailable", tone: "bg-linen text-ink/70 border-dashed" },
  simulated: { label: "Simulated", tone: "bg-linen text-ink" },
};
const METHOD_LABEL: Record<AppStatus["method"], string> = {
  agent: "Agent API · per pincode",
  fetch: "Fetch API · listing-wide",
  simulated: "Simulator",
  none: "Not checked",
};

function AppStatusPanel({ apps }: { apps: AppStatus[] }) {
  return (
    <section className="flex flex-col gap-4" aria-label="App status">
      <h2 className="text-[28px] leading-tight tracking-[-0.5px]">Apps</h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {apps.map((app) => {
          const style = APP_STATUS_STYLE[app.status];
          return (
            <li key={app.platform} className="card p-5 flex flex-col gap-3 min-w-0">
              <div className="flex flex-col items-start gap-2">
                <p className="font-semibold text-[16px] leading-tight">{app.label}</p>
                <span className={`rounded-full border-2 border-ink px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-wide ${style.tone}`}>
                  {style.label}
                </span>
              </div>
              <p className="text-[13px] font-semibold text-slate">{METHOD_LABEL[app.method]}</p>
              <p className="text-[13px] leading-[19px] text-ink/80">{app.detail}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function runDuration(r: RunSummary) {
  if (!r.started_at) return "—";
  const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now();
  return duration(end - new Date(r.started_at).getTime());
}

function RunList({ runs, selected, onSelect }: { runs: RunSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  useDisplayTimeZone();
  return (
    <ul className="flex flex-col gap-3" aria-label="Recent agent runs">
      {runs.map((r) => {
        const on = r.id === selected;
        const ok = Math.max(0, r.done_jobs - r.failed_jobs);
        return (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              aria-current={on ? "true" : undefined}
              className={`w-full text-left rounded-[16px] border-2 border-ink px-4 py-3 press press-3 flex flex-col gap-1.5 ${on ? "bg-sand" : "bg-linen"}`}
            >
              <span className="flex items-center justify-between gap-3 min-w-0">
                <span className="font-semibold text-[15px] truncate">{r.product_name ?? "Product"}</span>
                <RunStatusChip status={r.status} />
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink/80">
                <span className="tabular-nums">
                  {ok}/{r.total_jobs} ok{r.failed_jobs ? ` · ${r.failed_jobs} failed` : ""}
                </span>
                <span>{r.credits_used} credits</span>
                <span className="capitalize">{r.trigger}</span>
                <span title={r.started_at ? formatDateTime(r.started_at) : undefined}>{timeAgo(r.started_at)}</span>
                <span className="tabular-nums">{runDuration(r)}</span>
                {r.mode && <span className="uppercase text-[11px] font-bold tracking-[0.6px] text-slate">{r.mode}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useCompetitorNames(productId: string | null | undefined) {
  const { data } = useApi<Competitor[]>(productId ? `/products/${productId}/competitors` : null);
  return useMemo(() => new Map((data ?? []).map((c) => [c.id, c.name])), [data]);
}

/** A finished run, re-played from its stored agent traces. */
function ReplayPanel({ run }: { run: RunSummary }) {
  const traces = useRunTraces(run.id);
  const [nonce, setNonce] = useState(0);
  const names = useCompetitorNames(run.product_id);
  const { run: state, playing } = useReplayState(traces, nonce);
  const [reduced, setReduced] = useState(false);
  useEffect(() => setReduced(prefersReducedMotion()), []);

  if (!traces || traces.loading) return <CardSkeleton rows={4} />;
  if (traces.error) return <ErrorCard error={traces.error} onRetry={traces.reload} />;
  if (!state) return null;
  return (
    <AgentConsole
      run={state}
      names={names}
      replay
      title={run.product_name ? `${run.product_name}` : "Agent run"}
      actions={
        <button
          type="button"
          className="btn btn-sand btn-sm"
          onClick={() => setNonce((n) => n + 1)}
          disabled={playing || reduced || !traces.jobs.some((j) => j.steps.length)}
          title={reduced ? "Replay animation is off because your system asks for reduced motion" : undefined}
        >
          {playing ? "Replaying…" : "▶ Replay run"}
        </button>
      }
    />
  );
}

/** A run that's still going: follow it live over SSE. */
function LivePanel({ run, onDone }: { run: RunSummary; onDone: () => void }) {
  const live = useRun(run.product_id, onDone);
  const names = useCompetitorNames(run.product_id);
  const { attach } = live;
  useEffect(() => {
    attach(run.id, run.total_jobs, run.started_at);
  }, [attach, run.id, run.total_jobs, run.started_at]);
  if (!live.run) return <CardSkeleton rows={4} />;
  return <AgentConsole run={live.run} names={names} title={run.product_name ?? "Live run"} />;
}

function AgentsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const productFilter = params.get("product");
  const selectedParam = params.get("run");

  const usage = useApi<TinyFishUsage>("/tinyfish/usage", { refreshInterval: 30_000 });
  const apps = useApi<AppStatus[]>("/tinyfish/apps", { refreshInterval: 60_000 });
  const products = useApi<ProductCard[]>("/products");
  const runsKey = `/runs?limit=20${productFilter ? `&product_id=${encodeURIComponent(productFilter)}` : ""}`;
  const anyActive = (d?: RunSummary[]) => !!d?.some((r) => isActiveRunStatus(r.status));
  const runs = useApi<RunSummary[]>(runsKey, { refreshInterval: (d) => (anyActive(d) ? 5000 : 0), keepPreviousData: true });

  const list = runs.data ?? [];
  const selected = list.find((r) => r.id === selectedParam) ?? list[0] ?? null;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "product") next.delete("run");
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-10">
      <header data-mochi="agents-head" className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2 max-w-[720px]">
          <p className="eyebrow text-slate">TinyFish web agents</p>
          <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px]">Agents</h1>
          <p className="text-[17px] leading-[27px] text-ink/85">
            Quick-commerce checks are real TinyFish agent sessions: the agent opens the app, sets the delivery pincode, finds the listing
            and reads price, stock and delivery time (1 credit per attempt). Amazon and Flipkart pages are read with the TinyFish Fetch
            API: free, and the same for every pincode. Every check is read-only: no cart, no checkout, no login.
          </p>
        </div>
        <ModeBadge mode={usage.data?.mode} className="text-[13px]! px-4! py-1.5!" />
      </header>

      {usage.error ? (
        <ErrorCard error={usage.error} onRetry={() => usage.mutate()} />
      ) : usage.data ? (
        <UsageTiles usage={usage.data} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[170px] rounded-[20px]" />
          ))}
        </div>
      )}

      {apps.error ? (
        <ErrorCard error={apps.error} onRetry={() => apps.mutate()} />
      ) : apps.data ? (
        <AppStatusPanel apps={apps.data} />
      ) : (
        <Skeleton className="h-[150px] rounded-[20px]" />
      )}

      <section data-mochi="agents-runs" className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div data-mochi="agents-runlist" className="lg:col-span-4 flex flex-col gap-4 min-w-0">
          <div className="section-head">
            <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Recent runs</h2>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="label">Product</span>
            <select className="input py-2.5" value={productFilter ?? ""} onChange={(e) => setParam("product", e.target.value || null)}>
              <option value="">All products</option>
              {(products.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {runs.error ? (
            <ErrorCard error={runs.error} onRetry={() => runs.mutate()} />
          ) : !runs.data ? (
            <CardSkeleton rows={4} />
          ) : list.length === 0 ? (
            <Empty title="No runs yet">
              Start one with <b>Re-check now</b> on any{" "}
              <Link href="/products" className="underline font-semibold">
                product
              </Link>
              .
            </Empty>
          ) : (
            <RunList runs={list} selected={selected?.id ?? null} onSelect={(id) => setParam("run", id)} />
          )}
        </div>

        <div data-mochi="agents-replay" className="lg:col-span-8 min-w-0 flex flex-col gap-4">
          {selected ? (
            <>
              <div data-mochi="agents-player" className="flex flex-col gap-4 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[15px] text-ink/80">
                    {isActiveRunStatus(selected.status) ? "Live — following this run as it happens." : "Replaying the stored agent traces for this run."}
                    {selected.started_at && <> Started {formatDateTime(selected.started_at)}.</>}
                  </p>
                  <Link href={`/products/${selected.product_id}`} className="btn btn-ghost btn-sm">
                    Open product →
                  </Link>
                </div>
                {isActiveRunStatus(selected.status) ? (
                  <LivePanel key={selected.id} run={selected} onDone={() => {
                      runs.mutate();
                      usage.mutate();
                    }} />
                ) : (
                  <ReplayPanel key={selected.id} run={selected} />
                )}
              </div>
              <CheckDetails key={`details-${selected.id}`} runId={selected.id} active={isActiveRunStatus(selected.status)} />
            </>
          ) : runs.data && list.length === 0 ? null : (
            <CardSkeleton rows={5} />
          )}
        </div>
      </section>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<CardSkeleton rows={4} />}>
      <AgentsInner />
    </Suspense>
  );
}
