"use client";

import { animate } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { EASE, prefersReducedMotion } from "@/lib/motion";

const FINISH_MS = 220;
/** Never leave the bar hanging if a route is slow or the navigation is abandoned. */
const GIVE_UP_MS = 8000;

/**
 * Route progress: a thin Slate Blue bar along the top edge while the next route loads.
 * Clicks are never intercepted — Next's <Link> navigates immediately and the bar just runs
 * alongside, so a click can't look dead and the new page is never hidden. Modified clicks,
 * new tabs, downloads, hash links and same-path links are ignored. Reduced motion: no bar.
 * Only transform and opacity are animated.
 */
export default function PageTransition() {
  const pathname = usePathname();
  const bar = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = () => {
    const el = bar.current;
    if (!el || !pending.current) return;
    pending.current = false;
    if (giveUp.current) clearTimeout(giveUp.current);
    animate(el, { transform: "scaleX(1)" }, { duration: FINISH_MS / 1000, ease: EASE })
      .then(() => animate(el, { opacity: 0 }, { duration: 0.2 }))
      .then(() => {
        if (pending.current) return;
        el.style.transform = "scaleX(0)";
      });
  };

  // New route rendered: complete and fade the bar.
  useEffect(() => {
    finish();
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (prefersReducedMotion()) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.dataset.noTransition !== undefined) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      const el = bar.current;
      if (!el) return;
      // Nothing is prevented here: the click carries on to Next's <Link> (or the browser).
      pending.current = true;
      el.style.opacity = "1";
      el.style.transform = "scaleX(0)";
      animate(el, { transform: ["scaleX(0)", "scaleX(0.3)", "scaleX(0.8)"] }, { duration: 2.4, times: [0, 0.15, 1], ease: "easeOut" });
      if (giveUp.current) clearTimeout(giveUp.current);
      giveUp.current = setTimeout(finish, GIVE_UP_MS);
    };
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("click", onClick, true);
      if (giveUp.current) clearTimeout(giveUp.current);
    };
  }, []);

  return (
    <div
      ref={bar}
      aria-hidden
      className="fixed top-0 left-0 right-0 h-[3px] z-[3000] bg-slate pointer-events-none origin-left"
      style={{ transform: "scaleX(0)", opacity: 0 }}
    />
  );
}
