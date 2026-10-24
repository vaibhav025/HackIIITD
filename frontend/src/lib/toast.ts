/** Minimal global toast store: `toast("Saved")`, `toast.error("Failed")`. Rendered by <Toaster>. */
import { mochiEmit } from "./mochi-bus";

export type ToastTone = "success" | "error" | "info";
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
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

function push(message: string, tone: ToastTone, ms = 3500) {
  const id = ++seq;
  toasts = [...toasts.slice(-3), { id, message, tone }];
  emit();
  mochiEmit({ type: "toast", tone, message });
  setTimeout(() => dismissToast(id), ms);
  return id;
}

export const toast = Object.assign((message: string) => push(message, "success"), {
  success: (message: string) => push(message, "success"),
  error: (message: string) => push(message, "error", 5000),
  info: (message: string) => push(message, "info"),
});

export function subscribeToasts(listener: Listener) {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
