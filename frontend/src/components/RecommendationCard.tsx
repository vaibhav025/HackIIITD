"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useState } from "react";
import { actOnRecommendation, handleDecisionError, refreshActionViews, toastTelegramResult } from "@/lib/recommendations";
import { rupees } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { DecisionResult, Recommendation } from "@/lib/types";
import { PriorityBadge } from "./ui";

/**
 * Human-in-the-loop action card (dashboard "Recommended actions" pattern):
 * linen card, 18px semibold action, 16px impact line, slate Approve, linen Dismiss,
 * sand Send to Telegram (heatmap AI-card button). Nothing changes until the seller approves;
 * approving starts a re-check or adds the item to the action plan (the backend says which).
 */
export default function RecommendationCard({
  rec,
  productName,
  onChange,
  onApproved,
}: {
  rec: Recommendation;
  productName?: string | null;
  onChange?: () => void;
  /** Called with the approval result, e.g. to follow a re-check run that just started. */
  onApproved?: (res: DecisionResult) => void;
}) {
  const [status, setStatus] = useState(rec.status ?? "pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; runId?: string | null } | null>(null);

  async function act(kind: "approve" | "dismiss" | "send-telegram") {
    if (busy) return;
    setBusy(kind);
    setNote(null);
    try {
      const res = await actOnRecommendation(rec.id, kind);
      if (kind === "send-telegram") {
        setNote({ text: res.message ?? "" });
        toastTelegramResult(res);
        return;
      }
      setStatus(res.status);
      if (kind === "approve") {
        toast(res.message ?? "Approved");
        setNote({ text: res.message ?? "Approved", runId: res.effect === "run_started" ? res.run_id : null });
        onApproved?.(res);
      } else {
        toast(res.message ?? "Recommendation dismissed");
      }
      refreshActionViews();
      onChange?.();
    } catch (e) {
      handleDecisionError(e, onChange);
    } finally {
      setBusy(null);
    }
  }

  const decided = status !== "pending";
  const evidence = rec.evidence ?? {};
  const marginRisk = evidence.kind === "margin_risk";
  const safeFloor = typeof evidence.safe_floor === "number" ? evidence.safe_floor : null;
  const chip = status === "dismissed" ? "Dismissed" : status === "done" ? "✓ Started" : "✓ Approved";
  return (
    <div className={`card p-[26px] flex flex-col gap-5 transition-opacity ${decided ? "bg-linen border-dashed shadow-none" : ""}`}>
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <PriorityBadge priority={rec.priority} />
          {marginRisk && (
            <span className="chip bg-sand" title="Matching the rival would put you below your safe floor">
              <span aria-hidden>✋</span> Don&apos;t price-match
            </span>
          )}
          {productName && (
            <Link href={`/products/${rec.product_id}`} className="text-[13px] font-semibold text-slate hover:underline underline-offset-2">
              {productName}
            </Link>
          )}
          {decided && <span className={`chip ml-auto ${status === "dismissed" ? "bg-linen" : "bg-sage"}`}>{chip}</span>}
        </div>
        <p className="font-semibold text-[18px] leading-[27px]">{rec.action_text}</p>
        <p className="text-[16px] leading-6 text-ink/80">{rec.impact_text}</p>
        {marginRisk && safeFloor != null && !decided && (
          <p className="text-[14px] leading-5 text-ink/80">
            Approving adds a reminder to hold your price at or above {rupees(safeFloor, 2)}; it never changes your price.
          </p>
        )}
      </div>
      {!decided && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => act("approve")}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => act("dismiss")}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
          <button className="btn btn-sand px-[18px] text-[15px]" disabled={!!busy} onClick={() => act("send-telegram")}>
            <img src="/figma/heatmaps/imgContainer14.svg" alt="" width={16} height={13} />
            {busy === "send-telegram" ? "Sending…" : "Send to Telegram"}
          </button>
        </div>
      )}
      {note && (
        <p className="text-[14px] font-semibold border-t border-ink/20 pt-3" role="status">
          {note.text}
          {note.runId && (
            <>
              {" "}
              <Link href={`/agents?run=${encodeURIComponent(note.runId)}`} className="underline underline-offset-2">
                Watch the run →
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
