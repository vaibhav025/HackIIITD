"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import PageTransition from "./PageTransition";
import Toaster from "./Toaster";

/** App-wide motion setup: OS reduced-motion respected by every Motion animation. */
export default function MotionProviders({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      {children}
      <PageTransition />
      <Toaster />
    </MotionConfig>
  );
}
