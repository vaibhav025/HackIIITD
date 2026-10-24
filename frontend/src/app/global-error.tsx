"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary when the root layout itself fails: no globals.css or fonts are guaranteed,
 * so the Holst look is inlined.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f4f1de", color: "#0d1b2a", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
          <div
            role="alert"
            style={{
              maxWidth: 480,
              width: "100%",
              background: "#d4c4a8",
              border: "2px solid #0d1b2a",
              borderRadius: 20,
              boxShadow: "6px 6px 0 #0d1b2a",
              padding: 32,
              boxSizing: "border-box",
            }}
          >
            <h1 style={{ fontFamily: "Georgia, serif", fontSize: 32, lineHeight: "38px", margin: 0 }}>ShelfSense hit a snag</h1>
            <p style={{ fontSize: 16, lineHeight: "25px", marginTop: 12 }}>
              The app couldn&apos;t load. Your data is safe. Try again, or reload the page.
            </p>
            {error.digest && <p style={{ fontSize: 13, fontFamily: "monospace", opacity: 0.8 }}>Ref: {error.digest}</p>}
            <button
              type="button"
              // The root layout itself failed: reset() re-renders it in place, which rarely
              // recovers; a full reload refetches everything.
              onClick={() => {
                reset();
                window.location.reload();
              }}
              style={{
                marginTop: 16,
                background: "#0d1b2a",
                color: "#f4f1de",
                border: "2px solid #0d1b2a",
                borderRadius: 12,
                padding: "12px 22px",
                fontWeight: 600,
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
