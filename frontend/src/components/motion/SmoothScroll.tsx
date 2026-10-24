"use client";

import "lenis/dist/lenis.css";
import Lenis from "lenis";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { REDUCED_QUERY } from "@/lib/motion";

const LenisContext = createContext<Lenis | null>(null);

/** The active Lenis instance, or null when smooth scrolling is off (reduced motion / SSR / not mounted). */
export const useLenis = () => useContext(LenisContext);

/**
 * Opt-in Lenis smooth scrolling for long marketing pages (wrap the page content in it). Not mounted
 * app-wide: the product app has many nested scrollers (tables, chat log, maps, dialogs) where native
 * scrolling is better. Skipped for reduced motion and torn down if that preference changes.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  const [lenis, setLenis] = useState<Lenis | null>(null);

  useEffect(() => {
    const media = window.matchMedia(REDUCED_QUERY);
    let instance: Lenis | null = null;

    const start = () => {
      instance = new Lenis({
        autoRaf: true,
        lerp: 0.1,
        // Inner scrollers keep their own scroll.
        allowNestedScroll: true,
        // In-page links glide and honour each target's CSS scroll-margin-top.
        anchors: true,
      });
      setLenis(instance);
    };
    const stop = () => {
      instance?.destroy();
      instance = null;
      setLenis(null);
    };

    const sync = () => (media.matches ? stop() : !instance && start());
    sync();
    media.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      stop();
    };
  }, []);

  return <LenisContext.Provider value={lenis}>{children}</LenisContext.Provider>;
}
