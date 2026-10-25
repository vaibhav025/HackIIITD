/** Minimal global toast store: `toast("Saved")`, `toast.error("Failed")`. Rendered by <Toaster>. */
import { mochiEmit } from "./mochi-bus";

export type ToastTone = "success" | "error" | "info";
export interface ToastExtras {
  /** Second, smaller line under the message. */
  detail?: string;
  /** In-app link shown on the toast (e.g. "Link Telegram"). */
  action?: { label: string; href: string };
  /** How long it stays up, in ms. */
  ms?: number;
}
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  detail?: string;
  action?: { label: string; href: string };
}

type Listener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(toasts));

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(message: string, tone: ToastTone, ms = 3500, extras: ToastExtras = {}) {
  const id = ++seq;
  toasts = [...toasts.slice(-3), { id, message, tone, detail: extras.detail, action: extras.action }];
  emit();
  mochiEmit({ type: "toast", tone, message });
  setTimeout(() => dismissToast(id), ms);
  return id;
}

export const toast = Object.assign((message: string) => push(message, "success"), {
  success: (message: string) => push(message, "success"),
  error: (message: string) => push(message, "error", 5000),
  info: (message: string) => push(message, "info"),
  /** Urgent, longer-lived error toast with an optional detail line and link (stock-outs). */
  alert: (message: string, extras: ToastExtras = {}) => push(message, "error", extras.ms ?? 9000, extras),
});

export function subscribeToasts(listener: Listener) {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
