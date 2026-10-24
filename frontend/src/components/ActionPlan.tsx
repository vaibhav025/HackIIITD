"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/api";
import { rupees, timeAgo } from "@/lib/format";
import { actOnRecommendation, handleDecisionError, refreshActionViews } from "@/lib/recommendations";
import { toast } from "@/lib/toast";
import type { ActionItem, ActionList } from "@/lib/types";
import { CardSkeleton, Empty, ErrorCard } from "./ui";

/**
 * The seller's action plan: approved recommendations stay open here until marked done.
 * ShelfSense only reads marketplaces, so price moves are listed as "set this in your seller panel".
 */
export default function ActionPlan({ productId, showProduct = false }: { productId?: string; showProduct?: boolean }) {
  const actions = useApi<ActionList>(`/actions${productId ? `?product_id=${encodeURIComponent(productId)}` : ""}`);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(item: ActionItem, verb: "done" | "reopen") {
    if (busy) return;
    setBusy(item.id);
    try {
      const res = await actOnRecommendation(item.id, verb);
      toast(res.message ?? (verb === "done" ? "Marked done" : "Reopened"));
      refreshActionViews();
    } catch (e) {
      handleDecisionError(e, () => actions.mutate(), "Couldn't update the action");
    } finally {
      setBusy(null);
    }
  }

  if (actions.error && !actions.data) return <ErrorCard error={actions.error} onRetry={() => actions.mutate()} />;
  if (!actions.data) return <CardSkeleton />;
  const { open, done } = actions.data;

  return (
    <div className="flex flex-col gap-4">
      {open.length === 0 ? (
        <Empty title="No open actions">Approve a recommendation and it lands here until you mark it done.</Empty>
      ) : (
        <ul className="flex flex-col gap-4 stagger">
          {open.map((item) => (
            <li key={item.id} className="card p-[22px] flex flex-wrap items-start gap-4">
              <div className="flex-1 min-w-[220px] flex flex-col gap-1">
                {item.kind === "margin_risk" && (
                  <span className="chip bg-sand self-start">
                    <span aria-hidden>✋</span> Don&apos;t price-match
                  </span>
                )}
                <p className="font-semibold text-[17px] leading-[25px]">{item.action_item}</p>
                {item.kind === "margin_risk" && typeof item.evidence?.safe_floor === "number" && (
                  <p className="text-[14px] text-ink/80">
                    Keep your price at or above {rupees(item.evidence.safe_floor, 2)} and compete on stock, delivery, or a bundle, then mark this done.
                  </p>
                )}
                {item.kind === "price" && item.target_price != null && (
                  <p className="text-[14px] text-ink/80">
                    ShelfSense can&apos;t change marketplace prices. Set {rupees(item.target_price, 2)} in your seller panel, then mark this done.
                  </p>
                )}
                <p className="text-[13px] text-ink/70">
                  {showProduct && item.product_name ? (
                    <>
                      <Link href={`/products/${item.product_id}`} className="font-semibold text-slate hover:underline underline-offset-2">
                        {item.product_name}
                      </Link>
                      {" · "}
                    </>
                  ) : null}
                  {item.decided_via === "auto" ? "Auto-approved" : item.decided_via === "telegram" ? "Approved in Telegram" : "Approved"} {timeAgo(item.decided_at ?? item.created_at)}
                </p>
              </div>
              <button className="btn btn-primary btn-sm" disabled={busy === item.id} onClick={() => toggle(item, "done")}>
                {busy === item.id ? "Saving…" : "Mark done"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[14px] font-semibold text-slate select-none">
            Recently done ({done.length})
          </summary>
          <ul className="flex flex-col pt-2">
            {done.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 border-b border-ink/15 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium line-through decoration-ink/40">{item.action_item}</p>
                  <p className="text-[13px] text-ink/70">
                    {showProduct && item.product_name ? `${item.product_name} · ` : ""}
                    Done {timeAgo(item.done_at ?? item.decided_at ?? item.created_at)}
                  </p>
                </div>
                {item.effect === "run_started" && item.run_id ? (
                  <Link href={`/agents?run=${encodeURIComponent(item.run_id)}`} className="font-semibold text-[14px] hover:underline whitespace-nowrap">
                    View run →
                  </Link>
                ) : (
                  <button className="btn btn-ghost btn-sm" disabled={busy === item.id} onClick={() => toggle(item, "reopen")}>
                    {busy === item.id ? "Saving…" : "Reopen"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
