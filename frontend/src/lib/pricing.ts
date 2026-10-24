/**
 * Smart price-recommendation threshold, mirrored from backend/app/services/price_thresholds.py
 * so settings can preview exactly when ShelfSense will suggest a price change.
 */
import type { PriceSensitivity } from "./types";

export const SENSITIVITY_OPTIONS: { value: PriceSensitivity; label: string; pct: number; blurb: string }[] = [
  { value: "essential", label: "Essential", pct: 4, blurb: "Daily staples (milk, atta, eggs): shoppers notice small differences." },
  { value: "regular", label: "Regular", pct: 7, blurb: "Most packaged goods. A sensible default." },
  { value: "premium", label: "Premium", pct: 10, blurb: "Discretionary or branded treats: shoppers care less about a few rupees." },
];

/** Gaps under this many rupees never trigger a price suggestion. */
export const MIN_GAP_RUPEES = 2;
/** A gap must show up in this many checks in a row. */
export const MIN_CONSECUTIVE_RUNS = 2;

export function sensitivityPct(value: string | null | undefined): number {
  return (SENSITIVITY_OPTIONS.find((o) => o.value === value) ?? SENSITIVITY_OPTIONS[1]).pct;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** break_even = cost / (1 - commission); safe_floor = max(floor, break_even × (1 + margin)). */
export function priceBounds({
  cost,
  commission,
  margin,
  floor,
}: {
  cost: number | null | undefined;
  commission: number | null | undefined;
  margin: number | null | undefined;
  floor: number | null | undefined;
}): { breakEven: number | null; safeFloor: number | null } {
  const c = commission ?? 0;
  const breakEven = cost != null && c < 100 ? round2(cost / (1 - c / 100)) : null;
  const candidates: number[] = [];
  if (floor != null) candidates.push(floor);
  if (breakEven != null) candidates.push(breakEven * (1 + (margin ?? 0) / 100));
  return { breakEven, safeFloor: candidates.length ? round2(Math.max(...candidates)) : null };
}
