"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Weekly } from "@/lib/types";
import { rupees } from "@/lib/format";

// Holst is deliberately low-chroma, so rivals are told apart by dash pattern + direct labels,
// not hue. The seller is the one solid ink line.
const DASHES = ["6 4", "2 4", "10 4 2 4", "1 3"];

/** `YYYY-MM-DD` is a calendar day: parse it as local midnight (new Date("2024-05-01") is UTC and can shift a day). */
function parseDay(d: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
}

export default function WeeklyChart({ series }: { series: Weekly["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 640, H = 240, L = 44, R = 130, T = 14, B = 28;
  const entities = series.entities.slice(0, 5);
  const all = entities.flatMap((e) => e.prices).filter((v): v is number => v != null);
  if (!all.length || series.days.length < 2) return <p className="text-sm text-deep">Not enough history yet.</p>;
  const min = Math.floor(Math.min(...all) - 1);
  const max = Math.ceil(Math.max(...all) + 1);
  const x = (i: number) => L + (i / (series.days.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const ticks = [min, (min + max) / 2, max];
  const day = (d: string) => parseDay(d).toLocaleDateString("en-IN", { weekday: "short" });
  const last = series.days.length - 1;

  // Pointer (mouse, pen, touch) → nearest day column.
  function pick(e: PointerEvent<SVGSVGElement>) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((vx - L) / (W - L - R)) * last);
    setHover(Math.max(0, Math.min(last, i)));
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const cur = hover ?? last;
    const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: last }[e.key];
    if (e.key === "Escape") setHover(null);
    else if (next != null) {
      e.preventDefault();
      setHover(Math.max(0, Math.min(last, next)));
    }
  }
  let rival = 0;
  const styled = entities.map((e) => ({ ...e, dash: e.is_seller ? undefined : DASHES[rival++ % DASHES.length] }));

  // Spread end labels so they never collide.
  const ends = styled
    .map((e, i) => {
      const lastPrice = [...e.prices].reverse().find((v) => v != null);
      return { i, y: lastPrice == null ? null : y(lastPrice) };
    })
    .filter((e): e is { i: number; y: number } => e.y != null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  const labelY = new Map(ends.map((e) => [e.i, e.y]));

  return (
    <div>
      <div className="flex flex-wrap gap-4 mb-2 text-xs font-semibold" aria-label="Legend">
        {styled.map((e) => (
          <span key={`${e.name}-${e.platform}`} className="inline-flex items-center gap-1.5">
            <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke={e.is_seller ? "var(--ink)" : "var(--slate)"} strokeWidth={e.is_seller ? 3 : 2} strokeDasharray={e.dash} /></svg>
            {e.is_seller ? "You" : e.name}
          </span>
        ))}
      </div>
      <div
        className="relative rounded-[8px] outline-none focus-visible:ring-4 focus-visible:ring-slate/30"
        tabIndex={0}
        role="group"
        aria-label="Average price over the last 7 days. Use the left and right arrow keys to read each day."
        onKeyDown={onKey}
        onFocus={() => setHover((h) => h ?? last)}
        onBlur={() => setHover(null)}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto touch-pan-y"
          aria-hidden
          onPointerDown={pick}
          onPointerMove={pick}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--ink)" strokeOpacity={0.1} />
              <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--deep)">₹{t.toFixed(0)}</text>
            </g>
          ))}
          {series.days.map((d, i) => (
            <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--deep)">{day(d)}</text>
          ))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--ink)" strokeOpacity={0.35} />}
          {styled.map((e, idx) => {
            const pts = e.prices.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
            const ly = labelY.get(idx);
            return (
              <g key={`${e.name}-${e.platform}`}>
                <polyline points={pts} fill="none" stroke={e.is_seller ? "var(--ink)" : "var(--slate)"} strokeWidth={e.is_seller ? 3 : 2} strokeDasharray={e.dash} strokeLinejoin="round" strokeLinecap="round" />
                {hover != null && e.prices[hover] != null && (
                  <circle cx={x(hover)} cy={y(e.prices[hover]!)} r={4.5} fill={e.is_seller ? "var(--ink)" : "var(--slate)"} stroke="#fff" strokeWidth={2} />
                )}
                {ly != null && (
                  <text x={W - R + 8} y={ly + 4} fontSize={11} fontWeight={e.is_seller ? 800 : 600} fill="var(--ink)">
                    {(e.is_seller ? "You" : e.name).slice(0, 18)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover != null && (
          <div
            className="absolute top-2 pointer-events-none bg-white border-2 border-ink rounded-lg shadow-[3px_3px_0_var(--ink)] p-2 text-xs z-10"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > series.days.length / 2 ? "-110%" : "10%"})` }}
          >
            <p className="font-bold mb-1">{parseDay(series.days[hover]).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</p>
            {styled.map((e) => (
              <p key={`${e.name}-${e.platform}`} className="flex justify-between gap-4">
                <span>{e.is_seller ? "You" : e.name}</span>
                <b>{rupees(e.prices[hover], 2)}</b>
              </p>
            ))}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {hover != null &&
            `${parseDay(series.days[hover]).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}: ${styled
              .map((e) => `${e.is_seller ? "You" : e.name} ${rupees(e.prices[hover], 2)}`)
              .join(", ")}`}
        </p>
      </div>
    </div>
  );
}
