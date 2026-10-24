"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { mutate } from "swr";
import { api, useApi } from "@/lib/api";
import { actOnRecommendation, handleDecisionError, refreshActionViews } from "@/lib/recommendations";
import { toast } from "@/lib/toast";
import type { Alert, Dashboard, Me, Plans, ProductCard, Recommendation } from "@/lib/types";
import { greeting, platformLabel, timeAgo } from "@/lib/format";
import ActionPlan from "@/components/ActionPlan";
import AddProductDialog from "@/components/AddProductDialog";
import { productState } from "@/components/products/ProductViews";
import { CardSkeleton, Empty, ErrorCard, Meter, PincodeStrip, Skeleton, StatTile, Sticker } from "@/components/ui";

const ALERT_ICON: Record<string, string> = {
  rival_oos: "alert-store",
  price_change_pct: "alert-trend-down",
  price_gap_pct: "alert-trend-down",
  oos_any: "alert-box",
};

const noop = () => () => {};
/** Time-of-day greeting computed on the client only (the server's clock/zone would mismatch on hydration). */
const useGreeting = () => useSyncExternalStore(noop, greeting, () => "Hello");

function priceLine(p: ProductCard) {
  const v = p.price_position_vs_avg_rival;
  if (v == null) return "No rival price yet";
  if (Math.abs(v) < 0.5) return "Matched with rivals";
  return `${Math.abs(v).toFixed(1)}% ${v < 0 ? "below" : "above"} rivals`;
}

export default function DashboardPage() {
  const me = useApi<Me>("/me");
  const plans = useApi<Plans>("/plans");
  const dash = useApi<Dashboard>("/dashboard");
  const products = useApi<ProductCard[]>("/products");
  const [filter, setFilter] = useState<"all" | "attention" | "healthy">("all");
  const [adding, setAdding] = useState(false);
  const hello = useGreeting();

  if (dash.error) return <ErrorCard error={dash.error} onRetry={() => dash.mutate()} />;

  const tile = (key: string) => dash.data?.tiles.find((t) => t.key === key)?.value ?? 0;
  const limits = plans.data?.plans.find((p) => p.plan === me.data?.plan);
  const all = products.data ?? [];
  const attention = all.filter((p) => productState(p) === "attention");
  const healthy = all.filter((p) => productState(p) === "healthy");
  const shown = (filter === "attention" ? attention : filter === "healthy" ? healthy : all).slice(0, 3);
  const cheaper = all.filter((p) => (p.price_position_vs_avg_rival ?? 0) <= 0 && p.price_position_vs_avg_rival != null).length;
  const tgConnected = all.filter((p) => p.telegram_connected);
  const firstUnlinked = all.find((p) => !p.telegram_connected);
  const oosDelta = Number(tile("oos_pincodes")) - Number(tile("oos_pincodes_last_week"));
  const meters = dash.data?.meters;

  /** "Review →" opens the product; the alert counts as read from then on. */
  const markAlertRead = (a: Alert) => {
    if (a.read) return;
    api(`/me/alerts/${encodeURIComponent(a.id)}/read`, { method: "POST" })
      .then(() => {
        void mutate((key) => typeof key === "string" && key.startsWith("/me/alerts"));
        void dash.mutate();
      })
      .catch(() => {});
  };

  return (
    <div className="flex flex-col gap-10">
      {/* Greeting */}
      <section data-mochi="dash-greeting" className="section-head flex-wrap items-end">
        <div>
          <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px]">
            {hello}, {me.data?.profile.name.split(" ")[0] ?? "…"}
          </h1>
          <p className="text-[18px] leading-[27px] font-medium text-slate mt-2">
            {attention.length
              ? `${attention.length} thing${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} your attention today.`
              : "Everything is on track today."}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {attention.length > 0 && <Sticker>{attention.length} need attention</Sticker>}
          <button data-mochi="add-product" className="btn btn-primary px-[26px]" onClick={() => setAdding(true)}>
            <img src="/figma/shell/plus-circle.svg" alt="" width={20} height={20} />Add product
          </button>
        </div>
      </section>

      {/* Stat tiles */}
      <section data-mochi="dash-tiles" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        <div className="card text-ink flex flex-col justify-between p-[26px] min-h-[200px]">
          <div className="flex items-center justify-between">
            <p className="eyebrow">{me.data?.plan ?? "…"}</p>
            <p className="text-[14px] font-semibold text-ink/75">Test-mode billing</p>
          </div>
          {meters ? (
            <div className="flex flex-col gap-[10px]">
              <Meter label="Products" value={meters.products} max={meters.product_limit} />
              {/* Pincode limits apply per product: show the busiest product against that limit. */}
              <Meter label="Pincodes (busiest product)" value={meters.max_pincodes_per_product} max={meters.pincode_limit_per_product} />
              <Meter label="Credits today" value={meters.credits_today} max={meters.daily_credit_budget} />
            </div>
          ) : me.data && limits ? (
            <div className="flex flex-col gap-[10px]">
              <Meter label="Products" value={me.data.usage.products} max={limits.products} />
            </div>
          ) : (
            <Skeleton className="h-24 opacity-20" />
          )}
        </div>
        <StatTile
          tone="sand"
          eyebrow="Out-of-stock pincodes"
          value={dash.data ? tile("oos_pincodes") : "…"}
          caption={dash.data ? (oosDelta === 0 ? "Same as last week" : `${oosDelta > 0 ? "↑" : "↓"} ${Math.abs(oosDelta)} vs last week`) : ""}
        />
        <StatTile
          tone="sage"
          eyebrow="Cheaper than rivals"
          value={products.data ? `${cheaper}/${all.length}` : "…"}
          caption={`Price lead on ${cheaper} product${cheaper === 1 ? "" : "s"}`}
        />
        <StatTile tone="linen" eyebrow="Approved this week" value={dash.data ? tile("approved_this_week") : "…"} caption="Approved or done, last 7 days" />
      </section>

      {/* Products */}
      <section data-mochi="dash-products" className="flex flex-col gap-6">
        <div className="section-head flex-wrap">
          <h2 className="text-[32px] leading-10 tracking-[-0.64px]">Your products</h2>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter products">
              {(
                [
                  ["all", "All", all.length],
                  ["attention", "Needs attention", attention.length],
                  ["healthy", "Healthy", healthy.length],
                ] as const
              ).map(([key, label, n]) => (
                <button key={key} className="pill" data-active={filter === key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label} {products.data ? n : "–"}
                </button>
              ))}
            </div>
            <Link href="/products" className="font-semibold text-[16px] underline underline-offset-4">View all →</Link>
          </div>
        </div>
        {products.error ? (
          <ErrorCard error={products.error} onRetry={() => products.mutate()} />
        ) : !products.data ? (
          <CardSkeleton />
        ) : shown.length === 0 ? (
          <Empty title={all.length ? "No products here" : "No products yet"}>
            {all.length ? (
              "Nothing matches this filter right now."
            ) : (
              <button className="btn btn-primary btn-sm mt-3" onClick={() => setAdding(true)}>Add a product</button>
            )}
          </Empty>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 stagger">
            {shown.map((p) => (
              <ProductCardTile key={p.id} p={p} />
            ))}
          </div>
        )}
      </section>

      {/* Actions + alerts */}
      <section data-mochi="dash-actions" className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 flex flex-col">
          <div className="section-head">
            <h2 className="text-[32px] leading-10 tracking-[-0.64px]">Recommended actions</h2>
          </div>
          <div data-mochi="dash-recs" className="flex flex-col gap-5 pt-5 stagger">
            {!dash.data ? (
              <CardSkeleton />
            ) : dash.data.recommendations.length === 0 ? (
              <Empty title="Nothing to approve">New recommendations appear after each check.</Empty>
            ) : (
              dash.data.recommendations.map((r) => <ActionCard key={r.id} rec={r} onChange={() => dash.mutate()} />)
            )}
          </div>
          <div className="section-head mt-10">
            <h2 className="text-[28px] leading-9 tracking-[-0.56px]">Action plan</h2>
          </div>
          <div data-mochi="dash-plan" className="pt-5">
            <ActionPlan showProduct />
          </div>
        </div>
        <div className="lg:col-span-5 card text-ink p-[26px] flex flex-col gap-2">
          <h2 className="text-[28px] tracking-[-0.56px] border-b border-ink/15 pb-[13px]">Today&apos;s alerts</h2>
          {!dash.data ? (
            <Skeleton className="h-40 opacity-30" />
          ) : dash.data.alerts.length === 0 ? (
            <p className="text-[15px] text-ink/75 py-4">No alerts today. Quiet shelf.</p>
          ) : (
            <ul className="flex flex-col stagger">
              {dash.data.alerts.slice(0, 4).map((a, i, arr) => (
                <li key={a.id} className={`flex items-center justify-between gap-3 py-4 ${i < arr.length - 1 ? "border-b border-ink/15" : ""}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="grid place-items-center size-9 shrink-0 rounded-[10px] bg-sand border-2 border-ink shadow-[3px_3px_0_var(--ink)]">
                      <img src={`/figma/shell/${ALERT_ICON[a.kind] ?? "alert-bot"}.svg`} alt="" width={16} height={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-[16px] leading-6">{a.message}</p>
                      <p className="text-[14px] text-ink/75">
                        {timeAgo(a.created_at)} · {a.product_name}
                      </p>
                    </div>
                  </div>
                  <Link href={`/products/${a.product_id}`} onClick={() => markAlertRead(a)} className="font-semibold text-[15px] whitespace-nowrap hover:underline">Review →</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Telegram band */}
      <section data-mochi="dash-telegram" className="card bg-sage p-[34px] min-h-[110px] flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <p className="font-display text-[56px] leading-none tracking-[-1.12px]">
            {tgConnected.length}/{all.length}
          </p>
          <p className="font-semibold text-[20px]">products connected to Telegram</p>
        </div>
        {!all.length ? (
          <button className="btn btn-ink px-[26px]" onClick={() => setAdding(true)}>
            Add a product first →
          </button>
        ) : firstUnlinked ? (
          <Link href={`/products/${firstUnlinked.id}/telegram`} className="btn btn-ink px-[26px]">
            Connect remaining {all.length - tgConnected.length} →
          </Link>
        ) : (
          <span className="inline-flex items-center gap-2 h-12 rounded-[10px] bg-ink text-linen px-[26px] font-semibold">✓ All connected</span>
        )}
      </section>

      {adding && (
        <AddProductDialog
          onClose={() => {
            setAdding(false);
            void products.mutate();
            void me.mutate();
            void dash.mutate();
          }}
        />
      )}
    </div>
  );
}

function ProductCardTile({ p }: { p: ProductCard }) {
  const platforms = [...new Set(p.status_strip.map((s) => s.platform))].map(platformLabel).join(" · ");
  return (
    <Link href={`/products/${p.id}`} className="card card-lift flex flex-col justify-between pt-[25px] pb-[26px] px-[26px] min-w-0">
      <div className="flex flex-col gap-1 pb-5">
        <h3 className="font-sans font-semibold text-[20px] leading-[30px]">
          {p.name}
        </h3>
        <p className="text-[16px] text-ink/80">{platforms || "No platforms yet"}</p>
        <div className="pt-3">
          <PincodeStrip strip={p.status_strip} />
        </div>
        <p className="font-semibold text-[18px] pt-5">{priceLine(p)}</p>
      </div>
      <div className="border-t border-ink/20 pt-[17px] flex items-center justify-between gap-3 text-[15px]">
        <span className="text-ink/80">Checked {timeAgo(p.last_checked)}</span>
        <span className="font-semibold flex items-center gap-1.5">
          {p.telegram_connected ? (
            <>
              <img src="/figma/shell/check.svg" alt="" width={16} height={16} /> Telegram connected
            </>
          ) : (
            "Telegram off"
          )}
        </span>
      </div>
    </Link>
  );
}

function ActionCard({ rec, onChange }: { rec: Recommendation & { product_name?: string | null }; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function act(kind: "approve" | "dismiss") {
    if (busy || done) return;
    setBusy(kind);
    try {
      const res = await actOnRecommendation(rec.id, kind);
      setDone(kind === "approve" ? (res.effect === "run_started" ? "✓ Re-check started" : "✓ In action plan") : "Dismissed");
      // The backend message says what approval did (run started / action added / price to set).
      toast(res.message ?? (kind === "approve" ? "Approved" : "Recommendation dismissed"));
      setTimeout(() => {
        onChange();
        refreshActionViews();
      }, 900);
    } catch (e) {
      handleDecisionError(e, onChange);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className={`card p-[26px] flex flex-wrap items-center gap-6 ${done ? "border-dashed shadow-none" : ""}`}>
      <div className="flex-1 min-w-[220px]">
        <p className="font-semibold text-[18px] leading-[27px]">{rec.action_text}</p>
        <p className="text-[16px] leading-6 text-ink/80 mt-2">{rec.impact_text}</p>
        {rec.product_name && <p className="text-[13px] font-semibold text-slate mt-2">{rec.product_name}</p>}
      </div>
      {done ? (
        <span className={`chip ${done.startsWith("✓") ? "bg-sage" : "bg-linen"}`} role="status">
          {done}
        </span>
      ) : (
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act("approve")}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => act("dismiss")}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      )}
    </div>
  );
}
