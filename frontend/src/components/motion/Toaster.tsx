"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type Toast } from "@/lib/toast";
import { EASE } from "@/lib/motion";

const TONE: Record<Toast["tone"], { cls: string; icon: string }> = {
  success: { cls: "bg-sage text-ink", icon: "✓" },
  error: { cls: "bg-sand text-ink", icon: "!" },
  info: { cls: "bg-ink text-linen", icon: "i" },
};

/** Bottom-right toast stack; new toasts slide up, dismissed ones slide out right. */
export default function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return (
    <div data-toaster aria-live="polite" className="fixed bottom-4 right-4 left-4 sm:left-auto z-[2500] flex flex-col items-end gap-3 pointer-events-none">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.28, ease: EASE }}
            className={`pointer-events-auto w-full sm:w-auto sm:max-w-sm flex items-start gap-3 border-2 border-ink rounded-[14px] shadow-[4px_4px_0_var(--ink)] px-4 py-3 ${TONE[t.tone].cls}`}
            role={t.tone === "error" ? "alert" : "status"}
          >
            <span className="grid place-items-center size-6 shrink-0 rounded-full border-2 border-ink bg-linen text-ink text-[13px] font-bold">{TONE[t.tone].icon}</span>
            <p className="text-[15px] font-semibold leading-[22px] flex-1">{t.message}</p>
            <button className="text-lg leading-none font-bold opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
