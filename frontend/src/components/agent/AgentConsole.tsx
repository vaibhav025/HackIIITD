"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { duration, etaLabel, platformLabel, rupees } from "@/lib/format";
import type { Health, TinyFishMode } from "@/lib/types";
import type { AgentJobState, RunState } from "@/lib/useRun";
import { ModeBadge, PlatformMark, ScreenshotThumb, TruePriceBreakdown, jobTitle, whoLabel } from "./parts";
import StepTimeline from "./StepTimeline";

/** Re-renders every `ms` while `active`; returns Date.now(). */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Filter = "all" | "running" | "done" | "failed";

export interface AgentConsoleProps {
  run: RunState;
  /** competitor_id → display name, for rival cards. */
  names?: Record<string, string> | Map<string, string>;
  title?: string;
  /** Replay of a finished run (no live timer, label says so). */
  replay?: boolean;
  onClose?: () => void;
  className?: string;
  /** Extra header controls (e.g. replay speed). */
  actions?: React.ReactNode;
}

/**
 * TinyFish Agent console: one card per agent session (platform × pincode × own/rival), each with a
 * live step timeline, result chip, true-price breakdown and evidence screenshot. Screen readers get
 * a polite progress summary only when the counts change — not every step.
 */
export default function AgentConsole({ run, names, title = "Agent console", replay, onClose, className = "", actions }: AgentConsoleProps) {
  const health = useApi<Health>(run.mode ? null : "/health");
  const mode: TinyFishMode | null = run.mode ?? health.data?.tinyfish_mode ?? (health.data ? (health.data.mock_mode ? "simulated" : "live") : null);
  const live = run.phase === "starting" || run.phase === "running";
  const now = useNow(live && !replay);
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const [filter, setFilter] = useState<Filter>("all");

  const lookup = (id: string | null) => {
    if (!id || !names) return null;
    return names instanceof Map ? names.get(id) ?? null : names[id] ?? null;
  };

  const jobs = useMemo(() => run.order.map((k) => run.jobs[k]).filter(Boolean), [run.order, run.jobs]);
  const counts = useMemo(() => {
    const c = { running: 0, done: 0, failed: 0 };
    for (const j of jobs) {
      if (j.phase === "running") c.running++;
      else if (j.phase === "done") c.done++;
      else if (j.phase === "failed") c.failed++;
    }
    return c;
  }, [jobs]);
  const total = Math.max(run.total, jobs.length, run.completed);
  const queued = Math.max(0, total - jobs.length);
  const ratio = total ? Math.min(1, run.completed / total) : 0;
  const shown = filter === "all" ? jobs : jobs.filter((j) => j.phase === filter);
  const finished = run.phase === "done" || run.phase === "failed" || run.phase === "error";

  const summary = finished
    ? run.phase === "error"
      ? `Agent run stopped: ${run.error ?? "unknown error"}`
      : `Agent run complete: ${run.completed - run.failed} of ${total} checks succeeded${run.failed ? `, ${run.failed} failed` : ""}.`
    : `Agents running: ${run.completed} of ${total || "?"} checks finished${run.failed ? `, ${run.failed} failed` : ""}.`;

  return (
    <section
      aria-label={title}
      className={`card overflow-hidden ${className}`}
      data-phase={run.phase}
    >
      {/* Header */}
      <div className="bg-ink text-linen px-5 sm:px-[26px] py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-3 min-w-0">
          {live && !replay ? <span className="ss-live-dot shrink-0" aria-hidden /> : <span aria-hidden className="size-2 rounded-full bg-sand shrink-0" />}
          <h2 className="text-[24px] leading-8 tracking-[-0.4px] truncate">{title}</h2>
          <ModeBadge mode={mode} />
          {replay && <span className="text-[12px] font-bold uppercase tracking-[0.7px] text-sand">Replay</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
            <Stat label="Elapsed" value={clock(elapsed)} mono />
            <Stat label="Agents" value={run.concurrency ? `${counts.running}/${run.concurrency} parallel` : `${counts.running} active`} />
            <Stat label="Credits" value={String(run.creditsUsed)} mono />
          </dl>
          {actions}
          {onClose && finished && (
            <button type="button" className="btn btn-sand btn-sm" onClick={onClose}>
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="px-5 sm:px-[26px] pt-4 pb-3 border-b-2 border-ink bg-linen flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-[15px] leading-6" aria-hidden>
            {finished ? (
              run.phase === "error" ? (
                <>✕ {run.error}</>
              ) : (
                <>
                  {run.phase === "failed" ? "✕ Failed" : run.status === "partial" ? "! Partly done" : "✓ Done"} —{" "}
                  {run.completed - run.failed} succeeded{run.failed ? `, ${run.failed} failed` : ""}
                </>
              )
            ) : run.phase === "starting" ? (
              "Launching browser agents…"
            ) : run.overdue ? (
              "Still running: taking longer than usual. Results appear as each agent finishes."
            ) : (
              `Agents are browsing ${total || "your"} pincode × platform pair${total === 1 ? "" : "s"}…`
            )}
          </p>
          <p className="eyebrow tabular-nums" aria-hidden>
            {Math.min(run.completed, total)}/{total || "?"} checks
            {run.connection === "polling" && !finished && <span className="ml-2 text-slate normal-case font-semibold tracking-normal">· reconnecting, polling</span>}
            {run.connection === "reconnecting" && !finished && <span className="ml-2 text-slate normal-case font-semibold tracking-normal">· reconnecting…</span>}
          </p>
        </div>
        <div className="h-[10px] rounded-full overflow-hidden bg-ink/15 border border-ink/30" aria-hidden>
          <div
            className={`h-full rounded-full origin-left transition-transform duration-500 ${finished ? (run.failed && run.failed === total ? "bg-sand" : "bg-ink") : "bg-slate"}`}
            style={{ transform: `scaleX(${finished ? 1 : ratio})` }}
          />
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {summary}
        </p>
        {jobs.length > 4 && (
          <div className="flex flex-wrap gap-2 pt-1" role="group" aria-label="Filter agent sessions">
            {(
              [
                ["all", `All ${jobs.length}`],
                ["running", `Running ${counts.running}`],
                ["done", `Done ${counts.done}`],
                ["failed", `Failed ${counts.failed}`],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button key={f} type="button" className="pill py-1! px-3! text-[13px]!" data-active={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Job grid */}
      <div className="p-4 sm:p-[22px] bg-linen">
        {shown.length === 0 && queued === 0 ? (
          <p className="text-[14px] text-ink/75 py-6 text-center">{filter === "all" ? "Waiting for the first agent to start…" : "No sessions in this state."}</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {shown.map((j) => (
              <JobCard key={j.key} job={j} name={lookup(j.job.competitor_id)} />
            ))}
            {filter === "all" &&
              queued > 0 &&
              (queued <= 3 ? (
                Array.from({ length: queued }).map((_, i) => <QueuedCard key={`q${i}`} />)
              ) : (
                <li className="border-2 border-dashed border-ink/40 rounded-[16px] p-4 grid place-items-center text-[14px] font-semibold text-ink/75 min-h-[96px]">
                  + {queued} more agent{queued === 1 ? "" : "s"} queued
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[11px] font-bold uppercase tracking-[0.7px] text-sand">{label}</dt>
      <dd className={`font-semibold ${mono ? "tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function QueuedCard() {
  return (
    <li className="border-2 border-dashed border-ink/40 rounded-[16px] p-4 flex flex-col gap-2 min-h-[96px]" aria-hidden>
      <div className="skeleton h-5 w-1/2" />
      <div className="skeleton h-3 w-3/4" />
      <p className="text-[12px] text-ink/70 font-semibold">Queued</p>
    </li>
  );
}

function ResultChip({ job }: { job: AgentJobState }) {
  if (job.phase === "failed") {
    return (
      <span className="chip bg-linen border-dashed">
        <span aria-hidden>✕</span> Failed
      </span>
    );
  }
  if (job.phase !== "done") {
    return (
      <span className="chip bg-linen">
        <span className="ss-spin size-3! border-[1.5px]!" aria-hidden /> {job.phase === "queued" ? "Queued" : "Checking"}
      </span>
    );
  }
  const r = job.result;
  const status = r?.status;
  if (status === "failed" || status === "error") {
    return (
      <span className="chip bg-linen border-dashed">
        <span aria-hidden>✕</span> Failed
      </span>
    );
  }
  if (r?.in_stock === false || status === "out_of_stock") {
    return (
      <span className="chip bg-linen border-dashed">
        <span aria-hidden>✕</span> Out of stock
      </span>
    );
  }
  return (
    <span className="chip bg-sage text-ink">
      <span aria-hidden>✓</span> In stock{r?.price != null ? ` · ${rupees(r.price, r.price % 1 ? 2 : 0)}` : ""}
    </span>
  );
}

function JobCard({ job, name }: { job: AgentJobState; name: string | null }) {
  const { platform, pincode, competitor_id } = job.job;
  const who = whoLabel(competitor_id, job.job.competitor_name || name);
  const running = job.phase === "running" || job.phase === "queued";
  const failed = job.phase === "failed" || job.result?.status === "failed";
  const now = useNow(running, 500);
  const elapsed = job.ms ?? (job.startedAt ? (job.finishedAt ?? now) - job.startedAt : null);
  const r = job.result;
  const lastStep = job.steps[job.steps.length - 1];
  const truePrice = job.truePrice ?? r?.true_price ?? null;

  return (
    <li
      className={`relative flex flex-col gap-3 rounded-[16px] border-2 border-ink bg-linen p-4 min-w-0 shadow-[4px_4px_0_var(--ink)] ${
        failed ? "border-dashed shadow-none" : ""
      }`}
      aria-label={jobTitle(platform, pincode, who)}
    >
      <header className="flex items-start gap-3 min-w-0">
        <PlatformMark platform={platform} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[15px] leading-5 truncate">
            {platformLabel(platform)} <span className="text-ink/60 font-medium">·</span> <span className="tabular-nums">{pincode}</span>
          </p>
          <p className="text-[12px] leading-[18px] text-ink/75 truncate">
            {competitor_id ? "Rival · " : ""}
            {who}
          </p>
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-ink/70 shrink-0 pt-0.5">{elapsed != null ? duration(elapsed) : ""}</span>
      </header>

      {job.goal && (
        <p className="text-[12px] leading-[18px] text-ink/75 line-clamp-2" title={job.goal}>
          <span className="font-bold uppercase tracking-[0.6px] text-[10px] text-slate mr-1">Goal</span>
          {job.goal}
        </p>
      )}

      {running ? (
        <StepTimeline steps={job.steps} running failed={false} />
      ) : (
        <details className="group">
          <summary className="cursor-pointer list-none flex items-center gap-2 text-[12px] font-semibold text-slate select-none">
            <span aria-hidden className="transition-transform group-open:rotate-90">▸</span>
            {job.steps.length ? `${job.steps.length} agent steps` : "Agent steps"}
            {job.sessionId && <span className="font-mono font-normal text-ink/60 truncate">{job.sessionId}</span>}
          </summary>
          <div className="pt-2">
            <StepTimeline steps={job.steps} running={false} failed={failed} dense />
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ResultChip job={job} />
        {!running && !failed && r?.eta_minutes != null && <span className="chip bg-linen">Delivery {etaLabel(Math.round(r.eta_minutes))}</span>}
        {!running && !failed && r?.mrp != null && r.price != null && r.mrp > r.price && (
          <span className="text-[12px] text-ink/70">
            MRP <s>{rupees(r.mrp)}</s>
          </span>
        )}
      </div>

      {failed && (job.error || lastStep?.kind === "error") && (
        <p className="text-[13px] leading-5 font-medium bg-sand/60 border-2 border-ink rounded-[10px] px-3 py-2">
          {job.error ?? lastStep?.label}
        </p>
      )}

      {!running && truePrice && <TruePriceBreakdown price={truePrice} compact />}
      {!running && r?.screenshot_url && <ScreenshotThumb url={r.screenshot_url} alt={`${jobTitle(platform, pincode, who)} — evidence`} />}
    </li>
  );
}
