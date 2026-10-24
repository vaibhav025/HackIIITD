"use client";

import { useEffect, useState } from "react";

/** House easing: fast out, soft landing. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
/** Where pinning, tilt, magnetic and custom-cursor effects are allowed. */
export const FINE_POINTER_QUERY = "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

function useMedia(query: string, fallback = false) {
  const [matches, setMatches] = useState(fallback);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setMatches(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/** True on desktop with a mouse and motion allowed — gate for pin/tilt/magnetic effects. */
export function useFinePointer() {
  const fine = useMedia(FINE_POINTER_QUERY);
  const reduced = useMedia(REDUCED_QUERY, true);
  return fine && !reduced;
}

export const prefersReducedMotion = () =>
  typeof window === "undefined" || window.matchMedia(REDUCED_QUERY).matches;
