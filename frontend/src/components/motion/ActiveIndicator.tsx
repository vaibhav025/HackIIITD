"use client";

import { LayoutGroup, motion } from "motion/react";
import { useId, type ReactNode } from "react";

/**
 * Sliding active-state background/underline shared by tabs, nav and filter pills.
 * Render it inside the *active* item only (item must be `relative`, its label
 * `relative z-[1]`); Motion's layoutId animates it between items with a transform.
 * Wrap each independent set of items in <IndicatorGroup> so two groups on one page
 * never steal each other's indicator.
 */
export default function ActiveIndicator({ id = "indicator", className }: { id?: string; className?: string }) {
  return (
    <motion.span
      aria-hidden
      layoutId={id}
      className={`absolute inset-0 z-0 pointer-events-none ${className ?? ""}`}
      transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.8 }}
    />
  );
}

export function IndicatorGroup({ children }: { children: ReactNode }) {
  return <LayoutGroup id={useId()}>{children}</LayoutGroup>;
}
