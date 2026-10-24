/**
 * Tiny event bus so any part of the app can make Mochi (src/components/mochi) react, without
 * importing React code. Events are window CustomEvents named `mochi:<type>`; emitting never throws.
 */

export type MochiEvent =
  | { type: "toast"; tone: "success" | "error" | "info"; message: string }
  | { type: "run"; phase: "start" | "done" | "failed"; runId: string; total?: number; failed?: number }
  /** Mid-run milestones for runs started from this tab. */
  | { type: "run"; phase: "progress"; runId: string; milestone: "first" | "half" | "oos"; total?: number; done?: number }
  /** The page following the run unmounted: its end will never be reported. */
  | { type: "run"; phase: "detach"; runId: string }
  | { type: "rec"; verb: "approve" | "dismiss" | "send-telegram" | "done" | "reopen" }
  | { type: "say"; text: string; mood?: string }; // any page may make Mochi talk

export function mochiEmit(e: MochiEvent) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(`mochi:${e.type}`, { detail: e }));
  } catch {
    /* never break callers */
  }
}

export function onMochi<T extends MochiEvent["type"]>(type: T, fn: (e: Extract<MochiEvent, { type: T }>) => void) {
  const h = (ev: Event) => fn((ev as CustomEvent).detail);
  window.addEventListener(`mochi:${type}`, h);
  return () => window.removeEventListener(`mochi:${type}`, h);
}
