import { isReduced } from "./store";

const COLORS = ["#9FE1CB", "#D4C4A8", "#FAC775", "#ED93B1", "#415A77"];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * 28 DOM particles bursting up from (x, y), then falling. WAAPI only, removed on finish.
 * No-op under reduced motion (the sparkles extra fades in place instead).
 */
export function confetti(x: number, y: number, zIndex = 1050) {
  if (typeof document === "undefined" || isReduced()) return;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("data-m2", "confetti");
  Object.assign(layer.style, { position: "fixed", left: "0", top: "0", width: "0", height: "0", zIndex: String(zIndex), pointerEvents: "none" });
  document.body.appendChild(layer);
  let left = 28;
  for (let i = 0; i < 28; i++) {
    const p = document.createElement("span");
    const round = Math.random() < 0.4;
    Object.assign(p.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: round ? "7px" : "6px",
      height: round ? "7px" : "10px",
      borderRadius: round ? "50%" : "1px",
      background: COLORS[i % COLORS.length],
      willChange: "transform, opacity",
    });
    layer.appendChild(p);
    const a = (rand(-160, -20) * Math.PI) / 180;
    const d = rand(80, 170);
    const dx = Math.cos(a) * d;
    const dy = Math.sin(a) * d;
    const fall = rand(40, 90);
    const rot = rand(180, 540) * (Math.random() < 0.5 ? -1 : 1);
    const anim = p.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${rot * 0.6}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + fall}px)) rotate(${rot}deg)`, opacity: 1, offset: 0.7 },
        { transform: `translate(calc(-50% + ${dx * 1.2}px), calc(-50% + ${dy + fall * 1.4}px)) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: rand(900, 1200), easing: "cubic-bezier(.23,1,.32,1)", fill: "forwards" },
    );
    anim.onfinish = () => {
      p.remove();
      if (--left === 0) layer.remove();
    };
  }
}
