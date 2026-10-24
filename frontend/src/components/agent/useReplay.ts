"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { prefersReducedMotion } from "@/lib/motion";
import type { AgentStep, CheckResultDetail, RunDetail } from "@/lib/types";
import { initialRunState, jobKeyOf, type AgentJobState, type RunState } from "@/lib/useRun";

export interface ReplayJob {
  key: string;
  detail: CheckResultDetail | null;
  /** From the run's results list (always present). */
  platform: string;
  pincode: string;
  competitorId: string | null;
  status: string;
  steps: AgentStep[];
  /** ms after the run's first step when this job's first step happened. */
  offset: number;
  /** ms offsets of each step from the run's first step. */
  stepOffsets: number[];
}

const MAX_TRACES = 60;
/** Whole replay squeezed into roughly this long, whatever the original duration. */
const TARGET_MS = 14_000;

const ts = (iso: string | undefined | null) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Loads a finished run plus every job's agent trace (`GET /check-results/{id}`) for replay. */
export function useRunTraces(runId: string | null) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ runId: string; run: RunDetail | null; jobs: ReplayJob[]; error: unknown; loading: boolean } | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setState({ runId, run: null, jobs: [], error: null, loading: true });
    (async () => {
      try {
        const run = await api<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
        const refs = (run.results ?? []).slice(0, MAX_TRACES);
        const details = await Promise.all(
          refs.map((r) => api<CheckResultDetail>(`/check-results/${encodeURIComponent(r.id)}`).catch(() => null)),
        );
        const raw = refs.map((r, i) => {
          const d = details[i];
          const steps = [...(d?.agent?.steps ?? [])].sort((a, b) => a.index - b.index);
          return { r, d, steps };
        });
        const firsts = raw.map((x) => ts(x.steps[0]?.at)).filter((t): t is number => t != null);
        const origin = firsts.length ? Math.min(...firsts) : null;
        const jobs: ReplayJob[] = raw.map(({ r, d, steps }, i) => {
          // Prefer real timestamps; fall back to each step's cumulative `ms` (time since the job
          // started), staggered by job index and kept strictly increasing.
          const stagger = origin == null ? i * 400 : 0;
          let cursor = stagger;
          const stepOffsets = steps.map((s, k) => {
            const at = ts(s.at);
            if (origin != null && at != null) return at - origin;
            cursor = Math.max(cursor + 120, stagger + (s.ms || (k + 1) * 300));
            return cursor;
          });
          return {
            key: r.job_key || jobKeyOf(r),
            detail: d,
            platform: r.platform,
            pincode: r.pincode,
            competitorId: r.competitor_id,
            status: r.status,
            steps,
            offset: stepOffsets[0] ?? (origin == null ? i * 400 : 0),
            stepOffsets,
          };
        });
        if (!cancelled) setState({ runId, run, jobs, error: null, loading: false });
      } catch (error) {
        if (!cancelled) setState({ runId, run: null, jobs: [], error, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // Same object until the loaded data changes: useReplayState's playback effect depends on it, and a
  // fresh object every render would restart (and so freeze) the replay on each 100 ms tick.
  return useMemo(() => (state && state.runId === runId ? { ...state, reload } : null), [state, runId, reload]);
}

function jobAt(j: ReplayJob, t: number, done: boolean, origin: number): AgentJobState {
  const visible = done ? j.steps : j.steps.filter((_, i) => j.stepOffsets[i] <= t);
  const complete = done || visible.length === j.steps.length;
  const failed = j.status === "failed" || j.status === "error" || j.steps[j.steps.length - 1]?.kind === "error";
  const d = j.detail;
  const started = visible.length > 0 || (complete && !j.steps.length);
  return {
    key: j.key,
    job: { platform: j.platform, pincode: j.pincode, competitor_id: j.competitorId },
    phase: !started ? "queued" : complete ? (failed ? "failed" : "done") : "running",
    sessionId: d?.agent?.session_id ?? null,
    goal: d?.agent?.goal ?? null,
    steps: visible,
    result:
      complete && d
        ? {
            id: d.id,
            in_stock: d.in_stock,
            price: d.price,
            mrp: d.mrp,
            eta_minutes: d.eta_minutes,
            rating: d.rating,
            status: d.status,
            screenshot_url: d.screenshot_url,
            checked_at: d.checked_at,
          }
        : null,
    truePrice: complete ? d?.agent?.true_price ?? null : null,
    error: complete && failed ? d?.error ?? j.steps[j.steps.length - 1]?.label ?? "Check failed" : null,
    // While replaying, a running card's timer follows the replay clock (not wall time since the
    // original run, which would read as hours).
    // Step `ms` is cumulative from the job's start, so the last step carries the job's duration.
    ms: complete ? j.steps[j.steps.length - 1]?.ms || null : started ? Math.max(0, t - j.offset) : null,
    startedAt: started ? origin + j.offset : null,
    finishedAt: complete ? origin + (j.stepOffsets[j.stepOffsets.length - 1] ?? j.offset) : null,
  };
}

/**
 * Turns loaded traces into a RunState for <AgentConsole>, optionally animated: steps appear on a
 * compressed version of their real timeline. Reduced motion (or `playNonce` 0) shows the end state;
 * bump `playNonce` to (re)start the animation.
 */
export function useReplayState(traces: ReturnType<typeof useRunTraces>, playNonce: number, speedFactor = 1) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);

  const end = useMemo(() => Math.max(0, ...(traces?.jobs ?? []).map((j) => j.stepOffsets[j.stepOffsets.length - 1] ?? j.offset)), [traces]);
  const scale = end > 0 ? Math.max(1, end / TARGET_MS) * speedFactor : 1;

  const loaded = !!traces && !traces.loading;
  useEffect(() => {
    if (!loaded || !playNonce || prefersReducedMotion() || end <= 0) {
      setPlaying(false);
      setT(Number.POSITIVE_INFINITY);
      return;
    }
    setT(0);
    setPlaying(true);
    const startedAt = performance.now();
    // ~10 fps is plenty for a step list and keeps re-renders cheap.
    const interval = setInterval(() => {
      const elapsed = (performance.now() - startedAt) * scale;
      if (elapsed >= end) {
        clearInterval(interval);
        setT(Number.POSITIVE_INFINITY);
        setPlaying(false);
      } else setT(elapsed);
    }, 100);
    return () => clearInterval(interval);
    // Only these restart playback; the per-tick re-render must not.
  }, [loaded, playNonce, end, scale]);

  const run = useMemo<RunState | null>(() => {
    if (!traces?.run) return null;
    const r = traces.run;
    const done = t === Number.POSITIVE_INFINITY;
    const origin = ts(r.started_at) ?? 0;
    const base = initialRunState(r.id, r.total_jobs, origin);
    const jobs: Record<string, AgentJobState> = {};
    const order: string[] = [];
    let completed = 0;
    let failed = 0;
    for (const j of [...traces.jobs].sort((a, b) => a.offset - b.offset)) {
      const s = jobAt(j, t, done, origin);
      if (s.phase === "queued" && !done) continue;
      jobs[j.key] = s;
      order.push(j.key);
      if (s.phase === "done" || s.phase === "failed") completed++;
      if (s.phase === "failed") failed++;
    }
    const finishedAt = ts(r.finished_at);
    return {
      ...base,
      phase: done ? (r.status === "failed" ? "failed" : "done") : "running",
      status: r.status,
      mode: r.mode ?? null,
      total: Math.max(r.total_jobs, traces.jobs.length),
      completed: done ? Math.max(completed, r.done_jobs) : completed,
      failed: done ? Math.max(failed, r.failed_jobs) : failed,
      creditsUsed: done ? r.credits_used : Math.round((r.credits_used * completed) / Math.max(1, traces.jobs.length)),
      finishedAt: done ? finishedAt ?? origin + end : origin + Math.min(t, end),
      startedAt: origin,
      jobs,
      order,
      connection: "closed",
    };
  }, [traces, t, end]);

  return { run, playing };
}
