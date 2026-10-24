"use client";

import { duration } from "@/lib/format";
import type { AgentStep } from "@/lib/types";

const KIND_ICON: Record<string, string> = {
  session: "◎",
  navigate: "↗",
  location: "⌖",
  search: "⌕",
  open: "▤",
  extract: "≡",
  checkout: "₹",
  screenshot: "▣",
  done: "✓",
  error: "✕",
};

type StepState = "done" | "current" | "error";

function Marker({ state, kind }: { state: StepState; kind: string }) {
  if (state === "current") {
    return (
      <span className="grid place-items-center size-5 shrink-0 rounded-full bg-linen border-2 border-ink" aria-hidden>
        <span className="ss-spin size-3! border-[1.5px]!" />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="grid place-items-center size-5 shrink-0 rounded-full bg-linen border-2 border-dashed border-ink text-[10px] font-bold" aria-hidden>
        ✕
      </span>
    );
  }
  return (
    <span
      className={`grid place-items-center size-5 shrink-0 rounded-full border-2 border-ink text-[10px] font-bold ${kind === "done" ? "bg-sage text-ink" : "bg-ink text-linen"}`}
      aria-hidden
    >
      ✓
    </span>
  );
}

/**
 * Vertical step list for one agent session. The last step spins while the job is running; failed
 * jobs end on a dashed ✕. Each row says its state in text for screen readers, not just by icon.
 */
export default function StepTimeline({
  steps,
  running,
  failed,
  dense,
}: {
  steps: AgentStep[];
  running: boolean;
  failed: boolean;
  dense?: boolean;
}) {
  if (!steps.length) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink/75">
        {running ? (
          <>
            <span className="ss-spin size-3!" aria-hidden /> Waiting for the agent…
          </>
        ) : (
          "No step trace recorded for this check."
        )}
      </p>
    );
  }
  return (
    <ol className={`relative flex flex-col ${dense ? "gap-1" : "gap-1.5"}`}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const state: StepState = s.kind === "error" || (failed && last) ? "error" : running && last && s.kind !== "done" ? "current" : "done";
        return (
          <li key={s.index ?? i} className="ss-step-in relative flex gap-2.5 min-w-0">
            {!last && <span aria-hidden className="absolute left-[9px] top-5 -bottom-1.5 w-[2px] bg-ink/20" />}
            <Marker state={state} kind={s.kind} />
            <div className="min-w-0 flex-1 pb-0.5">
              <p className={`text-[13px] leading-5 ${state === "current" ? "font-semibold" : "font-medium"} ${state === "error" ? "text-ink" : ""}`}>
                <span className="sr-only">{state === "current" ? "In progress: " : state === "error" ? "Failed: " : "Done: "}</span>
                <span aria-hidden className="inline-block w-4 text-ink/60 text-center mr-1">
                  {KIND_ICON[s.kind] ?? "·"}
                </span>
                {s.label}
                {/* `ms` is time since the session started, not this step's own duration. */}
                {state !== "current" && s.ms > 0 && (
                  <span className="text-ink/60 font-normal tabular-nums" title="Time since the agent session started">
                    {" "}
                    · +{duration(s.ms)}
                  </span>
                )}
              </p>
              {s.detail && (
                <p className={`text-[12px] leading-[18px] text-ink/75 break-words ${s.kind === "session" ? "font-mono" : ""} pl-5`}>{s.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
