"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { duration, formatDateTime } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import type { CheckResultDetail, RunDetail } from "@/lib/types";
import { jobKeyOf } from "@/lib/useRun";
import { ModeBadge, ScreenshotThumb, TruePriceBreakdown } from "./parts";
import StepTimeline from "./StepTimeline";

/**
 * Finds the CheckResult behind a pin-detail row: by `result_id` when the API gives it, otherwise
 * by matching platform/pincode/competitor in that run's results.
 */
function useResultId(opts: { resultId?: string | null; runId?: string | null; platform: string; pincode: string; competitorId?: string | null }) {
  const { resultId, runId, platform, pincode, competitorId = null } = opts;
  const run = useApi<RunDetail>(!resultId && runId ? `/runs/${encodeURIComponent(runId)}` : null);
  if (resultId) return { id: resultId, loading: false };
  if (!runId) return { id: null, loading: false };
  const key = jobKeyOf({ platform, pincode, competitor_id: competitorId });
  const hit = run.data?.results?.find((r) => (r.job_key || jobKeyOf(r)) === key);
  return { id: hit?.id ?? null, loading: !run.data && !run.error };
}

/** "Agent replay" for one check: the recorded TinyFish steps, true price and evidence. */
export default function AgentReplay(props: {
  resultId?: string | null;
  runId?: string | null;
  platform: string;
  pincode: string;
  competitorId?: string | null;
  title?: string;
}) {
  const { id, loading } = useResultId(props);
  const detail = useApi<CheckResultDetail>(id ? `/check-results/${encodeURIComponent(id)}` : null);
  const steps = detail.data?.agent?.steps ?? [];
  const [shown, setShown] = useState(Number.POSITIVE_INFINITY);
  const [playing, setPlaying] = useState(false);

  // Replay: reveal recorded steps one by one (≈ 350 ms each). Reduced motion shows them all.
  useEffect(() => {
    if (!playing) return;
    if (prefersReducedMotion()) {
      setShown(Number.POSITIVE_INFINITY);
      setPlaying(false);
      return;
    }
    let n = 0;
    setShown(0);
    const t = setInterval(() => {
      n++;
      setShown(n);
      if (n >= steps.length) {
        clearInterval(t);
        setPlaying(false);
      }
    }, 350);
    return () => clearInterval(t);
  }, [playing, steps.length]);

  if (!id) {
    if (loading) return <div className="skeleton h-24" />;
    return <p className="text-[13px] text-ink/75">No agent trace for this check.</p>;
  }
  if (detail.error) return <p className="text-[13px] text-ink/75">Agent trace unavailable ({detail.error instanceof Error ? detail.error.message : "error"}).</p>;
  if (!detail.data) return <div className="skeleton h-24" />;

  const d = detail.data;
  const agent = d.agent;
  const visible = steps.slice(0, shown);
  const failed = d.status === "failed" || steps[steps.length - 1]?.kind === "error";
  // Step `ms` is cumulative from the session start: the last step holds the duration.
  const total = steps[steps.length - 1]?.ms ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label text-ink!">{props.title ?? "Agent replay"}</p>
        <div className="flex items-center gap-2">
          {agent?.mode && <ModeBadge mode={agent.mode} className="text-[10px]! px-2! py-0!" />}
          {steps.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm py-1! px-3! text-[12px]!" onClick={() => setPlaying(true)} disabled={playing}>
              {playing ? "Replaying…" : "▶ Replay"}
            </button>
          )}
        </div>
      </div>
      {agent?.goal && <p className="text-[12px] leading-[18px] text-ink/75">Goal: {agent.goal}</p>}
      {!agent ? (
        <p className="text-[13px] text-ink/75">This check was recorded before agent traces were kept.</p>
      ) : (
        <StepTimeline steps={visible} running={playing} failed={!playing && failed} dense />
      )}
      <p className="text-[12px] text-ink/70">
        {agent?.session_id && <span className="font-mono">{agent.session_id} · </span>}
        {total ? `${duration(total)} · ` : ""}
        {formatDateTime(d.checked_at)}
      </p>
      {!playing && agent?.true_price && <TruePriceBreakdown price={agent.true_price} compact />}
      {!playing && d.screenshot_url && <ScreenshotThumb url={d.screenshot_url} alt={`Evidence · ${props.pincode}`} className="max-w-[280px]" />}
    </div>
  );
}

