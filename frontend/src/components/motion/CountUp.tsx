"use client";

import { animate, useInView } from "motion/react";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";

const plain = (n: number) => Math.round(n).toLocaleString("en-IN");

/**
 * Counts up once when it first scrolls into view (1.2s), then animates from the
 * current number to any new `value` (e.g. a platform switch). Tabular numbers, and
 * an invisible copy of the final text reserves the width so nothing shifts.
 */
export default function CountUp({
  value,
  format = plain,
  duration = 1.2,
  from = 0,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  from?: number;
  className?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const current = useRef(from);
  const inView = useInView(box, { once: true, amount: 0.4 });
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    if (!inView || !text.current) return;
    const el = text.current;
    if (prefersReducedMotion()) {
      current.current = value;
      el.textContent = formatRef.current(value);
      return;
    }
    const controls = animate(current.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (n) => {
        current.current = n;
        el.textContent = formatRef.current(n);
      },
    });
    return () => controls.stop();
  }, [inView, value, duration]);

  return (
    <span ref={box} className={`inline-grid tabular-nums ${className ?? ""}`}>
      <span aria-hidden className="invisible [grid-area:1/1]">
        {format(value)}
      </span>
      <span ref={text} className="[grid-area:1/1]" aria-label={format(value)}>
        {format(from)}
      </span>
    </span>
  );
}
