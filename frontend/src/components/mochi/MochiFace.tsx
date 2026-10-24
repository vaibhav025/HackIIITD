"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import {
  BODY_PATH,
  BROWS,
  C,
  EYE_BASE,
  EYE_L,
  EYE_R,
  FACES,
  HEART_PATH,
  INK,
  SPARKLE_PATH,
  STAR_PATH,
  type Expression,
  type Extra,
  type Face,
  type MouthKind,
  type TalkFrame,
} from "./expressions";
import { clamp, REDUCED_QUERY, useMedia } from "./store";

/**
 * Mochi's character: pure SVG, flat colours. Owns its blink scheduler, cursor tracking (refs + rAF,
 * no re-renders) and the expression "pop", all through WAAPI. Parts swap instantly, cartoon style;
 * the 160ms pop on the body masks the swap.
 */

export interface MochiFaceProps {
  expression: Expression;
  /** Talking mouth frame while the typewriter runs (null = not talking). */
  talk?: TalkFrame | null;
  size: number;
  /** Increment to play the wave gesture. */
  wave?: number;
  /** Screen angle (deg, 0 = right, 90 = down) from Mochi to what it points at. */
  pointAngle?: number | null;
  /** Allow cursor tracking in this placement. */
  track?: boolean;
  /** Increment to play a single hop (e.g. dim-area click). */
  hop?: number;
  className?: string;
  style?: CSSProperties;
}

const ROUND = { strokeLinecap: "round", strokeLinejoin: "round" } as const;
const POP: Keyframe[] = [{ transform: "scale(.96)" }, { transform: "scale(1.03)" }, { transform: "scale(1)" }];
const HOP: Keyframe[] = [
  { transform: "translateY(0) scale(1)" },
  { transform: "translateY(-8px) scale(1.03,.97)", offset: 0.4 },
  { transform: "translateY(0) scale(1)" },
];
const JUMP: Keyframe[] = [
  { transform: "translateY(0)" },
  { transform: "translateY(-12px)", offset: 0.12 },
  { transform: "translateY(0) scale(1.05,.94)", offset: 0.24 },
  { transform: "translateY(-14px)", offset: 0.38 },
  { transform: "translateY(0) scale(1.05,.94)", offset: 0.5 },
  { transform: "translateY(-16px)", offset: 0.66 },
  { transform: "translateY(0) scale(1.08,.88)", offset: 0.8 },
  { transform: "translateY(0) scale(.97,1.04)", offset: 0.9 },
  { transform: "translateY(0) scale(1)" },
];
const OUT = "cubic-bezier(.23,1,.32,1)";

function poseOf(face: Face): string {
  switch (face.body) {
    case "tilt-l":
    case "tilt-r":
      return `rotate(${face.tilt ?? 0}deg)`;
    case "droop":
      return "translateY(3px) scaleY(.97)";
    case "stretch":
      return "translateY(-6px) scaleY(1.06)";
    default:
      return "none";
  }
}

/** Arm rest directions (deg) and the rotation needed to point at `angle`, clamped ±70° from rest. */
function armRotation(angle: number, rest: number) {
  let d = angle - rest;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return clamp(d, -70, 70);
}

function Eyes({ face }: { face: Face }) {
  const s = face.eyeScale ?? 1;
  const glintR = face.glint ?? 2;
  const ellipseEye = (x: number, y: number, rx: number, ry: number, g = glintR, gx = 2, gy = -3, key = "") => (
    <g key={`${key}${x}`}>
      <ellipse cx={x} cy={y} rx={rx * s} ry={ry * s} fill={INK} />
      <circle cx={x + gx} cy={y + gy} r={g} fill="#fff" />
    </g>
  );
  switch (face.eyes) {
    case "open":
      return <>{[EYE_L, EYE_R].map((e) => ellipseEye(e.x, e.y, 6, 8))}</>;
    case "wide":
      return <>{[EYE_L, EYE_R].map((e) => ellipseEye(e.x, e.y, 7.5, 9.5, 2.6, 2.5, -3.5))}</>;
    case "up":
      return <>{[EYE_L, EYE_R].map((e) => ellipseEye(e.x, e.y, 6, 7.5))}</>;
    case "down":
      return <>{[EYE_L, EYE_R].map((e) => ellipseEye(e.x, e.y, 6, 7, 2.6))}</>;
    case "happy":
      return (
        <>
          <path d="M57 89 Q64 79 71 89" fill="none" stroke={INK} strokeWidth={3.5} {...ROUND} />
          <path d="M89 89 Q96 79 103 89" fill="none" stroke={INK} strokeWidth={3.5} {...ROUND} />
        </>
      );
    case "star":
      return (
        <>
          {[EYE_L, EYE_R].map((e) => (
            <g key={e.x} transform={`translate(${e.x} ${e.y})`}>
              <path d={STAR_PATH} fill={C.dot} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
              <circle cx={2} cy={-2} r={1.4} fill="#fff" />
            </g>
          ))}
        </>
      );
    case "heart":
      return (
        <>
          {[EYE_L, EYE_R].map((e) => (
            <g key={e.x} transform={`translate(${e.x} ${e.y}) scale(1.15)`}>
              <path d={HEART_PATH} fill={C.heart} />
              <circle cx={-3} cy={-4} r={1.3} fill="#fff" />
            </g>
          ))}
        </>
      );
    case "wink":
      return (
        <>
          {ellipseEye(EYE_L.x, EYE_L.y, 6, 8)}
          <path d="M89 88 Q96 81 103 88" fill="none" stroke={INK} strokeWidth={3.5} {...ROUND} />
        </>
      );
    case "sleepy":
      return (
        <>
          <path d="M58 86 A6 6 0 0 0 70 86 Z" fill={INK} />
          <path d="M90 86 A6 6 0 0 0 102 86 Z" fill={INK} />
          <path d="M56 86 L72 86" stroke={INK} strokeWidth={3} {...ROUND} />
          <path d="M88 86 L104 86" stroke={INK} strokeWidth={3} {...ROUND} />
        </>
      );
    case "curious":
      return (
        <>
          {ellipseEye(EYE_L.x, EYE_L.y, 6, 8)}
          {ellipseEye(EYE_R.x, EYE_R.y, 7, 9)}
        </>
      );
  }
}

function Mouth({ kind, talk }: { kind: MouthKind; talk: TalkFrame | null }) {
  const stroke = (d: string, w = 3) => <path d={d} fill="none" stroke={INK} strokeWidth={w} {...ROUND} />;
  if (talk === "A") return stroke("M74 105 Q80 109 86 105");
  if (talk === "B") return <ellipse cx={80} cy={106} rx={5} ry={3.5} fill={INK} />;
  if (talk === "C")
    return (
      <>
        <ellipse cx={80} cy={107} rx={6} ry={6} fill={INK} />
        <ellipse cx={80} cy={110.5} rx={3.5} ry={2} fill={C.cheek} />
      </>
    );
  switch (kind) {
    case "smile":
      return stroke("M72 104 Q80 111 88 104");
    case "grin":
      return (
        <>
          <path d="M70 102 Q80 118 90 102 Z" fill={INK} stroke={INK} strokeWidth={1.5} strokeLinejoin="round" />
          <path d="M75 109.5 Q80 113.5 85 109.5 Q80 107.5 75 109.5 Z" fill={C.cheek} />
        </>
      );
    case "o":
      return <ellipse cx={80} cy={108} rx={4.5} ry={5.5} fill={INK} />;
    case "hmm":
      return stroke("M74 106 Q80 108 87 104");
    case "frown":
      return stroke("M72 109 Q80 102 88 109");
    case "wavy":
      return stroke("M70 107 Q73.5 104 77 107 Q80.5 110 84 107 Q87.5 104 90 107", 2.5);
    case "cat":
      return stroke("M72 104 Q76 109 80 104 Q84 109 88 104");
    case "snore":
      return <ellipse cx={80} cy={107} rx={3} ry={2.5} fill={INK} />;
  }
}

const SPARKLES: [number, number, number][] = [
  [30, 56, 0.9],
  [134, 62, 1.1],
  [122, 30, 0.7],
];
const FRAUNCES: CSSProperties = { fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 700 };

function Extras({ list }: { list: Extra[] }) {
  return (
    <>
      {list.map((x) => {
        switch (x) {
          case "sparkles":
            return (
              <g key={x}>
                {SPARKLES.map(([sx, sy, sc], i) => (
                  <g key={i} transform={`translate(${sx} ${sy}) scale(${sc})`}>
                    <path className="m2-twinkle" style={{ animationDelay: `${i * 150}ms` }} d={SPARKLE_PATH} fill={C.dot} />
                  </g>
                ))}
              </g>
            );
          case "sparkle1":
            return (
              <g key={x} transform="translate(118 70) scale(.8)">
                <path className="m2-twinkle" d={SPARKLE_PATH} fill={C.dot} />
              </g>
            );
          case "dots":
            return (
              <g key={x}>
                {[
                  [112, 58, 2.5],
                  [121, 48, 3.5],
                  [132, 36, 5],
                ].map(([cx, cy, r], i) => (
                  <circle key={i} className="m2-dot" style={{ animationDelay: `${i * 300}ms` }} cx={cx} cy={cy} r={r} fill={C.linen} stroke={C.navy} strokeWidth={2} />
                ))}
              </g>
            );
          case "zzz":
            return (
              <g key={x} fill={C.slate} style={FRAUNCES}>
                <text className="m2-z" x={114} y={46} fontSize={12} style={{ animationDelay: "0ms" }}>z</text>
                <text className="m2-z" x={124} y={34} fontSize={15} style={{ animationDelay: "600ms" }}>z</text>
                <text className="m2-z" x={136} y={20} fontSize={18} style={{ animationDelay: "1200ms" }}>Z</text>
              </g>
            );
          case "sweat":
            return <path key={x} className="m2-sweat" d="M119 64 Q115 71 119 74 Q123 71 119 64 Z" fill={C.tear} />;
          case "tear":
            return <path key={x} className="m2-tear" d="M58 96 Q55 101 58 103 Q61 101 58 96 Z" fill={C.tear} />;
          case "bang":
            return (
              <g key={x} className="m2-bang" fill={C.navy}>
                <rect x={116} y={24} width={5} height={14} rx={2.5} />
                <circle cx={118.5} cy={44} r={2.6} />
              </g>
            );
          case "question":
            return (
              <text key={x} className="m2-q" x={118} y={42} fontSize={22} fill={C.slate} style={FRAUNCES}>
                ?
              </text>
            );
          case "hearts":
            return (
              <g key={x}>
                {[
                  [128, 50],
                  [34, 46],
                ].map(([hx, hy], i) => (
                  <g key={i} transform={`translate(${hx} ${hy}) scale(.55)`}>
                    <path className="m2-heartrise" style={{ animationDelay: `${i * 200}ms` }} d={HEART_PATH} fill={C.heart} />
                  </g>
                ))}
              </g>
            );
        }
      })}
    </>
  );
}

export default function MochiFace({ expression, talk = null, size, wave = 0, pointAngle = null, track = false, hop = 0, className, style }: MochiFaceProps) {
  const reduced = useMedia(REDUCED_QUERY);
  const face = FACES[expression];
  const talking = !!talk && expression !== "sleepy";

  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const leanRef = useRef<SVGGElement>(null);
  const trackRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const armRRef = useRef<SVGGElement>(null);

  const base = EYE_BASE[face.eyes] ?? { x: 0, y: 0 };

  // Expression change: pop, then the body's one-shot move (hop / double hop / jump).
  const first = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || reduced) return;
    if (first.current) {
      first.current = false;
    } else {
      el.animate(POP, { duration: 160, easing: OUT });
    }
    const kind = FACES[expression].body;
    if (kind === "hop" || kind === "hop2") el.animate(HOP, { duration: 420, delay: 140, iterations: kind === "hop2" ? 2 : 1, easing: OUT });
    if (kind === "jump") el.animate(JUMP, { duration: 1300, delay: 120, easing: "ease-in-out" });
  }, [expression, reduced]);

  useEffect(() => {
    if (!hop || reduced) return;
    bodyRef.current?.animate(HOP, { duration: 420, easing: OUT });
  }, [hop, reduced]);

  // Blink: self-scheduling, 2.5–6s, 20% double blink. Only while the tab is visible.
  useEffect(() => {
    if (!face.blink) return;
    let t = 0;
    const blinkOnce = () =>
      eyesRef.current?.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(.1)" }, { transform: "scaleY(1)" }], { duration: 140, easing: "ease-in-out" });
    const schedule = () => {
      t = window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          blinkOnce();
          if (Math.random() < 0.2) window.setTimeout(blinkOnce, 220);
        }
        schedule();
      }, 2500 + Math.random() * 3500);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [face.blink]);

  // Cursor tracking: eyes follow the pointer, the body leans in when it's close.
  const canTrack = track && face.track && !reduced;
  useEffect(() => {
    const g = trackRef.current;
    const lean = leanRef.current;
    if (!g) return;
    let cx = 0;
    let cy = 0;
    const reset = () => {
      g.setAttribute("transform", `translate(${base.x} ${base.y})`);
      if (lean) lean.style.transform = "";
    };
    if (!canTrack) {
      reset();
      return;
    }
    const ptr = { x: 0, y: 0, at: 0, window: 2000 };
    let raf = 0;
    let rot = 0;
    const loop = () => {
      raf = 0;
      const svg = svgRef.current;
      if (!svg || document.visibilityState !== "visible") return;
      const r = svg.getBoundingClientRect();
      const ox = r.left + r.width / 2;
      const oy = r.top + r.height * 0.55;
      const dx = ptr.x - ox;
      const dy = ptr.y - oy;
      const dist = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const d = clamp(dist / 220, 0, 1);
      const tx = Math.cos(a) * 3.2 * d;
      const ty = Math.sin(a) * 2.4 * d;
      cx += (tx - cx) * 0.18;
      cy += (ty - cy) * 0.18;
      g.setAttribute("transform", `translate(${(base.x + cx).toFixed(2)} ${(base.y + cy).toFixed(2)})`);
      const want = dist < 140 ? (dx > 0 ? 3 : -3) : 0;
      rot += (want - rot) * 0.18;
      if (lean) lean.style.transform = Math.abs(rot) < 0.05 ? "" : `rotate(${rot.toFixed(2)}deg)`;
      if (performance.now() - ptr.at < ptr.window || Math.abs(tx - cx) > 0.05) raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      ptr.at = performance.now();
      ptr.window = e.pointerType === "touch" ? 1500 : 2000;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") onMove(e);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      cancelAnimationFrame(raf);
      reset();
    };
  }, [canTrack, base.x, base.y]);

  // Wave: right arm swings.
  useEffect(() => {
    if (!wave || reduced) return;
    armRRef.current?.animate(
      [{ transform: "rotate(-20deg)" }, { transform: "rotate(-65deg)" }, { transform: "rotate(-25deg)" }, { transform: "rotate(-65deg)" }, { transform: "rotate(-20deg)" }],
      { duration: 900, easing: "ease-in-out" },
    );
  }, [wave, reduced]);

  // Point: the arm on the target's side rotates toward it.
  const pointRight = pointAngle != null && Math.cos((pointAngle * Math.PI) / 180) >= 0;
  const pointLeft = pointAngle != null && !pointRight;
  const armR = pointRight ? armRotation(pointAngle!, 70) : 0;
  const armL = pointLeft ? armRotation(pointAngle!, 110) : 0;
  const armStyle = (ox: number, deg: number): CSSProperties => ({
    transformBox: "view-box",
    transformOrigin: `${ox}px 104px`,
    transform: deg ? `rotate(${deg}deg)` : undefined,
    transition: "transform 220ms cubic-bezier(.23,1,.32,1)",
  });

  const antennaClass = talking
    ? "m2-ant m2-ant-bob"
    : face.antenna === "wiggle"
      ? `m2-ant m2-ant-wiggle${face.wiggleOnce ? "1" : ""}`
      : "m2-ant";
  const antennaStyle: CSSProperties = {
    transformBox: "view-box",
    transformOrigin: "80px 40px",
    transform: face.antenna === "droop" ? `rotate(${face.droop ?? 14}deg)` : undefined,
  };
  const perk = face.antenna === "perk";

  return (
    <svg
      ref={svgRef}
      className={`m2-face${className ? ` ${className}` : ""}`}
      data-expression={expression}
      viewBox="0 0 160 160"
      width={size}
      height={size}
      overflow="visible"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <ellipse className={face.body === "float" ? "m2-shadow m2-shadow-float" : "m2-shadow"} cx={80} cy={148} rx={30} ry={5} fill={C.navy} opacity={0.12} />
      <g ref={bodyRef} className={`m2-body m2-a-${face.body}`}>
        <g className="m2-pose" style={{ transformBox: "view-box", transformOrigin: "80px 135px", transform: poseOf(face) }}>
          <g ref={leanRef} className="m2-lean" style={{ transformBox: "view-box", transformOrigin: "80px 135px" }}>
            {/* Arms sit behind the body */}
            <g style={armStyle(34, armL)}>
              {pointLeft ? (
                <ellipse cx={31} cy={108} rx={6} ry={14} transform="rotate(20 31 108)" fill={C.arm} />
              ) : (
                <ellipse cx={31} cy={108} rx={7} ry={11} transform="rotate(20 31 108)" fill={C.arm} />
              )}
            </g>
            <g ref={armRRef} style={armStyle(126, armR)}>
              {pointRight ? (
                <ellipse cx={129} cy={108} rx={6} ry={14} transform="rotate(-20 129 108)" fill={C.arm} />
              ) : (
                <ellipse cx={129} cy={108} rx={7} ry={11} transform="rotate(-20 129 108)" fill={C.arm} />
              )}
            </g>

            <g className={antennaClass} style={antennaStyle}>
              <line
                x1={80}
                y1={40}
                x2={80}
                y2={24}
                stroke={C.stem}
                strokeWidth={3}
                strokeLinecap="round"
                style={perk ? { transformBox: "view-box", transformOrigin: "80px 40px", transform: "scaleY(1.15)" } : undefined}
              />
              {face.antenna === "heart" ? (
                <g transform="translate(80 20) scale(.85)">
                  <path d={HEART_PATH} fill={C.heart} />
                </g>
              ) : (
                <circle
                  className={face.antenna === "pulse" || talking ? "m2-pulse" : undefined}
                  cx={80}
                  cy={20}
                  r={6}
                  fill={face.dot ?? C.dot}
                  style={
                    perk
                      ? { transformBox: "fill-box", transformOrigin: "center", transform: "translateY(-2.4px) scale(1.3)" }
                      : face.antenna === "pulse" || talking
                        ? { transformBox: "fill-box", transformOrigin: "center" }
                        : undefined
                  }
                />
              )}
            </g>

            <path d={BODY_PATH} fill={C.mint} />

            {[50, 110].map((x) => (
              <ellipse
                key={x}
                cx={x}
                cy={102}
                rx={8}
                ry={5}
                fill={C.cheek}
                opacity={face.cheeks}
                style={{ transformBox: "fill-box", transformOrigin: "center", transform: face.cheekScale !== 1 ? `scale(${face.cheekScale})` : undefined }}
              />
            ))}

            <g ref={trackRef} transform={`translate(${base.x} ${base.y})`}>
              <g ref={eyesRef} className="m2-eyes" style={{ transformBox: "fill-box", transformOrigin: "center" }}>
                <Eyes face={face} />
              </g>
            </g>

            {face.brows && (
              <g fill="none" stroke={INK} strokeWidth={3} {...ROUND}>
                <path d={BROWS[face.brows][0]} />
                <path d={BROWS[face.brows][1]} />
              </g>
            )}

            <Mouth kind={face.mouth} talk={talking ? talk : null} />
          </g>
        </g>
      </g>
      <g key={expression} className="m2-extras">
        <Extras list={face.extras} />
      </g>
    </svg>
  );
}

/** Dialogue portrait: Mochi's current face in a 64px mint circle (44px on phones). */
export function MochiPortrait({ expression, talk, mobile }: { expression: Expression; talk?: TalkFrame | null; mobile?: boolean }) {
  const box = mobile ? 50 : 64;
  return (
    <div
      aria-hidden="true"
      style={{
        width: box,
        height: box,
        flex: "none",
        borderRadius: "9999px",
        background: C.portrait,
        border: `2px solid ${C.navy}`,
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      <MochiFace expression={expression} talk={talk} size={mobile ? 44 : 56} style={{ marginTop: 6 }} />
    </div>
  );
}
