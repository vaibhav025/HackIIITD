"use client";

/* eslint-disable @next/next/no-img-element */
import { use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, downloadFile, errorMessage, useApi } from "@/lib/api";
import type { Competitor, CompetitorRow, GenerateResult, Overview, Product, Reviews, RunSummary, Weekly } from "@/lib/types";
import { FREQUENCY_LABEL, pct, platformLabel, rupees, timeAgo } from "@/lib/format";
import { refreshActionViews } from "@/lib/recommendations";
import { toast } from "@/lib/toast";
import { isActiveRunStatus, useRun } from "@/lib/useRun";
import ActionPlan from "@/components/ActionPlan";
import AgentConsole from "@/components/agent/AgentConsole";
import ProductHeader, { RecheckButton } from "@/components/ProductHeader";
import RecommendationCard from "@/components/RecommendationCard";
import WeeklyChart from "@/components/WeeklyChart";
import { CardSkeleton, Empty, ErrorCard, Skeleton, Sparkline } from "@/components/ui";

const H2 = "text-[32px] leading-10 tracking-[-0.64px]";

export default function ProductDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const product = useApi<Product>(`/products/${id}`);
  const overview = useApi<Overview>(`/products/${id}/overview`);
  const rows = useApi<CompetitorRow[]>(`/products/${id}/competitors/summary`);
  const selection = useApi<{ platforms: string[] }>(`/products/${id}/pincodes`);
  const reviews = useApi<Reviews>(`/products/${id}/reviews`);
  const refreshAll = () => {
    overview.mutate();
    rows.mutate();
    reviews.mutate();
  };
  const run = useRun(id, refreshAll);
  const [busy, setBusy] = useState<string | null>(null);
  const competitors = useApi<Competitor[]>(`/products/${id}/competitors`);
  const names = useMemo(() => new Map((competitors.data ?? []).map((c) => [c.id, c.name])), [competitors.data]);

  // A run may already be going (scheduler, another tab): follow it instead of offering a second one.
  const activeRuns = useApi<RunSummary[]>(`/runs?product_id=${encodeURIComponent(id)}&limit=1`, { shouldRetryOnError: false });
  const attached = useRef(false);
  const { attach } = run;
  const hasRun = !!run.run;
  useEffect(() => {
    const latest = activeRuns.data?.[0];
    if (attached.current || hasRun || !latest || !isActiveRunStatus(latest.status)) return;
    attached.current = true;
    attach(latest.id, latest.total_jobs, latest.started_at);
  }, [activeRuns.data, attach, hasRun]);

  const announced = useRef<string | null>(null);
  useEffect(() => {
    const r = run.run;
    if (!r || announced.current === r.runId) return;
    if (r.phase === "done" || r.phase === "failed") {
      announced.current = r.runId;
      const ok = r.completed - r.failed;
      if (r.phase === "failed") toast.error(`Check failed: none of ${r.total} checks returned data`);
      else toast(`${r.status === "partial" ? "Check partly done" : "Check finished"}: ${ok} result${ok === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`);
    }
  }, [run.run]);

  async function generate(kind: "summary" | "recommendations" | "reviews") {
    setBusy(kind);
    try {
      const res = await api<Partial<GenerateResult> & { changed?: boolean }>(`/products/${id}/ai/${kind}`, { method: "POST" });
      refreshAll();
      if (kind === "summary") toast("Summary updated");
      else if (kind === "reviews") (res.changed ? toast : toast.info)(res.message || "Review insights refreshed");
      else {
        // The backend says what the refresh actually did (new, replaced, auto-approved, or nothing).
        (res.recommendations?.length ? toast : toast.info)(res.message || "Recommendations checked");
        if (res.auto_approved) refreshActionViews();
      }
    } catch (e) {
      toast.error(errorMessage(e, "Could not generate that right now"));
    } finally {
      setBusy(null);
    }
  }

  if (product.error) return <ErrorCard error={product.error} onRetry={() => product.mutate()} />;
  const p = product.data;
  const k = overview.data?.kpis;
  const pending = overview.data?.recommendations.filter((r) => r.status === "pending") ?? [];
  const prog = run.progress;
  const progDone = prog ? prog.done + prog.failed : 0;

  return (
    <div className="flex flex-col gap-10">
      <div>
        <ProductHeader
          productId={id}
          active="overview"
          action={
            <RecheckButton
              onClick={() => run.start()}
              running={run.running}
              disabled={p?.paused || run.starting}
              label={run.running ? `Checking… ${progDone}/${prog!.total}` : p?.paused ? "Paused" : undefined}
            />
          }
        />
        {p && (
          <p className="text-[16px] leading-6 font-medium text-ink/80 -mt-2">
            {[p.brand, p.paused ? "Checks paused" : `Checked ${(FREQUENCY_LABEL[p.check_frequency] ?? p.check_frequency).toLowerCase()}`].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      {run.error && !run.run && (
        <div className="card bg-sand px-[26px] py-4 text-[15px] font-semibold" role="alert">
          ✕ {run.error}
        </div>
      )}
      {run.run && <AgentConsole run={run.run} names={names} onClose={run.reset} />}

      {/* KPI tiles */}
      <section data-mochi="product-kpis" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 stagger">
        {overview.error && !overview.data ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <ErrorCard error={overview.error} onRetry={() => overview.mutate()} />
          </div>
        ) : k ? (
          <>
            <KpiTile tone="linen" eyebrow="Your avg price" value={rupees(k.avg_price.value, 2)} spark={k.avg_price.sparkline} />
            <KpiTile tone="sand" eyebrow="Cheapest rival" value={rupees(k.cheapest_rival.value, 2)} spark={k.cheapest_rival.sparkline} />
            <KpiTile tone="sage" eyebrow="In stock" value={`${k.in_stock.value}/${k.in_stock.total}`} spark={k.in_stock.sparkline} caption="Pins in stock" />
            <KpiTile tone="linen" eyebrow="Rating" value={k.rating.value?.toFixed(2) ?? "—"} spark={k.rating.sparkline} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[200px] rounded-[20px]" />)
        )}
      </section>

      {/* Actions + AI summary */}
      <section data-mochi="product-actions" className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 flex flex-col min-w-0">
          <div className="section-head">
            <h2 className={H2}>Recommended actions</h2>
            <button className="btn btn-ghost btn-sm" disabled={busy === "recommendations"} onClick={() => generate("recommendations")}>
              {busy === "recommendations" ? "Thinking…" : "Refresh"}
            </button>
          </div>
          <div data-mochi="product-recs" className="flex flex-col gap-5 pt-5 stagger">
            {overview.error && !overview.data ? (
              <ErrorCard error={overview.error} onRetry={() => overview.mutate()} />
            ) : !overview.data ? (
              <CardSkeleton />
            ) : pending.length === 0 ? (
              <Empty title="All caught up">No pending actions for this product.</Empty>
            ) : (
              pending.map((r) => (
                <RecommendationCard
                  key={r.id}
                  rec={r}
                  onChange={() => overview.mutate()}
                  onApproved={(res) => {
                    // Approving a re-check started a real run: follow it in the console above.
                    if (res.effect === "run_started" && res.run_id) attach(res.run_id, 0);
                  }}
                />
              ))
            )}
          </div>
          <div className="section-head mt-10">
            <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Action plan</h2>
          </div>
          <div data-mochi="product-plan" className="pt-5">
            <ActionPlan productId={id} />
          </div>
          {p && (
            <div data-mochi="product-guardrails" className="mt-6 flex items-start gap-3 border-2 border-dashed border-ink/40 rounded-[16px] px-5 py-4">
              <span className="eyebrow text-slate shrink-0">Guardrails</span>
              <p className="text-[15px] leading-[22.5px] text-ink/80">
                Never below the {rupees(p.floor_price)} floor or a {p.min_margin_pct}% margin; at most {p.max_change_pct}% price change a day.
                {p.approval_required
                  ? " Every action waits for your approval."
                  : " New recommendations that pass these rules are approved automatically; re-checks still wait for you."}
              </p>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 lg:pt-[62px]">
          <div className="card text-ink p-[26px] flex flex-col gap-[10px]">
            <h2 className="font-sans font-semibold text-[18px] leading-[27px] flex items-center gap-2">
              <img src="/figma/heatmaps/imgContainer13.svg" alt="" width={15} height={15} /> AI summary
            </h2>
            {overview.data ? (
              overview.data.summary ? (
                <>
                  <p className="text-[15px] leading-[24.38px]">{overview.data.summary.summary_text}</p>
                  <p className="text-[13px] text-ink/75">
                    {overview.data.summary.source === "fallback" ? "Rule-based summary" : "Written by Gemini"} from measured data · {timeAgo(overview.data.summary.created_at)}
                  </p>
                </>
              ) : (
                <p className="text-[15px] leading-[24.38px] text-ink/80">No summary yet. Run a check or generate one.</p>
              )
            ) : (
              <Skeleton className="h-24 opacity-20" />
            )}
            <button className="btn btn-sand h-12 text-[15px] mt-3 w-full" disabled={busy === "summary"} onClick={() => generate("summary")}>
              {busy === "summary" ? "Writing…" : "Regenerate summary"}
            </button>
          </div>
        </div>
      </section>

      {/* Competitor table */}
      <section data-mochi="product-competitors" className="flex flex-col gap-6">
        <div className="section-head">
          <h2 className={H2}>You vs competitors</h2>
        </div>
        {rows.error && !rows.data ? (
          <ErrorCard error={rows.error} onRetry={() => rows.mutate()} />
        ) : !rows.data ? (
          <CardSkeleton />
        ) : rows.data.length === 0 ? (
          <Empty title="No competitors yet">Add rivals in this product&apos;s settings.</Empty>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead className="bg-sand border-b-2 border-ink">
                  <tr>
                    {["Product", "Platform", "Price", "vs you", "Stock coverage", "Rating", "Delivery"].map((h) => (
                      <th key={h} className="px-5 py-5 text-[13px] leading-5 font-semibold uppercase tracking-[0.65px] whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-[15px]">
                  {rows.data.map((r) => (
                    <tr key={`${r.entity_id}-${r.platform}`} className={`border-b border-ink/20 last:border-0 ${r.is_seller ? "bg-sage/25" : ""}`}>
                      <td className="px-5 py-5 font-semibold min-w-[220px]">
                        {r.name}
                        {r.is_seller && <span className="chip bg-sage ml-2 align-middle">You</span>}
                      </td>
                      <td className="px-5 py-5 text-ink/80">{platformLabel(r.platform)}</td>
                      <td className="px-5 py-5 font-semibold">{rupees(r.price, 2)}</td>
                      <td className="px-5 py-5">{r.is_seller ? "—" : pct(r.price_delta_pct)}</td>
                      <td className="px-5 py-5">
                        <div className="flex items-center gap-3">
                          <span className="whitespace-nowrap">{r.in_stock}/{r.total}</span>
                          <span className="h-[8px] w-16 rounded-full bg-ink/15 overflow-hidden">
                            <span className="block h-full bg-sage" style={{ width: `${r.total ? (r.in_stock / r.total) * 100 : 0}%` }} />
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-5">{r.rating?.toFixed(1) ?? "—"}</td>
                      <td className="px-5 py-5 whitespace-nowrap">{r.eta_minutes != null ? `${Math.round(r.eta_minutes)} min` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <WeeklySection id={id} platforms={selection.data?.platforms ?? []} />

      {/* Reviews + ideas */}
      <section className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div className="card p-[26px] flex flex-col">
          <div className="section-head">
            <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Review insights</h2>
            <button className="btn btn-ghost btn-sm" disabled={busy === "reviews"} onClick={() => generate("reviews")}>
              {busy === "reviews" ? "Reading…" : "Refresh"}
            </button>
          </div>
          {reviews.error && !reviews.data ? (
            <div className="pt-5">
              <ErrorCard error={reviews.error} onRetry={() => reviews.mutate()} />
            </div>
          ) : !reviews.data ? (
            <Skeleton className="h-24 mt-5" />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-5">
              <ReviewList title="Working for you" items={reviews.data.loves} good />
              <ReviewList title="Your weak spots" items={reviews.data.complaints} />
            </div>
          )}
        </div>
        <div className="card bg-sand p-[26px] flex flex-col">
          <div className="section-head border-ink/30">
            <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Win without a price war</h2>
          </div>
          <ul className="flex flex-col gap-3 pt-5 stagger">
            {(reviews.data?.rival_complaints ?? []).slice(0, 3).map((c) => (
              <Idea key={c} title={`Rivals get “${c}”.`}>Call out how you do better in your title, images and first bullet.</Idea>
            ))}
            {reviews.data && !reviews.data.rival_complaints?.length && reviews.data.complaints[0] && (
              <Idea title={`Fix your weak spot first: “${reviews.data.complaints[0]}”.`}>
                No rival review data yet; ShelfSense tracks rivals&apos; price and stock, not their reviews.
              </Idea>
            )}
            <Idea title="Bundle instead of discounting.">A 2-pack or combo protects your per-unit price.</Idea>
            <Idea title="Local offer, not a national cut.">Target only pincodes with a price gap.</Idea>
          </ul>
        </div>
      </section>
    </div>
  );
}

const TONE = {
  slate: { cls: "bg-slate text-linen", stroke: "var(--linen)" },
  sand: { cls: "bg-sand text-ink", stroke: "var(--ink)" },
  sage: { cls: "bg-sage text-ink", stroke: "var(--ink)" },
  linen: { cls: "bg-linen text-ink", stroke: "var(--slate)" },
};

/** Stat tile (dashboard tile shell, heatmap 48–56px Fraunces number) with a 7-day sparkline. */
function KpiTile({ eyebrow, value, spark, tone, caption = "last 7 days" }: { eyebrow: string; value: string; spark: (number | null)[]; tone: keyof typeof TONE; caption?: string }) {
  const t = TONE[tone];
  return (
    <div className={`card ${t.cls} flex flex-col justify-between gap-4 p-[26px] min-h-[200px] min-w-0`}>
      <p className="eyebrow">{eyebrow}</p>
      <p className="font-display text-[48px] 2xl:text-[56px] leading-none tracking-[-1.1px] whitespace-nowrap">{value}</p>
      <div className="flex items-end justify-between gap-3">
        <p className="text-[15px] leading-[22.5px] font-semibold">{caption}</p>
        <Sparkline values={spark} width={96} height={32} stroke={t.stroke} />
      </div>
    </div>
  );
}

function ReviewList({ title, items, good }: { title: string; items: string[]; good?: boolean }) {
  return (
    <div>
      <p className="eyebrow text-slate mb-3">{title}</p>
      {items.length === 0 ? (
        <p className="text-[15px] text-ink/70">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((l) => (
            <li key={l} className="flex items-start gap-3 text-[15px] leading-[22.5px] font-medium">
              {good ? (
                <img src="/figma/shell/pin-in-stock.svg" alt="" width={20} height={20} className="shrink-0 mt-px" />
              ) : (
                <span className="grid place-items-center size-5 shrink-0 mt-px rounded-full border-2 border-dashed border-ink text-[10px] font-bold" aria-hidden>✕</span>
              )}
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Idea({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="bg-linen border-2 border-ink rounded-[12px] shadow-[3px_3px_0_var(--ink)] px-[18px] py-[14px] text-[15px] leading-[22.5px]">
      <b className="font-semibold">{title}</b> {children}
    </li>
  );
}

function WeeklySection({ id, platforms }: { id: string; platforms: string[] }) {
  const [platform, setPlatform] = useState<string>("");
  const [downloading, setDownloading] = useState(false);
  const weekly = useApi<Weekly>(`/products/${id}/weekly${platform ? `?platform=${platform}` : ""}`, { keepPreviousData: true });
  const competitors = useApi<Competitor[]>(`/products/${id}/competitors`);
  const names = new Map(competitors.data?.map((c) => [c.id, c.name]));
  const w = weekly.data;

  const delta = (a: number | null, b: number | null, money = false) => {
    if (a == null || b == null) return "—";
    const d = a - b;
    const s = money ? rupees(Math.abs(d), 2) : Math.abs(d).toFixed(d % 1 ? 2 : 0);
    return d === 0 ? "no change" : `${d > 0 ? "▲" : "▼"} ${s}`;
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="section-head flex-wrap">
        <h2 className={H2}>This week vs last week</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            try {
              await downloadFile(`/products/${id}/weekly/report.csv${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`, `shelfsense-weekly${platform ? `-${platform}` : ""}.csv`);
            } catch (e) {
              toast.error(errorMessage(e, "Could not download the report"));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? "Preparing…" : "↓ CSV report"}
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {["", ...platforms].map((pl) => (
          <button key={pl || "all"} type="button" className="pill" data-active={platform === pl} aria-pressed={platform === pl} onClick={() => setPlatform(pl)}>
            {platformLabel(pl || null)}
          </button>
        ))}
      </div>
      {weekly.error && !w ? (
        <ErrorCard error={weekly.error} onRetry={() => weekly.mutate()} />
      ) : !w ? (
        <CardSkeleton />
      ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8 card p-[26px] min-w-0">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-6 mb-6 border-b border-ink/20">
              <Compare label="Avg price" now={rupees(w.this_week.avg_price, 2)} change={delta(w.this_week.avg_price, w.last_week.avg_price, true)} />
              <Compare label="Stock-outs" now={String(w.this_week.oos_count)} change={delta(w.this_week.oos_count, w.last_week.oos_count)} />
              <Compare label="Rating" now={w.this_week.rating?.toFixed(2) ?? "—"} change={delta(w.this_week.rating, w.last_week.rating)} />
              <Compare label="Search rank" now={w.this_week.search_rank?.toFixed(1) ?? "—"} change={delta(w.this_week.search_rank, w.last_week.search_rank)} />
            </div>
            <WeeklyChart series={w.series} />
          </div>
          <div className="lg:col-span-4 card p-[22px] flex flex-col min-w-0">
            <h3 className="font-sans font-semibold text-[20px] leading-[30px] pb-3 border-b border-ink/20">Changelog</h3>
            {w.changelog.length === 0 ? (
              <p className="text-[15px] text-ink/70 pt-4">No changes detected this week.</p>
            ) : (
              <ul className="flex flex-col max-h-[420px] overflow-y-auto pr-1">
                {w.changelog.slice(0, 25).map((c) => (
                  <li key={c.id} className="py-3 border-b border-ink/20 last:border-0">
                    <p className="text-[15px] leading-[22.5px]">
                      <b className="font-semibold">{c.competitor_id ? names.get(c.competitor_id) ?? "A rival" : "You"}</b> {describeChange(c.kind, c.old_value, c.new_value)}
                    </p>
                    <p className="text-[13px] text-ink/70 mt-0.5">
                      {platformLabel(c.platform)} · {c.pincode} · {timeAgo(c.detected_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function describeChange(kind: string, oldV: number | null, newV: number | null) {
  const money = (v: number | null) => (v == null ? "?" : rupees(v, v % 1 ? 2 : 0));
  if (kind === "price_drop") return `dropped price ${money(oldV)} → ${money(newV)}`;
  if (kind === "price_rise") return `raised price ${money(oldV)} → ${money(newV)}`;
  if (kind.includes("oos") || kind === "stock_out") return "went out of stock";
  if (kind.includes("restock") || kind === "back_in_stock") return "came back in stock";
  if (kind === "rating_change") return `rating ${oldV ?? "?"} → ${newV ?? "?"}`;
  return `${kind.replace(/_/g, " ")}${oldV != null || newV != null ? ` ${oldV ?? "?"} → ${newV ?? "?"}` : ""}`;
}

function Compare({ label, now, change }: { label: string; now: string; change: string }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow text-slate">{label}</p>
      <p className="font-display text-[32px] leading-10 tracking-[-0.64px] mt-1">{now}</p>
      <p className="text-[13px] font-medium text-ink/70">{change} vs last week</p>
    </div>
  );
}
