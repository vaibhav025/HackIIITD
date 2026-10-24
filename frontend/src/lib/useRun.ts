"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError, errorMessage, streamUrl } from "./api";
import { mochiEmit } from "./mochi-bus";
import type {
  AgentJob,
  AgentStep,
  RunDetail,
  RunEvent,
  RunEventResult,
  RunResultRef,
  RunSummary,
  TinyFishMode,
  TruePrice,
} from "./types";

// ---- State model ------------------------------------------------------------------------------

export type JobPhase = "queued" | "running" | "done" | "failed";

export interface AgentJobState {
  key: string;
  job: AgentJob;
  phase: JobPhase;
  sessionId: string | null;
  goal: string | null;
  /** Ordered by `index`, unique per index. */
  steps: AgentStep[];
  result: RunEventResult | null;
  truePrice: TruePrice | null;
  error: string | null;
  /** Wall-clock duration reported by the backend, when known. */
  ms: number | null;
  /** Client clock (ms) when the job was first seen running / finished. */
  startedAt: number | null;
  finishedAt: number | null;
}

export type RunPhase = "starting" | "running" | "done" | "failed" | "error";
export type Connection = "connecting" | "live" | "reconnecting" | "polling" | "closed";

export interface RunState {
  runId: string;
  phase: RunPhase;
  /** Backend run status string once finished (done / partial / failed …). */
  status: string | null;
  mode: TinyFishMode | null;
  concurrency: number | null;
  total: number;
  /** Completed jobs (successful + failed). */
  completed: number;
  failed: number;
  creditsUsed: number;
  startedAt: number;
  finishedAt: number | null;
  jobs: Record<string, AgentJobState>;
  /** Job keys in first-seen order (stable card order). */
  order: string[];
  connection: Connection;
  error: string | null;
  /** Highest SSE `id` applied — used for Last-Event-ID resume and dedupe. */
  lastSeq: number;
  /** Still running on the server well past the expected time (never treated as failed). */
  overdue: boolean;
}

/** Back-compat summary used by the product + heatmap pages. `done` = successful results. */
export interface RunProgress {
  runId: string;
  done: number;
  failed: number;
  total: number;
  finished: boolean;
}

const ACTIVE_STATUSES = new Set(["queued", "pending", "running", "starting"]);
export const isActiveRunStatus = (status: string | null | undefined) => !!status && ACTIVE_STATUSES.has(status);

export const jobKeyOf = (job: Partial<AgentJob> | undefined | null) =>
  `${job?.platform ?? "?"}:${job?.pincode ?? "?"}:${job?.competitor_id || "own"}`;

/** Parses a `platform:pincode:competitor|own` key back into a job. */
export function jobFromKey(key: string): AgentJob {
  const [platform = "", pincode = "", rival = "own"] = key.split(":");
  return { platform, pincode, competitor_id: rival === "own" ? null : rival };
}

export function initialRunState(runId: string, total = 0, startedAt = Date.now()): RunState {
  return {
    runId,
    phase: "starting",
    status: null,
    mode: null,
    concurrency: null,
    total,
    completed: 0,
    failed: 0,
    creditsUsed: 0,
    startedAt,
    finishedAt: null,
    jobs: {},
    order: [],
    connection: "connecting",
    error: null,
    lastSeq: 0,
    overdue: false,
  };
}

const parseTime = (iso: string | null | undefined) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * How long a run should reasonably take, measured from the server's `started_at`: jobs run
 * `concurrency` at a time, live agent sessions take up to ~10 min each (plus a retry), simulated
 * ones seconds. Past this the run is shown as "still running", never as failed.
 */
export function expectedRunMs(run: Pick<RunState, "total" | "concurrency" | "mode">) {
  const concurrency = Math.max(1, run.concurrency ?? 2);
  const rounds = Math.ceil(Math.max(1, run.total) / concurrency);
  const perRound = run.mode === "simulated" ? 60_000 : 12 * 60_000;
  return Math.max(5 * 60_000, rounds * perRound);
}

function blankJob(key: string, job?: Partial<AgentJob> | null): AgentJobState {
  const fromKey = jobFromKey(key);
  return {
    key,
    job: {
      platform: job?.platform ?? fromKey.platform,
      pincode: job?.pincode ?? fromKey.pincode,
      competitor_id: job?.competitor_id ?? fromKey.competitor_id,
      competitor_name: job?.competitor_name ?? null,
    },
    phase: "queued",
    sessionId: null,
    goal: null,
    steps: [],
    result: null,
    truePrice: null,
    error: null,
    ms: null,
    startedAt: null,
    finishedAt: null,
  };
}

function upsertJob(
  state: RunState,
  key: string,
  job: Partial<AgentJob> | null | undefined,
  patch: (j: AgentJobState) => AgentJobState,
): RunState {
  const existing = state.jobs[key];
  const base = existing ?? blankJob(key, job);
  const merged =
    existing && job?.competitor_name && !existing.job.competitor_name
      ? { ...base, job: { ...base.job, competitor_name: job.competitor_name } }
      : base;
  return {
    ...state,
    jobs: { ...state.jobs, [key]: patch(merged) },
    order: existing ? state.order : [...state.order, key],
  };
}

function insertStep(steps: AgentStep[], step: AgentStep): AgentStep[] {
  if (typeof step?.index !== "number") return [...steps, { ...step, index: steps.length + 1 }];
  if (steps.some((s) => s.index === step.index)) return steps;
  return [...steps, step].sort((a, b) => a.index - b.index);
}

function recount(state: RunState): RunState {
  let completed = 0;
  let failed = 0;
  for (const key of state.order) {
    const phase = state.jobs[key]?.phase;
    if (phase === "done") completed++;
    else if (phase === "failed") {
      completed++;
      failed++;
    }
  }
  // Never go backwards: server counters (run_done / polling) may know about jobs we never saw.
  return { ...state, completed: Math.max(completed, state.completed), failed: Math.max(failed, state.failed) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Pure reducer for one stream event; safe against duplicates and missing fields. */
export function applyRunEvent(state: RunState, event: RunEvent, now = Date.now()): RunState {
  if (!isRecord(event)) return state;
  const terminal = state.phase === "done" || state.phase === "failed";
  switch (event.type) {
    case "run_started":
      return {
        ...state,
        phase: terminal ? state.phase : "running",
        total: event.total_jobs ?? state.total,
        mode: event.mode ?? state.mode,
        concurrency: event.concurrency ?? state.concurrency,
      };
    case "job_started": {
      const key = event.job_key || jobKeyOf(event.job);
      return {
        ...upsertJob({ ...state, phase: terminal ? state.phase : "running" }, key, event.job, (j) => ({
          ...j,
          phase: j.phase === "queued" ? "running" : j.phase,
          sessionId: event.session_id ?? j.sessionId,
          goal: event.goal ?? j.goal,
          startedAt: j.startedAt ?? now,
        })),
      };
    }
    case "agent_step": {
      if (!event.job_key || !isRecord(event.step)) return state;
      const step = event.step;
      return upsertJob({ ...state, phase: terminal ? state.phase : "running" }, event.job_key, null, (j) => ({
        ...j,
        phase: j.phase === "queued" ? "running" : j.phase,
        startedAt: j.startedAt ?? now,
        steps: insertStep(j.steps, step),
      }));
    }
    case "result": {
      const result: RunEventResult = isRecord(event.result) ? event.result : (event as unknown as RunEventResult);
      const key = event.job_key || result.job_key || jobKeyOf(result);
      if (state.jobs[key]?.phase === "done") return state;
      const truePrice = event.true_price ?? result.true_price ?? null;
      const next = upsertJob(state, key, result, (j) => ({
        ...j,
        phase: "done",
        result,
        truePrice: truePrice ?? j.truePrice,
        error: null,
        ms: result.ms ?? j.ms,
        startedAt: j.startedAt ?? now,
        finishedAt: now,
      }));
      return recount({ ...next, creditsUsed: next.creditsUsed + (typeof result.credits === "number" ? result.credits : 0) });
    }
    case "job_failed": {
      const key = event.job_key || jobKeyOf(event.job);
      const prev = state.jobs[key]?.phase;
      if (prev === "failed" || prev === "done") return state;
      return recount(
        upsertJob(state, key, event.job, (j) => ({
          ...j,
          phase: "failed",
          error: event.error || "Check failed",
          ms: event.ms ?? j.ms,
          startedAt: j.startedAt ?? now,
          finishedAt: now,
        })),
      );
    }
    case "run_done": {
      const failed = event.failed_jobs ?? state.failed;
      return {
        ...state,
        phase: event.status === "failed" ? "failed" : "done",
        status: event.status ?? "done",
        total: event.total_jobs ?? state.total,
        completed: event.done_jobs ?? state.completed,
        failed,
        creditsUsed: event.credits_used ?? state.creditsUsed,
        finishedAt: state.finishedAt ?? now,
        connection: "closed",
      };
    }
    default:
      return state;
  }
}

/** Folds a `GET /runs/{id}` snapshot (polling fallback / replay) into the state. */
export function applyRunSnapshot(state: RunState, run: RunDetail, now = Date.now()): RunState {
  let next: RunState = {
    ...state,
    total: run.total_jobs ?? state.total,
    mode: run.mode ?? state.mode,
    // Elapsed time and the overdue check follow the server clock, not when this tab attached.
    startedAt: parseTime(run.started_at) ?? state.startedAt,
  };
  for (const r of run.results ?? []) next = applyResultRef(next, r, now);
  next = recount(next);
  next = {
    ...next,
    completed: Math.max(next.completed, run.done_jobs ?? 0),
    failed: Math.max(next.failed, run.failed_jobs ?? 0),
    creditsUsed: Math.max(next.creditsUsed, run.credits_used ?? 0),
  };
  if (!isActiveRunStatus(run.status) && run.status) {
    next = {
      ...next,
      phase: run.status === "failed" ? "failed" : "done",
      status: run.status,
      completed: run.done_jobs ?? next.completed,
      failed: run.failed_jobs ?? next.failed,
      creditsUsed: run.credits_used ?? next.creditsUsed,
      finishedAt: next.finishedAt ?? (run.finished_at ? new Date(run.finished_at).getTime() : now),
    };
  } else if (next.phase === "starting") {
    next = { ...next, phase: "running" };
  }
  return next;
}

function applyResultRef(state: RunState, r: RunResultRef, now: number): RunState {
  const key = r.job_key || jobKeyOf(r);
  const prev = state.jobs[key];
  if (prev && (prev.phase === "done" || prev.phase === "failed")) return state;
  const failed = r.status === "failed" || r.status === "error";
  return upsertJob(state, key, r, (j) => ({
    ...j,
    phase: failed ? "failed" : "done",
    result: { ...(j.result ?? {}), ...r },
    error: failed ? j.error ?? "Check failed" : null,
    startedAt: j.startedAt ?? now,
    finishedAt: j.finishedAt ?? now,
  }));
}

type Action =
  | { kind: "reset"; state: RunState | null }
  | { kind: "event"; event: RunEvent; seq: number | null }
  | { kind: "snapshot"; run: RunDetail }
  | { kind: "connection"; connection: Connection }
  | { kind: "overdue" }
  | { kind: "error"; message: string };

function reducer(state: RunState | null, action: Action): RunState | null {
  if (action.kind === "reset") return action.state;
  if (!state) return state;
  switch (action.kind) {
    case "event": {
      if (action.seq != null && action.seq <= state.lastSeq) return state;
      if (action.event?.run_id && action.event.run_id !== state.runId) return state;
      const next = applyRunEvent(state, action.event);
      const lastSeq = action.seq != null ? action.seq : state.lastSeq;
      const connection = next.connection === "closed" ? "closed" : "live";
      return { ...next, lastSeq, connection };
    }
    case "snapshot":
      return applyRunSnapshot(state, action.run);
    case "connection":
      return state.connection === action.connection || state.connection === "closed"
        ? state
        : { ...state, connection: action.connection };
    case "overdue":
      return state.overdue ? state : { ...state, overdue: true };
    case "error":
      return { ...state, phase: "error", error: action.message, connection: "closed", finishedAt: state.finishedAt ?? Date.now() };
  }
}

// ---- Hook ---------------------------------------------------------------------------------------

const EVENT_TYPES = ["run_started", "job_started", "agent_step", "result", "job_failed", "run_done"] as const;
const POLL_MS = 3000;
/** Polling a run that is past its expected time (the server still says it is running). */
const SLOW_POLL_MS = 15_000;
/**
 * No stream traffic (events or the server's named `ping` heartbeat, sent every 15 s) for this long
 * → the stream is dead; check the run over REST.
 */
const IDLE_MS = 40_000;
const MAX_POLL_FAILURES = 5;

/**
 * Starts (or attaches to) a check run and follows it: SSE stream with Last-Event-ID resume, event
 * dedupe by seq + job_key, REST polling fallback every 3 s when the stream dies. A run that is
 * still going on the server is never marked failed by the client: past its expected duration
 * (from the server's `started_at`) it is flagged `overdue` and keeps being followed.
 * Exposes the full per-job agent state for the Agent console.
 */
export function useRun(productId: string | null, onUpdate?: () => void) {
  const [run, dispatch] = useReducer(reducer, null);
  const runRef = useRef<RunState | null>(null);
  runRef.current = run;
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  const [startError, setStartError] = useState<string | null>(null);

  // Everything that belongs to the currently-followed run; torn down on switch/unmount.
  const session = useRef<{
    runId: string;
    es: EventSource | null;
    timers: Set<ReturnType<typeof setTimeout>>;
    pollTimer: ReturnType<typeof setTimeout> | null;
    pollFailures: number;
    reopened: boolean;
    lastActivity: number;
    stopped: boolean;
  } | null>(null);

  const teardown = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.stopped = true;
    s.es?.close();
    s.timers.forEach(clearTimeout);
    if (s.pollTimer) clearTimeout(s.pollTimer);
    session.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const follow = useCallback(
    (runId: string) => {
      teardown();
      const s = {
        runId,
        es: null as EventSource | null,
        timers: new Set<ReturnType<typeof setTimeout>>(),
        pollTimer: null as ReturnType<typeof setTimeout> | null,
        pollFailures: 0,
        reopened: false,
        lastActivity: Date.now(),
        stopped: false,
      };
      session.current = s;
      const later = (fn: () => void, ms: number) => {
        const t = setTimeout(() => {
          s.timers.delete(t);
          if (!s.stopped) fn();
        }, ms);
        s.timers.add(t);
      };

      let refreshPending = false;
      const refreshSoon = () => {
        if (refreshPending) return;
        refreshPending = true;
        later(() => {
          refreshPending = false;
          updateRef.current?.();
        }, 700);
      };

      const finish = () => {
        s.es?.close();
        s.es = null;
        if (s.pollTimer) clearTimeout(s.pollTimer);
        s.pollTimer = null;
        // The backend regenerates summaries and recommendations right after the run.
        later(() => updateRef.current?.(), 1200);
        later(() => {
          s.stopped = true;
          s.timers.forEach(clearTimeout);
        }, 1500);
      };

      const isFinished = () => {
        const r = runRef.current;
        return !r || r.runId !== runId || r.phase === "done" || r.phase === "failed" || r.phase === "error";
      };

      const poll = async () => {
        s.pollTimer = null;
        if (s.stopped || isFinished()) return;
        try {
          const detail = await api<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
          if (s.stopped) return;
          s.pollFailures = 0;
          dispatch({ kind: "snapshot", run: detail });
          refreshSoon();
          if (!isActiveRunStatus(detail.status)) {
            finish();
            return;
          }
        } catch (e) {
          if (s.stopped) return;
          s.pollFailures++;
          if ((e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 401)) || s.pollFailures >= MAX_POLL_FAILURES) {
            dispatch({ kind: "error", message: `Lost track of this check: ${errorMessage(e)}` });
            finish();
            return;
          }
        }
        if (!s.es || s.es.readyState !== EventSource.OPEN) dispatch({ kind: "connection", connection: "polling" });
        s.pollTimer = setTimeout(poll, runRef.current?.overdue ? SLOW_POLL_MS : POLL_MS);
      };

      // One REST read on attach: server `started_at` (for elapsed / overdue) and results so far.
      const syncOnce = async () => {
        try {
          const detail = await api<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
          if (s.stopped) return;
          dispatch({ kind: "snapshot", run: detail });
          if (!isActiveRunStatus(detail.status)) finish();
        } catch {
          // The stream / polling fallback reports real problems.
        }
      };

      const startPolling = () => {
        if (s.pollTimer || s.stopped) return;
        s.pollTimer = setTimeout(poll, 0);
      };

      const open = async () => {
        let url: string;
        try {
          url = await streamUrl(runId, { lastEventId: runRef.current?.lastSeq ? String(runRef.current.lastSeq) : null });
        } catch {
          startPolling();
          return;
        }
        if (s.stopped) return;
        const es = new EventSource(url);
        s.es = es;
        es.onopen = () => {
          s.lastActivity = Date.now();
          dispatch({ kind: "connection", connection: "live" });
        };
        const handle = (type: string) => (ev: Event) => {
          const msg = ev as MessageEvent<string>;
          s.lastActivity = Date.now();
          let data: RunEvent;
          try {
            data = JSON.parse(msg.data);
          } catch {
            return;
          }
          if (!isRecord(data)) return;
          if (!data.type) (data as { type: string }).type = type;
          const seq = msg.lastEventId && /^\d+$/.test(msg.lastEventId) ? Number(msg.lastEventId) : null;
          dispatch({ kind: "event", event: data, seq });
          if (data.type === "result" || data.type === "job_failed") refreshSoon();
          if (data.type === "run_done") finish();
        };
        for (const type of EVENT_TYPES) es.addEventListener(type, handle(type));
        // Server heartbeat while agents work: proves the stream is alive, carries no state.
        es.addEventListener("ping", () => {
          s.lastActivity = Date.now();
        });
        es.onerror = () => {
          if (s.stopped || isFinished()) return;
          if (es.readyState === EventSource.CLOSED) {
            // Stream refused (expired token, server restart …): retry once with a fresh URL, then poll.
            s.es = null;
            if (!s.reopened) {
              s.reopened = true;
              dispatch({ kind: "connection", connection: "reconnecting" });
              later(open, 1000);
            }
            startPolling();
          } else {
            // Browser is auto-reconnecting (sends Last-Event-ID itself); poll meanwhile.
            dispatch({ kind: "connection", connection: "reconnecting" });
            startPolling();
          }
        };
      };

      // Watchdog: silent stream → poll. A slow run is flagged, never failed: the server decides.
      const watchdog = () => {
        if (isFinished()) return;
        const r = runRef.current;
        if (r && !r.overdue && Date.now() - r.startedAt > expectedRunMs(r)) dispatch({ kind: "overdue" });
        if (Date.now() - s.lastActivity > IDLE_MS) startPolling();
        later(watchdog, 5000);
      };

      void syncOnce();
      void open();
      later(watchdog, 5000);
    },
    [teardown],
  );

  /** Follow an existing run (e.g. one already in progress when the page opened). */
  const attach = useCallback(
    (runId: string, total = 0, startedAt?: string | null) => {
      setStartError(null);
      dispatch({ kind: "reset", state: initialRunState(runId, total, parseTime(startedAt) ?? Date.now()) });
      follow(runId);
    },
    [follow],
  );

  // One start request at a time: a double click must not send a second POST (whose 409 would
  // otherwise read as an error while the first run is starting fine).
  const inFlight = useRef(false);
  /** Runs started from this tab: only these are announced to Mochi (attaching to old runs stays silent). */
  const startedHere = useRef(new Set<string>());
  const [starting, setStarting] = useState(false);

  /** Follows this product's already-active run, if any; returns its id. */
  const attachActive = useCallback(async () => {
    if (!productId) return undefined;
    const runs = await api<RunSummary[]>(`/runs?product_id=${encodeURIComponent(productId)}&limit=1`);
    const active = runs.find((r) => isActiveRunStatus(r.status));
    if (!active) return undefined;
    if (runRef.current?.runId !== active.id) attach(active.id, active.total_jobs, active.started_at);
    return active.id;
  }, [productId, attach]);

  const start = useCallback(
    async (body?: { pincodes?: string[]; platforms?: string[] }) => {
      if (!productId || inFlight.current) return undefined;
      inFlight.current = true;
      setStarting(true);
      setStartError(null);
      try {
        const { run_id, total_jobs, estimated_credits } = await api<{ run_id: string; total_jobs?: number; estimated_credits: number }>(
          `/products/${productId}/runs`,
          { method: "POST", json: body ?? {} },
        );
        attach(run_id, total_jobs ?? estimated_credits ?? 0);
        startedHere.current.add(run_id);
        mochiEmit({ type: "run", phase: "start", runId: run_id, total: total_jobs ?? estimated_credits ?? 0 });
        return run_id;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // A run is already going (scheduler, another tab): follow it instead of erroring.
          const active = await attachActive().catch(() => undefined);
          if (active) return active;
        }
        setStartError(
          e instanceof ApiError && e.code === "credit_budget_exceeded"
            ? `${e.message} Try fewer pincodes, or upgrade your plan.`
            : errorMessage(e, "Could not start check"),
        );
        return undefined;
      } finally {
        inFlight.current = false;
        setStarting(false);
      }
    },
    [productId, attach, attachActive],
  );

  /** Stop following and clear the console. */
  const reset = useCallback(() => {
    teardown();
    setStartError(null);
    dispatch({ kind: "reset", state: null });
  }, [teardown]);

  const finished = !!run && (run.phase === "done" || run.phase === "failed" || run.phase === "error");
  useEffect(() => {
    if (!run || !finished || !startedHere.current.has(run.runId)) return;
    startedHere.current.delete(run.runId);
    mochiEmit({ type: "run", phase: run.phase === "done" ? "done" : "failed", runId: run.runId, total: run.total, failed: run.failed });
  }, [run, finished]);
  // Mid-run milestones (each once per run): first fresh result, halfway, first stock-out found.
  const milestones = useRef<{ runId: string; sent: Set<string> }>({ runId: "", sent: new Set() });
  useEffect(() => {
    if (!run || finished || !startedHere.current.has(run.runId)) return;
    if (milestones.current.runId !== run.runId) milestones.current = { runId: run.runId, sent: new Set() };
    const sent = milestones.current.sent;
    const ok = Math.max(0, run.completed - run.failed);
    const total = Math.max(run.total, run.completed);
    const emit = (milestone: "first" | "half" | "oos") => {
      sent.add(milestone);
      mochiEmit({ type: "run", phase: "progress", runId: run.runId, milestone, total, done: run.completed });
    };
    if (!sent.has("oos") && run.order.some((k) => run.jobs[k]?.phase === "done" && run.jobs[k]?.result?.in_stock === false)) emit("oos");
    else if (!sent.has("half") && total >= 4 && run.completed >= total / 2 && run.completed < total) emit("half");
    else if (!sent.has("first") && !sent.has("half") && ok >= 1 && total > 1) emit("first");
  }, [run, finished]);
  // Leaving the page stops following: tell Mochi so it doesn't wait for an end it will never hear.
  useEffect(() => {
    const started = startedHere.current;
    return () => {
      started.forEach((runId) => mochiEmit({ type: "run", phase: "detach", runId }));
      started.clear();
    };
  }, []);
  const progress: RunProgress | null = run && {
    runId: run.runId,
    done: Math.max(0, run.completed - run.failed),
    failed: run.failed,
    total: Math.max(run.total, run.completed),
    finished,
  };
  const error = startError ?? (run?.phase === "error" ? run.error : null);

  return { start, attach, attachActive, reset, run, progress, error, running: !!run && !finished, starting };
}

export type UseRun = ReturnType<typeof useRun>;
