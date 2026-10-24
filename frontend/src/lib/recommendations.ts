import { mutate } from "swr";
import { api, ApiError, errorMessage } from "./api";
import { mochiEmit } from "./mochi-bus";
import { toast } from "./toast";
import type { DecisionResult } from "./types";

export type RecommendationVerb = "approve" | "dismiss" | "send-telegram" | "done" | "reopen";

/** POST a decision / action-list change for one recommendation. */
export function actOnRecommendation(id: string, verb: RecommendationVerb) {
  return api<DecisionResult>(`/recommendations/${encodeURIComponent(id)}/${verb}`, { method: "POST" }).then((res) => {
    mochiEmit({ type: "rec", verb });
    return res;
  });
}

/** Revalidate every action-list and dashboard view after a decision. */
export function refreshActionViews() {
  void mutate((key) => typeof key === "string" && (key.startsWith("/actions") || key === "/dashboard"));
}

/**
 * Shared error contract: `already_decided` means someone decided it elsewhere (e.g. Telegram) —
 * say so and refresh; anything else (guardrail_blocked, run conflicts, credit limits) is a real error.
 */
export function handleDecisionError(e: unknown, refresh?: () => void, fallback = "Couldn't update the recommendation") {
  if (e instanceof ApiError && e.code === "already_decided") {
    toast.info(e.message || "This recommendation was already decided");
    refresh?.();
    refreshActionViews();
  } else {
    toast.error(errorMessage(e, fallback));
  }
}

/** Toast for "Send to Telegram", matching what actually happened. */
export function toastTelegramResult(res: DecisionResult) {
  const message = res.message ?? "";
  if (res.telegram_status === "sent") toast.success(message);
  else if (res.telegram_status === "no_linked_chats") toast.info(message);
  else toast.error(message || "Nothing was sent to Telegram");
}
