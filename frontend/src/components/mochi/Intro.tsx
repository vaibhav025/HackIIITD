"use client";

import { animate } from "motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScrollLock } from "@/lib/a11y";
import Dialogue, { useTypewriter } from "./Dialogue";
import type { Expression } from "./expressions";
import MochiFace from "./MochiFace";
import { INTRO, INTRO_EXPLAIN, INTRO_OUTRO, type IntroBeat } from "./script";
import { dockPosition, getPrefs, usePrefs } from "./store";

/**
 * The first-visit "game intro": dim backdrop, a big Mochi rising onto a JRPG text box, a few
 * beats (name, goal), then a spring flight into the corner (or to the tour).
 */

export type IntroResult = { goal: "tour" | "solo" | "skipped"; name: string | null };

type Pos = { kind: "intro"; i: number } | { kind: "explain"; i: number } | { kind: "outro"; which: "tour" | "solo" };

const GOAL_INDEX = INTRO.findIndex((b) => b.id === "goal");

export default function Intro({
  reduced,
  mobile,
  voice,
  onDone,
}: {
  reduced: boolean;
  mobile: boolean;
  voice: boolean;
  onDone: (r: IntroResult) => void;
}) {
  const [pos, setPos] = useState<Pos>({ kind: "intro", i: 0 });
  const [name, setName] = useState<string | null>(getPrefs().name);
  const [ready, setReady] = useState(false);
  const [wave, setWave] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [flying, setFlying] = useState(false);
  const [boxH, setBoxH] = useState(180);

  const boxRef = useRef<HTMLDivElement>(null);
  const mochiRef = useRef<HTMLDivElement>(null);
  const riseRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  useScrollLock(true);

  const beat: IntroBeat | { mood: Expression; text: string } =
    pos.kind === "intro" ? INTRO[pos.i] : pos.kind === "explain" ? INTRO_EXPLAIN[pos.i] : INTRO_OUTRO[pos.which];
  const text = typeof beat.text === "function" ? beat.text(name) : beat.text;
  const lineKey = pos.kind === "intro" ? `i${pos.i}` : pos.kind === "explain" ? `e${pos.i}` : `o${pos.which}`;
  const speech = usePrefs().speech;
  // Spoken too; before the first tap the line waits (Dialogue shows "Tap to hear Mochi").
  const tw = useTypewriter(text, lineKey, { reduced, voice, paused: !ready || exiting, speak: { on: speech, mood: beat.mood } });
  const intro = pos.kind === "intro" ? INTRO[pos.i] : null;
  const expression: Expression = flying ? "happy" : beat.mood;
  const size = mobile ? 120 : 160;

  // Box height keeps Mochi's feet on the box's top edge.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const sync = () => setBoxH(el.offsetHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Entrance: Mochi springs up from below the box, lands with a squash, waves; typing follows.
  useEffect(() => {
    const el = riseRef.current;
    if (!el) return;
    if (reduced) {
      const t = window.setTimeout(() => setReady(true), 150);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    let t = 0;
    const controls = animate(el, { transform: ["translateY(140%)", "translateY(0%)"] }, { type: "spring", duration: 0.65, bounce: 0.35 });
    controls.then(() => {
      if (cancelled) return;
      el.animate([{ transform: "scale(1.08,.88)" }, { transform: "scale(1)" }], { duration: 140, easing: "cubic-bezier(.23,1,.32,1)" });
      setWave((w) => w + 1);
      t = window.setTimeout(() => !cancelled && setReady(true), 150);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      controls.stop();
    };
  }, [reduced]);

  const finish = (goal: IntroResult["goal"], who: string | null = name) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setExiting(true);
    const el = mochiRef.current;
    if (!el || reduced) {
      window.setTimeout(() => onDone({ goal, name: who }), 160);
      return;
    }
    // FLIP flight from the stage to the dock (or to the first tour spot).
    const from = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const to =
      goal === "tour"
        ? { x: vw - (mobile ? 64 : 88) - 32, y: vh * 0.38, S: mobile ? 64 : 88 }
        : dockPosition(getPrefs(), mobile);
    const s = to.S / from.width;
    setFlying(true);
    el.style.transformOrigin = "0 0";
    animate(
      el,
      { transform: ["translate(0px, 0px) scale(1)", `translate(${to.x - from.left}px, ${to.y - from.top}px) scale(${s})`] },
      { type: "spring", duration: 0.7, bounce: 0.2 },
    ).then(() => onDone({ goal, name: who }));
  };

  const next = () => {
    if (exiting) return;
    if (pos.kind === "outro") return finish(pos.which);
    if (pos.kind === "explain") {
      if (pos.i + 1 < INTRO_EXPLAIN.length) setPos({ kind: "explain", i: pos.i + 1 });
      else setPos({ kind: "intro", i: GOAL_INDEX });
      return;
    }
    if (pos.i + 1 < INTRO.length) setPos({ kind: "intro", i: pos.i + 1 });
  };

  // The outro line leaves on its own shortly after it finishes typing (and Mochi finishes saying it).
  useEffect(() => {
    if (pos.kind !== "outro" || !tw.done || tw.speaking || !ready) return;
    const t = window.setTimeout(() => finish(pos.which), 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, tw.done, tw.speaking, ready]);

  const choose = (id: string) => {
    if (id === "explain") setPos({ kind: "explain", i: 0 });
    else if (id === "tour" || id === "solo") setPos({ kind: "outro", which: id });
  };

  const onBackdrop = () => {
    if (!tw.done) tw.finish();
    else if (!intro?.choices && !intro?.input) next();
  };

  const fade = reduced ? "opacity 150ms ease-out" : undefined;
  const sheetPlace = mobile
    ? { left: 0, right: 0, bottom: 0 }
    : // Centred with margins, not a transform: the enter animation owns `transform`.
      { left: 0, right: 0, marginLeft: "auto", marginRight: "auto", bottom: 32, width: "min(640px, calc(100vw - 32px))" };
  const mochiBottom = (mobile ? 0 : 32) + boxH - 18;

  return (
    <div className="m2" data-m2="intro" style={{ position: "fixed", inset: 0, zIndex: 1950, pointerEvents: "none" }}>
      <div
        aria-hidden="true"
        className="m2-fade-in"
        onClick={onBackdrop}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(13,27,42,.55)",
          pointerEvents: exiting ? "none" : "auto",
          opacity: exiting ? 0 : 1,
          transition: "opacity 300ms ease-out",
        }}
      />

      <Dialogue
        boxRef={boxRef}
        mobile={mobile}
        text={text}
        tw={tw}
        active={!exiting}
        onAdvance={next}
        onEscape={() => finish("skipped")}
        choices={tw.done && intro?.choices ? intro.choices : undefined}
        onChoose={choose}
        input={intro?.input}
        onInput={(v) => {
          setName(v);
          next();
        }}
        onSkip={() => finish("skipped")}
        skipLabel="Skip intro (Esc)"
        showContinue
        className={reduced ? "m2-fade-in" : "m2-sheet-in"}
        place={{
          ...sheetPlace,
          opacity: exiting ? 0 : 1,
          translate: exiting && !reduced ? "0 12px" : undefined,
          transition: fade ?? "opacity 180ms ease-out, translate 180ms cubic-bezier(.23,1,.32,1)",
          pointerEvents: exiting ? "none" : "auto",
        }}
      />

      <div
        ref={mochiRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: mobile ? 20 : `calc(50% - ${size / 2}px)`,
          bottom: mochiBottom,
          width: size,
          height: size,
          // Behind the box: Mochi rises from behind it and stands on its top edge.
          zIndex: 1949,
          pointerEvents: "none",
          opacity: exiting && reduced ? 0 : 1,
          transition: reduced ? "opacity 150ms ease-out" : undefined,
        }}
      >
        <div ref={riseRef} style={{ width: size, height: size, transformOrigin: "50% 100%", transform: reduced ? undefined : "translateY(140%)" }}>
          <MochiFace expression={expression} talk={tw.frame} size={size} wave={wave} track={!flying} />
        </div>
      </div>
    </div>
  );
}
