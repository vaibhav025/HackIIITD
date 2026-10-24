"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, useApi } from "@/lib/api";
import { actOnRecommendation, handleDecisionError, refreshActionViews, toastTelegramResult } from "@/lib/recommendations";
import type { Competitor, Heatmap, HeatmapPin, Me, Overview, Pincode, PinDetail, ProductCard, Recommendation, RunSummary } from "@/lib/types";
import { platformLabel, rupees, rupeesPrecise, timeAgo, etaLabel } from "@/lib/format";
import { useFocusTrap, useScrollLock } from "@/lib/a11y";
import AgentConsole from "@/components/agent/AgentConsole";
import AgentReplay from "@/components/agent/AgentReplay";
import { ScreenshotThumb } from "@/components/agent/parts";
import { isActiveRunStatus, useRun } from "@/lib/useRun";
import HeatmapMap from "@/components/heatmap";
import ProductHeader, { RecheckButton } from "@/components/ProductHeader";
import { Empty, ErrorCard, STATUS_META, Skeleton, StatusBadge } from "@/components/ui";
import CountUp from "@/components/motion/CountUp";
import Reveal from "@/components/motion/Reveal";
import { toast } from "@/lib/toast";
import { EASE } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";

const A = "/figma/heatmaps";
const SNAPSHOTS = [
  { key: "now", label: "Now" },
  { key: "6h", label: "6h ago" },
  { key: "24h", label: "24h ago" },
  { key: "7d", label: "7d ago" },
];
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
/** Figma control box: linen, 2px ink border, 12px radius, 2px hard shadow, 48px tall. */
const BOX_BASE = "h-12 rounded-[12px] border-2 border-ink bg-linen";
const BOX = `${BOX_BASE} shadow-[2px_2px_0_var(--ink)]`;
/** Clickable control box: the shared press utility draws the same 2px shadow. */
const BOX_BUTTON = `${BOX_BASE} press press-2`;
/** `stale_reason` of a pin whose app live mode never checks (Blinkit by default). */
const UNAVAILABLE = "unavailable";
const UNAVAILABLE_LABEL = "Not available in live mode";

/** Heatmap API fields beyond the shared types (live-mode availability, stale reasons). */
type MapPin = HeatmapPin & { stale_reason?: string | null };
type MapSummary = Heatmap["summary"] & { failed?: number; unavailable?: number };
type MapData = Omit<Heatmap, "pins" | "summary"> & {
  pins: MapPin[];
  summary: MapSummary;
  unavailable_platforms?: { platform: string; reason: string }[];
};
type PinPlatform = PinDetail["platforms"][number] & { unavailable_reason?: string | null };
/** `GET /products/{id}/runs/estimate`: exactly what a re-check would run and cost. */
interface RunEstimate {
  jobs: number;
  credits: number;
  platforms: string[];
  skipped_platforms: { platform: string; reason: string }[];
  remaining_credits: number | null;
}

const isUnavailable = (pin: MapPin) => pin.stale_reason === UNAVAILABLE;

export default function HeatmapPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[460px]" />}>
      <HeatmapView />
    </Suspense>
  );
}

function HeatmapView() {
  const router = useRouter();
  const search = useSearchParams();
  const productParam = search.get("product");
  const pincodeParam = search.get("pincode");
  const products = useApi<ProductCard[]>("/products");
  const [pincodeMiss, setPincodeMiss] = useState<string | null>(null);

  // ?pincode=XXXXXX (top-bar search): open the first product that tracks it.
  useEffect(() => {
    const list = products.data;
    if (!pincodeParam || productParam || !list) return;
    let cancelled = false;
    (async () => {
      let hit = list.find((p) => p.status_strip.some((s) => s.pincode === pincodeParam));
      if (!hit) {
        // Ask every product in parallel; first match in list order wins.
        const tracked = await Promise.all(
          list.map((p) =>
            api<{ pincodes: string[] }>(`/products/${p.id}/pincodes`)
              .then((sel) => sel.pincodes.includes(pincodeParam))
              .catch(() => false),
          ),
        );
        hit = list[tracked.indexOf(true)];
      }
      if (cancelled) return;
      if (hit) router.replace(`/heatmap?product=${hit.id}&pincode=${pincodeParam}`);
      else setPincodeMiss(pincodeParam);
    })();
    return () => {
      cancelled = true;
    };
  }, [pincodeParam, productParam, products.data, router]);

  const resolving = !!pincodeParam && !productParam && pincodeMiss !== pincodeParam;
  const productId = productParam ?? (resolving ? null : products.data?.[0]?.id ?? null);

  if (products.error) return <ErrorCard error={products.error} onRetry={() => products.mutate()} />;
  if (products.data && !products.data.length)
    return (
      <Empty title="No products to map yet">
        <Link href="/products" className="btn btn-primary btn-sm mt-3">Add a product</Link>
      </Empty>
    );
  if (!productId || !products.data)
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-2/3" />
        <Skeleton className="h-[640px]" />
      </div>
    );
  return (
    <ProductHeatmap
      key={productId}
      productId={productId}
      products={products.data}
      initialPincode={productParam ? pincodeParam : null}
      pincodeMiss={pincodeMiss}
    />
  );
}

function ProductHeatmap({
  productId,
  products,
  initialPincode,
  pincodeMiss,
}: {
  productId: string;
  products: ProductCard[];
  initialPincode: string | null;
  pincodeMiss: string | null;
}) {
  const router = useRouter();
  const product = products.find((p) => p.id === productId);
  const [platform, setPlatform] = useState("");
  const [snapshot, setSnapshot] = useState("now");
  const [showRival, setShowRival] = useState(false);
  const [region, setRegion] = useState("");
  const [selected, setSelected] = useState<string | null>(initialPincode);
  const [recheck, setRecheck] = useState<Set<string>>(new Set());
  const [detailOpen, setDetailOpen] = useState(false);
  /** Pin hovered/focused on the map or in "Worst areas" — highlighted in both places. */
  const [hovered, setHovered] = useState<string | null>(null);

  const me = useApi<Me>("/me");
  const catalog = useApi<Pincode[]>("/pincodes");
  const selection = useApi<{ platforms: string[]; pincodes: string[] }>(`/products/${productId}/pincodes`);
  const competitors = useApi<Competitor[]>(`/products/${productId}/competitors`);
  const competitorNames = useMemo(() => new Map((competitors.data ?? []).map((c) => [c.id, c.name])), [competitors.data]);
  const qs = new URLSearchParams({ snapshot, ...(platform ? { platform } : {}) }).toString();
  const heatmap = useApi<MapData>(`/products/${productId}/heatmap?${qs}`, { keepPreviousData: true });
  const overview = useApi<Overview>(`/products/${productId}/overview`);
  const recs = useApi<{ items: Recommendation[] }>(`/products/${productId}/ai/recommendations?status=pending`);
  const detail = useApi<PinDetail>(
    detailOpen && selected ? `/products/${productId}/heatmap/pincodes/${selected}${platform ? `?platform=${platform}` : ""}` : null,
  );
  const run = useRun(productId, () => {
    heatmap.mutate();
    detail.mutate();
    overview.mutate();
    recs.mutate();
  });

  // A run may already be going (scheduler, another tab, the product page): follow it live.
  const latestRun = useApi<RunSummary[]>(`/runs?product_id=${encodeURIComponent(productId)}&limit=1`, { shouldRetryOnError: false });
  const attachedOnLoad = useRef(false);
  /** True when this page's own "Re-check" started the followed run (vs. attaching to one). */
  const startedHere = useRef(false);
  const { attach } = run;
  const hasRun = !!run.run;
  useEffect(() => {
    const latest = latestRun.data?.[0];
    if (attachedOnLoad.current || hasRun || !latest || !isActiveRunStatus(latest.status)) return;
    attachedOnLoad.current = true;
    attach(latest.id, latest.total_jobs, latest.started_at);
  }, [latestRun.data, attach, hasRun]);
  const startRun = (body?: { pincodes?: string[]; platforms?: string[] }) => {
    startedHere.current = true;
    void run.start(body);
  };
  const busy = run.running || run.starting;

  const cityOf = useMemo(() => Object.fromEntries((catalog.data ?? []).map((c) => [c.code, c.city])), [catalog.data]);
  const allPins = useMemo(() => heatmap.data?.pins ?? [], [heatmap.data]);
  const regions = useMemo(() => [...new Set(allPins.map((p) => cityOf[p.pincode]).filter(Boolean))].sort(), [allPins, cityOf]);
  const pins = useMemo(() => (region ? allPins.filter((p) => cityOf[p.pincode] === region) : allPins), [allPins, region, cityOf]);
  const counts = useMemo<MapSummary>(() => {
    if (!region && heatmap.data) return heatmap.data.summary;
    // Same rules as the API summary: never-checkable pins are counted apart from stale ones.
    const c = { in_stock: 0, out_of_stock: 0, price_gap: 0, stale: 0, unavailable: 0, total: pins.length };
    for (const p of pins) {
      if (isUnavailable(p)) c.unavailable++;
      else if (p.status in c) c[p.status as keyof typeof c]++;
    }
    return c;
  }, [region, heatmap.data, pins]);
  const unavailablePlatforms = heatmap.data?.unavailable_platforms ?? [];
  const worst = useMemo(
    () =>
      pins
        .filter((p) => p.status === "out_of_stock" || p.status === "price_gap")
        .sort(
          (a, b) =>
            Number(b.status === "out_of_stock") - Number(a.status === "out_of_stock") ||
            (b.price ?? 0) - (b.rival_price ?? 0) - ((a.price ?? 0) - (a.rival_price ?? 0)),
        )
        .slice(0, 5),
    [pins],
  );
  const selectedPin = pins.find((p) => p.pincode === selected) ?? null;

  const regionLabel = region || (regions.length === 1 ? regions[0] : regions.length ? "All regions" : me.data?.profile.default_city ?? "All regions");
  const targets = recheck.size ? [...recheck].sort() : selected ? [selected] : [];
  // The backend plans the jobs (every confirmed rival on every selected app, minus apps live mode
  // skips) and prices them (agent checks 1 credit, Amazon/Flipkart page reads free).
  const estimateQs = new URLSearchParams([...targets.map((t) => ["pincodes", t]), ...(platform ? [["platforms", platform]] : [])]).toString();
  const estimate = useApi<RunEstimate>(targets.length ? `/products/${productId}/runs/estimate?${estimateQs}` : null, {
    keepPreviousData: true,
  });
  const est = targets.length ? estimate.data : undefined;
  const runPlatforms = est?.platforms ?? (platform ? [platform] : selection.data?.platforms ?? []);
  const credits = est?.credits ?? null;
  const nothingToRun = !!est && est.jobs === 0;
  const prog = run.progress;
  const progLabel = prog ? `${Math.min(prog.done + prog.failed, prog.total)}/${prog.total}` : "";
  const [consoleOpen, setConsoleOpen] = useState(true);

  // Toasts for the re-check lifecycle (the inline "Checking… n/N" status stays as is).
  const runId = prog?.runId;
  const runFinished = !!prog?.finished;
  const progRef = useRef(prog);
  progRef.current = prog;
  useEffect(() => {
    if (runId) {
      toast.info(startedHere.current ? "Re-check started — pins update live" : "A check is already running — following it live");
      startedHere.current = false;
      setConsoleOpen(true);
    }
  }, [runId]);
  const runOverdue = !!run.run?.overdue && !runFinished;
  useEffect(() => {
    if (runOverdue) toast.info("This check is taking longer than usual — still running, pins update as agents finish");
  }, [runOverdue]);
  useEffect(() => {
    const p = progRef.current;
    if (!runId || !runFinished || !p) return;
    if (p.failed && !p.done) toast.error(`Re-check failed · none of ${p.failed} checks returned data`);
    else if (p.failed) toast.error(`Re-check partly done · ${p.done} updated, ${p.failed} failed`);
    else toast(`Re-check finished · ${p.done} result${p.done === 1 ? "" : "s"} updated`);
  }, [runId, runFinished]);
  useEffect(() => {
    if (run.error) toast.error(run.error);
  }, [run.error]);
  /** Pins pop in again only when the data behind the map changes view. */
  const seqKey = heatmap.data ? `${heatmap.data.platform ?? ""}|${heatmap.data.snapshot}|${region}` : "";

  const toggleRecheck = (code: string) =>
    setRecheck((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const select = (code: string) => {
    setSelected(code);
    setDetailOpen(false);
  };

  const titleSwitch =
    products.length > 1 ? (
      <span className="relative inline-flex max-w-full items-center gap-3 rounded-[8px] has-[select:focus-visible]:outline-[3px] has-[select:focus-visible]:outline-offset-4 has-[select:focus-visible]:outline-slate">
        <span className="min-w-0">{product?.name}</span>
        <img src={`${A}/imgContainer11.svg`} alt="" width={18} height={11} className="shrink-0" />
        <select
          aria-label="Switch product"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={productId}
          onChange={(e) => router.replace(`/heatmap?product=${e.target.value}`)}
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </span>
    ) : undefined;

  return (
    <div>
      <ProductHeader
        productId={productId}
        active="heatmap"
        title={titleSwitch}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {run.running && prog && (
              <span className="chip bg-sand">
                <span className="dot-typing"><span /><span /><span /></span> {runOverdue ? "Still running" : "Live"} · {progLabel}
              </span>
            )}
            <RecheckButton
              onClick={() => startRun()}
              running={busy}
              disabled={product?.paused}
              label={run.running && prog ? `Checking… ${progLabel}` : run.starting ? "Starting…" : undefined}
            />
          </div>
        }
      />
      {pincodeMiss && (
        <p className="card mb-6 bg-sand/50 p-3 text-sm font-semibold">No product tracks pincode {pincodeMiss} yet — showing {product?.name}.</p>
      )}
      {run.error && <p className="card mb-6 bg-sand/50 p-3 text-sm font-semibold">{run.error}</p>}
      {product?.paused && <p className="card mb-6 bg-sand/50 p-3 text-sm font-semibold">This product is paused — resume it in Settings to run checks.</p>}
      {unavailablePlatforms.length > 0 && (
        <p className="card mb-6 bg-linen p-3 text-sm font-semibold" role="note">
          {UNAVAILABLE_LABEL}: {unavailablePlatforms.map((u) => `${platformLabel(u.platform)} (${u.reason})`).join("; ")}. Re-checks skip{" "}
          {unavailablePlatforms.length === 1 ? "it" : "them"}, and {unavailablePlatforms.length === 1 ? "it does" : "they do"} not count against a pin.
        </p>
      )}

      {run.run && (
        <section className="mb-8" aria-label="TinyFish agents">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-[15px] font-semibold">
              {run.running ? "Agents are checking this product right now" : "Last re-check"}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={consoleOpen}
                aria-controls="heatmap-agent-console"
                onClick={() => setConsoleOpen((o) => !o)}
              >
                {consoleOpen ? "Hide agents" : "Show agents"}
              </button>
              {!run.running && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={run.reset}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
          <div id="heatmap-agent-console" hidden={!consoleOpen}>
            {consoleOpen && <AgentConsole run={run.run} names={competitorNames} />}
          </div>
        </section>
      )}

      {/* Filters */}
      <section data-mochi="heatmap-filters" className="flex flex-wrap items-center justify-between gap-4 pb-8">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-4">
          <Menu
            label={regionLabel}
            icon={<img src={`${A}/imgContainer10.svg`} alt="" width={13} height={17} />}
            value={region}
            onChange={setRegion}
            options={[{ key: "", label: "All regions" }, ...regions.map((r) => ({ key: r, label: r }))]}
            ariaLabel="Region"
          />
          <div role="tablist" aria-label="Platform" className={`${BOX} flex max-w-full items-stretch gap-1 overflow-x-auto p-[6px]`}>
            {["", ...(selection.data?.platforms ?? [])].map((pl) => (
              <button
                key={pl || "all"}
                role="tab"
                aria-selected={platform === pl}
                onClick={() => setPlatform(pl)}
                className={`shrink-0 rounded-[8px] px-4 text-[14px] font-semibold leading-[21px] transition-colors ${platform === pl ? "bg-slate text-linen" : "text-ink hover:bg-sand/40"}`}
              >
                {pl ? platformLabel(pl) : "All"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className={`${BOX} flex cursor-pointer select-none items-center gap-3 px-[18px]`}>
            <span className="text-[14px] font-semibold uppercase leading-[21px] tracking-[0.35px]">Show rival</span>
            <button
              type="button"
              role="switch"
              aria-checked={showRival}
              aria-label="Show rival prices"
              onClick={() => setShowRival(!showRival)}
              className={`relative h-6 w-11 rounded-full border-2 border-ink transition-colors ${showRival ? "bg-slate" : "bg-sage"}`}
            >
              <span className={`absolute top-[2px] size-4 rounded-full transition-all ${showRival ? "left-[22px] bg-linen" : "left-[2px] bg-ink"}`} />
            </button>
          </label>
          <Menu
            label={`Snapshot: ${SNAPSHOTS.find((s) => s.key === snapshot)?.label}`}
            icon={<img src={`${A}/imgContainer12.svg`} alt="" width={15} height={15} />}
            value={snapshot}
            onChange={setSnapshot}
            options={SNAPSHOTS}
            ariaLabel="Snapshot"
            align="right"
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
        {/* Map card */}
        <section
          data-mochi="heatmap-map"
          aria-label="Shelf availability map"
          className="relative h-[460px] overflow-hidden rounded-[20px] border-2 border-ink bg-linen shadow-[6px_6px_0_var(--ink)] sm:h-[560px] lg:col-span-8 lg:h-auto lg:min-h-[844px] lg:self-stretch"
        >
          {heatmap.data ? (
            <HeatmapMap
              pins={pins}
              hotZones={region ? [] : heatmap.data.hot_zones}
              selected={selected}
              onSelect={select}
              showRival={showRival}
              seqKey={seqKey}
              highlight={hovered}
              onHover={setHovered}
              callout={
                selectedPin && (
                  <PinCallout
                    pin={selectedPin}
                    showRival={showRival}
                    inRecheck={recheck.has(selectedPin.pincode)}
                    onToggleRecheck={() => toggleRecheck(selectedPin.pincode)}
                    onDetails={() => setDetailOpen(true)}
                    onClose={() => setSelected(null)}
                  />
                )
              }
            />
          ) : heatmap.error ? (
            <div className="grid h-full place-items-center p-6"><ErrorCard error={heatmap.error} onRetry={() => heatmap.mutate()} /></div>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
          <div className="pointer-events-none absolute left-6 top-6 z-[800] flex items-center gap-1.5 border-2 border-ink bg-sand px-4 py-1.5 shadow-[4px_4px_0_var(--ink)]">
            <span className={`size-2 rounded-full bg-ink ${snapshot === "now" ? "animate-pulse" : ""}`} />
            <span className="text-[14px] font-bold uppercase leading-[21px] tracking-[0.7px]">
              {snapshot === "now" ? "Live pincode data" : `Snapshot · ${SNAPSHOTS.find((s) => s.key === snapshot)?.label}`}
            </span>
          </div>
          {heatmap.data && !pins.length && (
            <div className="pointer-events-none absolute inset-0 z-[790] grid place-items-center p-6">
              <p className="card max-w-xs p-4 text-center text-sm font-semibold">No checks in this view yet — run “Re-check now” to fill the map.</p>
            </div>
          )}
          {heatmap.data && <Legend counts={counts} hot={!region && !!heatmap.data.hot_zones.length} />}
        </section>

        {/* Right column */}
        <aside className="flex min-w-0 flex-col gap-6 lg:col-span-4">
          <Reveal className="grid grid-cols-2 gap-4">
            {heatmap.data ? (
              <>
                <Tile label="In stock" value={counts.in_stock} className="bg-sage" />
                <Tile label="Out of stock" value={counts.out_of_stock} className="border-dashed bg-linen" />
                <Tile label="Price gap" value={counts.price_gap} className="bg-sand" />
                <Tile label="Total" value={counts.total} className="bg-slate text-linen" />
              </>
            ) : (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[120px] rounded-[16px]" />)
            )}
          </Reveal>
          <Reveal delay={0.06}>
          <AiSummary
            text={overview.data?.summary?.summary_text}
            loading={!overview.data && !overview.error}
            recs={recs.data?.items}
            onDecided={() => {
              recs.mutate();
              overview.mutate();
              // Approving can start a re-check: follow it live if one is now running.
              if (!run.running) void run.attachActive().catch(() => undefined);
            }}
          />
          </Reveal>
          <Reveal delay={0.12}>
          <WorstAreas
            loading={!heatmap.data}
            rows={worst}
            selected={selected}
            onSelect={select}
            highlight={hovered}
            onHover={setHovered}
          />
          </Reveal>
        </aside>
      </div>

      {/* Snapshot bar */}
      <section data-mochi="heatmap-snapshot" className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-[20px] border-2 border-ink bg-sand px-5 py-4 shadow-[6px_6px_0_var(--ink)] sm:px-[34px] lg:h-[72px] lg:py-0">
        <div className="flex items-center gap-2">
          <img src={`${A}/imgContainer20.svg`} alt="" width={18} height={18} />
          <span className="text-[18px] font-semibold leading-[27px]">Snapshot</span>
        </div>
        <div role="tablist" aria-label="Snapshot time" className="flex flex-wrap items-center gap-1">
          {SNAPSHOTS.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={snapshot === s.key}
              onClick={() => setSnapshot(s.key)}
              className={`inline-flex h-10 items-center rounded-full px-4 text-[15px] font-semibold leading-[22.5px] transition-colors ${snapshot === s.key ? "press press-2 bg-slate text-linen" : "text-ink hover:text-slate"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            className="btn btn-ink h-11 px-[22px] text-[14px] leading-[21px]"
            disabled={!targets.length || busy || product?.paused || nothingToRun}
            title={
              !targets.length
                ? "Tap a pin to select it"
                : nothingToRun
                  ? "None of these apps can be checked in live mode"
                  : `${targets.join(", ")} on ${runPlatforms.map(platformLabel).join(", ")}${est ? ` · ${est.jobs} check${est.jobs === 1 ? "" : "s"} (you + confirmed rivals)` : ""}`
            }
            onClick={() => startRun({ pincodes: targets, ...(platform ? { platforms: [platform] } : {}) })}
          >
            <img src={`${A}/imgContainer21.svg`} alt="" width={12} height={15} />
            {run.running && prog
              ? `Checking… ${progLabel}`
              : run.starting
                ? "Starting…"
                : !targets.length
                  ? "Select a pin to re-check"
                  : nothingToRun
                    ? "Not available in live mode"
                    : credits == null
                      ? "Re-check selected"
                      : `Re-check selected · ${credits} credit${credits === 1 ? "" : "s"}`}
          </button>
          {est && targets.length > 0 && !busy && (
            <span className="text-[12px] font-semibold text-ink/75">
              {est.jobs} check{est.jobs === 1 ? "" : "s"}
              {est.skipped_platforms.length ? ` · skips ${est.skipped_platforms.map((s) => platformLabel(s.platform)).join(", ")}` : ""}
              {est.remaining_credits != null ? ` · ${est.remaining_credits} credits left today` : ""}
            </span>
          )}
        </div>
      </section>

      <AnimatePresence>
        {detailOpen && selected && (
        <PinDetailModal
          key="detail"
          detail={detail.data}
          error={detail.error}
          onClose={() => setDetailOpen(false)}
          inRecheck={recheck.has(selected)}
          toggleRecheck={() => toggleRecheck(selected)}
        />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Controls ---------- */

function Menu({
  label,
  icon,
  value,
  onChange,
  options,
  ariaLabel,
  align = "left",
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: { key: string; label: string }[];
  ariaLabel: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${label}`}
        onClick={() => setOpen(!open)}
        className={`${BOX_BUTTON} flex items-center gap-2 px-[18px] text-[15px] font-semibold leading-[22.5px]`}
      >
        {icon}
        <span className="whitespace-nowrap">{label}</span>
        <img src={`${A}/imgContainer11.svg`} alt="" width={10} height={6} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute top-[calc(100%+8px)] z-[1200] min-w-full overflow-hidden rounded-[12px] border-2 border-ink bg-linen py-1 shadow-[4px_4px_0_var(--ink)] ${align === "right" ? "right-0" : "left-0"}`}
        >
          {options.map((o) => (
            <li key={o.key || "_"}>
              <button
                role="option"
                aria-selected={value === o.key}
                onClick={() => {
                  onChange(o.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-4 whitespace-nowrap px-4 py-2 text-left text-[14px] font-semibold ${value === o.key ? "bg-slate text-linen" : "hover:bg-sand/50"}`}
              >
                {o.label}
                {value === o.key && <span aria-hidden>✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Map overlays ---------- */

function Legend({ counts, hot }: { counts: MapSummary; hot: boolean }) {
  const dot = "grid size-[18px] shrink-0 place-items-center rounded-full border border-ink";
  return (
    <div className="absolute bottom-6 left-6 z-[800] flex flex-col gap-[10px] rounded-[12px] border-2 border-ink bg-linen p-4 text-[14px] font-semibold leading-[21px] shadow-[4px_4px_0_var(--ink)]">
      <div className="flex items-center gap-[10px]">
        <span className={`${dot} bg-sage`}><img src={`${A}/imgContainer18.svg`} alt="" width={10} height={7} /></span>
        In stock (<CountUp value={counts.in_stock} duration={0.6} />)
      </div>
      <div className="flex items-center gap-[10px]">
        <span className={`${dot} border-dashed bg-linen`}><img src={`${A}/imgContainer19.svg`} alt="" width={8} height={8} /></span>
        Out of stock (<CountUp value={counts.out_of_stock} duration={0.6} />)
      </div>
      <div className="flex items-center gap-[10px]">
        <span className={`${dot} bg-sand text-[11px] font-bold leading-[16.5px]`}>₹</span>
        Price gap (<CountUp value={counts.price_gap} duration={0.6} />)
      </div>
      {counts.stale > 0 && (
        <div className="flex items-center gap-[10px]">
          <span className={`${dot} bg-linen text-[11px] font-bold opacity-50`}>…</span>
          Not checked recently (<CountUp value={counts.stale} duration={0.6} />)
        </div>
      )}
      {(counts.unavailable ?? 0) > 0 && (
        <div className="flex items-center gap-[10px]">
          <span className={`${dot} border-dashed bg-linen text-[11px] font-bold opacity-50`}>–</span>
          {UNAVAILABLE_LABEL} (<CountUp value={counts.unavailable ?? 0} duration={0.6} />)
        </div>
      )}
      {hot && (
        <div className="flex items-center gap-[10px]">
          <span className={`${dot} border-2 border-dashed border-slate bg-slate/15`} />
          Hot zone
        </div>
      )}
    </div>
  );
}

function PinCallout({
  pin,
  showRival,
  inRecheck,
  onToggleRecheck,
  onDetails,
  onClose,
}: {
  pin: MapPin;
  showRival: boolean;
  inRecheck: boolean;
  onToggleRecheck: () => void;
  onDetails: () => void;
  onClose: () => void;
}) {
  const unavailable = isUnavailable(pin);
  const label = unavailable ? UNAVAILABLE_LABEL : STATUS_META[pin.status]?.label ?? pin.status;
  return (
    <>
      <button type="button" onClick={onClose} aria-label="Close" className="absolute right-2 top-1.5 text-[18px] font-bold leading-none text-ink/60 hover:text-ink">×</button>
      <p className="pr-4 text-[15px] font-bold leading-[22.5px]">
        {pin.pincode}{pin.area ? ` · ${pin.area}` : ""}
      </p>
      <p className="text-[14px] font-medium leading-[21px]">
        {unavailable ? (
          <>{platformLabel(pin.platform)} · {label}</>
        ) : (
          <>
            {platformLabel(pin.platform)} · {label} · {rupeesPrecise(pin.price)} · Checked {timeAgo(pin.checked_at)}
          </>
        )}
      </p>
      {showRival && !unavailable && (
        <p className="text-[13px] font-medium leading-[19.5px] text-deep">
          {pin.rival_price != null ? `Cheapest rival ${rupeesPrecise(pin.rival_price)}` : "No in-stock rival price in the last 24h"}
        </p>
      )}
      <div className="mt-2.5 flex gap-2">
        <button onClick={onDetails} className="press press-2 rounded-[8px] border-2 border-ink bg-sand px-2.5 py-0.5 text-[13px] font-semibold">
          Prices & proof
        </button>
        <button
          onClick={onToggleRecheck}
          aria-pressed={inRecheck}
          className={`press press-2 rounded-[8px] border-2 border-ink px-2.5 py-0.5 text-[13px] font-semibold ${inRecheck ? "bg-sage" : "bg-linen"}`}
        >
          {inRecheck ? "✓ In re-check" : "+ Re-check"}
        </button>
      </div>
    </>
  );
}

/* ---------- Right column ---------- */

function Tile({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={`flex flex-col justify-between gap-2 rounded-[16px] border-2 border-ink p-[18px] text-ink shadow-[4px_4px_0_var(--ink)] ${className}`}>
      <p className="text-[14px] font-semibold uppercase leading-[21px] tracking-[0.7px]">{label}</p>
      <p className="pt-2 font-display text-[48px] font-semibold leading-[48px]"><CountUp value={Math.max(0, Math.round(value || 0))} duration={0.8} /></p>
    </div>
  );
}

function AiSummary({
  text,
  loading,
  recs,
  onDecided,
}: {
  text?: string;
  loading: boolean;
  recs?: Recommendation[];
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<"send" | "approve" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const top = useMemo(
    () => [...(recs ?? [])].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3))[0],
    [recs],
  );
  const act = async (kind: "send" | "approve") => {
    if (!top) return;
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === "send") {
        const r = await actOnRecommendation(top.id, "send-telegram");
        setMsg(r.message ?? null);
        toastTelegramResult(r);
      } else {
        const r = await actOnRecommendation(top.id, "approve");
        const m = r?.message || "Recommendation approved";
        setMsg(m);
        toast(m);
        refreshActionViews();
        onDecided();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong");
      handleDecisionError(e, onDecided);
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className="flex flex-col rounded-[20px] border-2 border-linen bg-ink p-[26px] text-linen shadow-[6px_6px_0_var(--ink)]">
      <h2 className="flex items-center gap-2 pb-[10px] font-sans text-[18px] font-semibold leading-[27px]">
        <img src={`${A}/imgContainer13.svg`} alt="" width={15} height={15} />
        AI summary
      </h2>
      {loading ? (
        <Skeleton className="h-24 bg-linen/20" />
      ) : (
        <p className="text-[15px] leading-[24.38px]">{text ?? "Run a check to get a summary for this product."}</p>
      )}
      {top && <p className="mt-3 line-clamp-2 text-[13px] leading-[19.5px] text-sand">Top action: {top.action_text}</p>}
      <div className="mt-5 flex flex-col gap-3">
        <button className="btn btn-sand h-12 w-full px-[18px] text-[15px] leading-[22.5px]" disabled={!top || !!busy} onClick={() => act("send")}>
          <img src={`${A}/imgContainer14.svg`} alt="" width={16} height={13} />
          {busy === "send" ? "Sending…" : "Send to Telegram"}
        </button>
        <button className="btn btn-ghost h-12 w-full px-[18px] text-[15px] leading-[22.5px]" disabled={!top || !!busy} onClick={() => act("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>
      {(msg || (!top && recs)) && (
        <p className="mt-3 text-[13px] leading-[19.5px] text-linen/80" role="status">{msg ?? "No pending recommendation right now."}</p>
      )}
    </article>
  );
}

function WorstAreas({
  loading,
  rows,
  selected,
  onSelect,
  highlight,
  onHover,
}: {
  loading: boolean;
  rows: HeatmapPin[];
  selected: string | null;
  onSelect: (code: string) => void;
  highlight: string | null;
  onHover: (code: string | null) => void;
}) {
  return (
    <section className="rounded-[20px] border-2 border-ink bg-linen p-[22px] shadow-[6px_6px_0_var(--ink)]">
      <h2 className="pb-2 font-sans text-[18px] font-semibold leading-[27px]">Worst areas</h2>
      {loading ? (
        <Skeleton className="h-36" />
      ) : !rows.length ? (
        <p className="py-3 text-[14px] text-deep">No stock-outs or price gaps in this view.</p>
      ) : (
        <ul className="stagger">
          {rows.map((p) => {
            // Keep paise: a ₹0.50 gap must not read as "Same as rival".
            const gap = p.price != null && p.rival_price != null ? Math.round((p.price - p.rival_price) * 100) / 100 : null;
            return (
              <li key={`${p.platform}-${p.pincode}`} className="border-b border-ink/20 last:border-b-0">
                <button
                  onClick={() => onSelect(p.pincode)}
                  onPointerEnter={() => onHover(p.pincode)}
                  onPointerLeave={() => onHover(null)}
                  onFocus={() => onHover(p.pincode)}
                  onBlur={() => onHover(null)}
                  aria-pressed={selected === p.pincode}
                  className={`-mx-2 flex h-[72px] w-[calc(100%+16px)] items-center justify-between gap-3 rounded-[10px] px-2 text-left transition-[transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] ${selected === p.pincode ? "bg-sand/40" : highlight === p.pincode ? "bg-sand/20" : "hover:bg-sand/20"} ${highlight === p.pincode ? "translate-x-1" : ""}`}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {p.status === "out_of_stock" ? (
                      <span className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-dashed border-ink bg-linen">
                        <img src={`${A}/imgContainer15.svg`} alt="Out of stock" width={10} height={10} />
                      </span>
                    ) : (
                      <span className="grid size-8 shrink-0 place-items-center rounded-full border-2 border-ink bg-sand text-[14px] font-bold" aria-label="Price gap">₹</span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold leading-[18.75px]">{p.area ?? p.pincode}</span>
                      <span className="block text-[13px] font-medium leading-[19.5px]">{p.pincode}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[15px] font-semibold leading-[18.75px]">{rupeesPrecise(p.price)}</span>
                    <span className="block text-[13px] font-semibold leading-[19.5px]">
                      {gap == null ? platformLabel(p.platform) : gap > 0 ? `${rupeesPrecise(gap)} above rival` : gap < 0 ? `${rupeesPrecise(-gap)} below rival` : "Same as rival"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------- Pin detail ---------- */

function PinDetailModal({
  detail,
  error,
  onClose,
  inRecheck,
  toggleRecheck,
}: {
  detail?: PinDetail;
  error?: unknown;
  onClose: () => void;
  inRecheck: boolean;
  toggleRecheck: () => void;
}) {
  const [replayFor, setReplayFor] = useState<string | null>(null);
  const mobile = useIsMobile();
  const dialog = useRef<HTMLDivElement>(null);
  // Tab stays inside the drawer, Esc closes it (the screenshot lightbox stacks its own trap on top).
  useFocusTrap(dialog, true, { onEscape: onClose, initialFocus: "[data-close]" });
  useScrollLock(true);
  // Drawer: slides in from the right (from the bottom on phones) over a fading backdrop.
  const off = mobile ? { y: "100%" } : { x: "100%" };
  return (
    <div className="fixed inset-0 z-[2000]">
      <motion.div
        className="absolute inset-0 bg-ink/60"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.25 } }}
        exit={{ opacity: 0, transition: { duration: 0.2, delay: 0.05 } }}
      />
      <motion.div
        data-lenis-prevent
        className="pointer-events-none absolute inset-x-0 bottom-0 flex max-h-full justify-end overflow-y-auto p-4 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-[calc(32rem+2rem)] sm:items-start"
        initial={off}
        animate={{ x: 0, y: 0, transition: { duration: 0.42, ease: EASE } }}
        exit={{ ...off, transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }}
      >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-detail-title"
        className="card pointer-events-auto w-full max-w-lg p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="label">Pincode</p>
            <h3 id="pin-detail-title" className="text-2xl font-semibold">{detail ? `${detail.pincode} · ${detail.area}` : "Loading pincode…"}</h3>
            {detail && <p className="text-sm text-deep">{detail.city}</p>}
          </div>
          <button type="button" data-close onClick={onClose} className="text-2xl font-bold leading-none" aria-label="Close pincode detail">×</button>
        </div>
        {error ? <ErrorCard error={error} /> : !detail && <Skeleton className="mt-3 h-40" />}
        <div className="mt-3 space-y-4">
          {detail?.platforms.map((row) => {
            const pl = row as PinPlatform;
            const replayOpen = replayFor === pl.platform;
            const hasTrace = !!(pl.seller.result_id || pl.seller.run_id);
            const neverChecked = !!pl.unavailable_reason && pl.seller.status === "missing";
            return (
              <div key={pl.platform} className="rounded-xl border-2 border-ink p-3">
                <div className="flex items-center justify-between">
                  <b>{platformLabel(pl.platform)}</b>
                  {neverChecked ? (
                    <span className="chip border-dashed bg-linen text-ink/75">{UNAVAILABLE_LABEL}</span>
                  ) : (
                    <StatusBadge status={pl.status} />
                  )}
                </div>
                {pl.unavailable_reason && (
                  <p className="mt-1 text-xs text-deep">
                    {UNAVAILABLE_LABEL}: {pl.unavailable_reason}. Re-checks skip this app{neverChecked ? "." : "; the prices below are from an earlier check."}
                  </p>
                )}
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">Prices on {platformLabel(pl.platform)} at {detail.pincode}</caption>
                  <tbody>
                    <tr className="font-semibold">
                      <th scope="row" className="text-left font-semibold">You</th>
                      <td className="text-right">{pl.seller.in_stock === false ? "✕ Out of stock" : rupees(pl.seller.price, 2)}</td>
                      <td className="w-12 text-right text-xs">{etaLabel(pl.seller.eta)}</td>
                    </tr>
                    {pl.rivals.map((r) => (
                      <tr key={r.competitor_id}>
                        <th scope="row" className="max-w-40 truncate text-left font-normal">{r.name}</th>
                        <td className="text-right">{r.in_stock === false ? "✕ Out of stock" : rupees(r.price, 2)}</td>
                        <td className="w-12 text-right text-xs">{etaLabel(r.eta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-deep">
                  <span>checked {timeAgo(pl.seller.checked_at)}</span>
                  <span className="flex gap-3">
                    {hasTrace && (
                      <button
                        type="button"
                        className="font-semibold text-ink underline"
                        aria-expanded={replayOpen}
                        onClick={() => setReplayFor(replayOpen ? null : pl.platform)}
                      >
                        {replayOpen ? "Hide agent replay" : "Agent replay"}
                      </button>
                    )}
                  </span>
                </div>
                {replayOpen ? (
                  <div className="mt-3 border-t-2 border-ink/20 pt-3">
                    <AgentReplay
                      resultId={pl.seller.result_id}
                      runId={pl.seller.run_id}
                      platform={pl.platform}
                      pincode={detail.pincode}
                    />
                  </div>
                ) : (
                  pl.seller.screenshot_url && (
                    <div className="mt-3 max-w-[240px]">
                      <ScreenshotThumb url={pl.seller.screenshot_url} alt={`${platformLabel(pl.platform)} at ${detail.pincode} — evidence screenshot`} />
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
        <button type="button" className={`btn btn-sm mt-4 w-full ${inRecheck ? "btn-sage" : "btn-ghost"}`} onClick={toggleRecheck} aria-pressed={inRecheck}>
          {inRecheck ? "✓ Selected for re-check" : "Select for re-check"}
        </button>
      </div>
      </motion.div>
    </div>
  );
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 639px)");
    const sync = () => setMobile(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, []);
  return mobile;
}
