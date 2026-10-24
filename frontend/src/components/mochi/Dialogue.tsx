"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useFocusTrap } from "@/lib/a11y";
import { talkFrameFor, type TalkFrame } from "./expressions";
import { getPrefs, setPrefs, usePrefs } from "./store";
import { cancel as cancelSpeech, getVoiceSnapshot, speak, unlock, useVoice } from "./voice";

/* ------------------------------------------------------------ typewriter */

export interface Typewriter {
  shown: string;
  done: boolean;
  /** Talking mouth frame while typing or speaking, null once both are done. */
  frame: TalkFrame | null;
  /** Mochi's voice is reading this line aloud right now. */
  speaking: boolean;
  finish: () => void;
}

export interface SpeakOpts {
  /** Speak this line (voice pref on, Mochi visible...). Turning it off cancels at once. */
  on: boolean;
  mood?: string;
  maxChars?: number;
}

const SPEAK_FRAMES: TalkFrame[] = ["B", "C", "B", "A", "C", "A"];

/**
 * Types `text` out at 28ms per character (+180ms after .!?…, +90ms after a comma). `lineKey`
 * restarts it; reduced motion shows the text instantly. Mouth frames come free with each character.
 * With `speak`, the line is also read aloud (./voice.ts): the mouth keeps moving until the voice
 * stops, and where the voice reports word boundaries the typing waits for it (never far ahead).
 */
export function useTypewriter(
  text: string,
  lineKey: string | number,
  opts: { reduced: boolean; voice?: boolean; paused?: boolean; speak?: SpeakOpts },
): Typewriter {
  const chars = Array.from(text);
  const total = chars.length;
  const [state, setState] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  const key = `${lineKey}::${text}`;
  const n = opts.reduced ? total : state.key === key ? state.n : 0;
  // The typing position lives in a ref shared with finish(), so a skip sticks (the timer loop
  // reads it instead of keeping its own counter).
  const pos = useRef({ key: "", n: 0 });
  // Latest spoken progress (0..1) for this line, and when it arrived.
  const spoken = useRef({ key: "", frac: 0, at: 0 });

  const uid = useId();
  const owner = `${uid}|${key}`;
  const v = useVoice();
  // Audible right now (a line waiting for the first tap doesn't count: nothing should wait on it).
  const speaking = !!text && v.owner === owner && v.speaking;
  const wantSpeech = !!opts.speak?.on && !!text && !opts.paused;
  const mood = opts.speak?.mood;
  const maxChars = opts.speak?.maxChars;

  useEffect(() => {
    if (!wantSpeech) return;
    spoken.current = { key, frac: 0, at: 0 };
    const token = speak(text, {
      mood,
      owner,
      maxChars,
      onBoundary: (frac) => {
        spoken.current = { key, frac, at: performance.now() };
      },
    });
    return () => cancelSpeech(token);
    // One utterance per line: a mood change alone doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantSpeech]);

  useEffect(() => {
    if (opts.reduced || opts.paused) return;
    if (pos.current.key !== key) pos.current = { key, n: 0 };
    let t = 0;
    const step = () => {
      if (pos.current.key !== key || pos.current.n >= total) return;
      // Stay roughly in step with the voice when it reports word boundaries: never more than a few
      // words ahead of it, and catch up if it ever runs ahead of the text.
      const sp = spoken.current;
      if (sp.key === key && sp.at && performance.now() - sp.at < 1500) {
        const said = Math.floor(sp.frac * total);
        if (pos.current.n > said + 24) {
          t = window.setTimeout(step, 60);
          return;
        }
        if (said > pos.current.n + 1) pos.current = { key, n: Math.min(total, said - 1) };
      }
      const i = pos.current.n + 1;
      pos.current = { key, n: i };
      setState({ key, n: i });
      const ch = chars[i - 1];
      const delay = 28 + (/[.!?…]/.test(ch) ? 180 : ch === "," ? 90 : 0);
      t = window.setTimeout(step, delay);
    };
    t = window.setTimeout(step, 28);
    return () => window.clearTimeout(t);
    // Restart only when the line changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opts.reduced, opts.paused]);

  const done = n >= total;
  // Typed out but still talking: keep the mouth moving (not under reduced motion).
  const [tick, setTick] = useState(0);
  const mouthy = done && speaking && !opts.reduced;
  useEffect(() => {
    if (!mouthy) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 120);
    return () => window.clearInterval(id);
  }, [mouthy]);

  return {
    shown: chars.slice(0, n).join(""),
    done,
    frame: !done ? talkFrameFor(chars[n - 1]) : mouthy ? SPEAK_FRAMES[tick % SPEAK_FRAMES.length] : null,
    speaking,
    finish: () => {
      pos.current = { key, n: total };
      setState({ key, n: total });
    },
  };
}

/* ---------------------------------------------------------- voice toggle */

export function toggleSpeech() {
  const on = !getPrefs().speech;
  if (on) unlock();
  else cancelSpeech();
  setPrefs({ speech: on });
}

/** "M" toggles Mochi's voice while focus is inside Mochi's box, except while typing in a field. */
export function speechHotkey(e: React.KeyboardEvent) {
  if (e.key !== "m" && e.key !== "M") return false;
  const t = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
  if (!getVoiceSnapshot().supported) return false;
  e.preventDefault();
  toggleSpeech();
  return true;
}

/** 🔊/🔇 button for Mochi's spoken voice. Renders nothing where speech isn't supported. */
export function SpeakerToggle({ style }: { style?: CSSProperties }) {
  const v = useVoice();
  const prefs = usePrefs();
  if (!v.supported) return null;
  const on = prefs.speech;
  return (
    <button
      type="button"
      className="m2-speaker"
      aria-label="Mochi's voice"
      aria-pressed={on}
      title={on ? "Mute Mochi (M)" : "Let Mochi talk (M)"}
      data-m2-speaker=""
      data-on={on ? "" : undefined}
      data-talking={on && v.speaking ? "" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        toggleSpeech();
      }}
      style={style}
    >
      <span aria-hidden="true">{on ? "🔊" : "🔇"}</span>
    </button>
  );
}

/** "🔊 Tap to hear Mochi": shown until the first gesture lets the browser speak. */
export function TapToHear({ style }: { style?: CSSProperties }) {
  const v = useVoice();
  const prefs = usePrefs();
  if (!v.supported || v.unlocked || !prefs.speech) return null;
  return (
    <button
      type="button"
      className="m2-chip m2-tap-hear"
      data-m2-tap-hear=""
      onClick={(e) => {
        e.stopPropagation();
        unlock();
      }}
      style={style}
    >
      <span aria-hidden="true">🔊 </span>Tap to hear Mochi
    </button>
  );
}

/* -------------------------------------------------------------- dialogue */

export interface DialogueChoice {
  id: string;
  label: string;
}

export interface DialogueProps {
  boxRef: RefObject<HTMLDivElement | null>;
  mobile: boolean;
  /** Full line (sr-only mirror + ghost sizing). */
  text: string;
  tw: Typewriter;
  /** Click / Enter / → once the line is typed (and it has no choices or input). */
  onAdvance: () => void;
  onEscape: () => void;
  onBack?: () => void;
  choices?: DialogueChoice[];
  onChoose?: (id: string) => void;
  input?: { placeholder: string; max: number; submit: string; skip: string };
  onInput?: (value: string | null) => void;
  skipLabel?: string;
  onSkip?: () => void;
  portrait?: ReactNode;
  footer?: ReactNode;
  /** Show the blinking ▼ when typing is done. */
  showContinue?: boolean;
  /** Positioning (inline, fixed). */
  place: CSSProperties;
  /** Extra classes, e.g. enter animation. */
  className?: string;
  /** Focus trap active (false while an app dialog has taken over). */
  active: boolean;
  /** Primary action selector to focus when the dialog opens (else the box). */
  initialFocus?: string;
  label?: string;
  /** Max height (mobile tour sheet) — content scrolls inside. */
  maxHeight?: string;
  textSize?: number;
}

export default function Dialogue(p: DialogueProps) {
  const { boxRef, tw, choices, input, mobile } = p;
  const [active, setActive] = useState(0);
  const [name, setName] = useState("");
  const showChoices = tw.done && !!choices?.length;
  const showInput = tw.done && !!input;
  const inputRef = useRef<HTMLInputElement>(null);
  const choiceRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Screen readers: the first line is read via aria-describedby when the dialog opens; every later
  // line is announced through a polite live region (full text, never the half-typed one).
  const [announce, setAnnounce] = useState("");
  const firstText = useRef(p.text);
  useEffect(() => {
    if (p.text === firstText.current && !announce) return;
    setAnnounce(p.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.text]);

  useFocusTrap(boxRef, p.active, {
    initialFocus: p.initialFocus ?? "[data-m2-focus]",
    onEscape: () => {
      if (inputRef.current && document.activeElement === inputRef.current) p.onInput?.(null);
      else p.onEscape();
    },
  });

  // Move focus to the controls as they appear, so the keyboard flow never stalls.
  const choiceKey = choices?.map((c) => c.id).join("|") ?? "";
  useEffect(() => {
    if (!showChoices) return;
    setActive(0);
    choiceRefs.current[0]?.focus({ preventScroll: true });
  }, [showChoices, choiceKey]);
  useEffect(() => {
    if (showInput) inputRef.current?.focus({ preventScroll: true });
  }, [showInput]);
  // A new line removed the focused control (input, choice): keep focus inside the box.
  useEffect(() => {
    if (!p.active) return;
    const id = requestAnimationFrame(() => {
      const box = boxRef.current;
      if (box && !box.contains(document.activeElement)) box.querySelector<HTMLElement>("[data-m2-focus]")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [p.text, p.active, boxRef]);

  const primary = () => {
    if (!tw.done) tw.finish();
    else if (!showChoices && !showInput) p.onAdvance();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (speechHotkey(e)) return;
    const onControl = t.tagName === "BUTTON" || t.tagName === "A";
    if (e.key === "Enter" || e.key === " ") {
      if (onControl && (tw.done || t.dataset.m2Choice !== undefined)) return; // native click
      e.preventDefault();
      primary();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      primary();
    } else if (e.key === "ArrowLeft" && p.onBack) {
      e.preventDefault();
      p.onBack();
    } else if (showChoices && /^[1-9]$/.test(e.key)) {
      const c = choices![Number(e.key) - 1];
      if (c) {
        e.preventDefault();
        p.onChoose?.(c.id);
      }
    } else if (showChoices && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = choices!.length;
      const next = (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      setActive(next);
      choiceRefs.current[next]?.focus({ preventScroll: true });
    }
  };

  const sheet = mobile;
  const box: CSSProperties = {
    position: "fixed",
    zIndex: 1950,
    pointerEvents: "auto",
    boxSizing: "border-box",
    background: "#F4F1DE",
    border: "2px solid #0D1B2A",
    borderRadius: sheet ? "20px 20px 0 0" : 20,
    boxShadow: sheet ? "none" : "6px 6px 0 #0D1B2A",
    padding: sheet ? "22px 18px calc(18px + env(safe-area-inset-bottom))" : "22px 26px 18px",
    color: "#0D1B2A",
    ...p.place,
  };
  const size = p.textSize ?? 17;

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="m2-name"
      aria-describedby="m2-line"
      aria-label={p.label}
      tabIndex={-1}
      data-m2-dialog=""
      className={`m2-box ${p.className ?? ""}`}
      style={box}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, label, form")) return;
        primary();
      }}
    >
      <span id="m2-name" className="m2-plate" style={{ position: "absolute", top: -16, left: 22 }}>
        Mochi
      </span>
      <div style={{ position: "absolute", top: 6, right: 10, display: "flex", alignItems: "center", gap: 4 }}>
        <SpeakerToggle />
        {p.onSkip && (
          <button type="button" className="m2-link" onClick={p.onSkip}>
            {p.skipLabel}
          </button>
        )}
      </div>
      <span id="m2-line" className="sr-only">
        {p.text}
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </span>

      {/* Initial focus lands here (not on "Skip"), so Enter advances instead of skipping. */}
      <div
        tabIndex={-1}
        data-m2-focus=""
        style={{ maxHeight: p.maxHeight, overflowY: p.maxHeight ? "auto" : undefined, display: "flex", gap: 14, alignItems: "flex-start", outline: "none" }}
      >
        {p.portrait}
        <div style={{ flex: 1, minWidth: 0, paddingTop: 8 }}>
          <p className="m2-text" aria-hidden="true" style={{ fontSize: size, lineHeight: `${size + 9}px`, fontWeight: 500 }}>
            {/* The full text reserves the final height, so the box never grows while typing. */}
            <span className="m2-ghost">{p.text}</span>
            <span className="m2-typed">{tw.shown}</span>
          </p>

          {showChoices && (
            <div className="m2-choices-in" role="group" aria-label="Choices" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2 }}>
              {choices!.map((c, i) => (
                <button
                  key={c.id}
                  ref={(el) => {
                    choiceRefs.current[i] = el;
                  }}
                  type="button"
                  className="m2-choice"
                  data-m2-choice=""
                  data-active={i === active ? "" : undefined}
                  style={{ minHeight: mobile ? 48 : undefined }}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onClick={() => p.onChoose?.(c.id)}
                >
                  {c.label}
                  <span className="sr-only"> (press {i + 1})</span>
                </button>
              ))}
            </div>
          )}

          {showInput && (
            <form
              className="m2-choices-in"
              style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
              onSubmit={(e) => {
                e.preventDefault();
                p.onInput?.(name.trim().slice(0, input!.max) || null);
              }}
            >
              <label htmlFor="m2-name-input" className="sr-only">
                {input!.placeholder}
              </label>
              <input
                ref={inputRef}
                id="m2-name-input"
                className="m2-input"
                style={{ flex: "1 1 180px" }}
                value={name}
                maxLength={input!.max}
                placeholder={input!.placeholder}
                autoComplete="given-name"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm" data-m2-primary="">
                {input!.submit}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => p.onInput?.(null)}>
                {input!.skip}
              </button>
            </form>
          )}

          <TapToHear style={{ marginTop: 10 }} />
        </div>
      </div>

      {p.footer}

      {p.showContinue && tw.done && !showChoices && !showInput && (
        <span aria-hidden="true" className="m2-caret" style={{ position: "absolute", right: 18, bottom: 10, fontSize: 14 }}>
          ▼
        </span>
      )}
    </div>
  );
}
