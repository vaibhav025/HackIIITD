"use client";

import { useSyncExternalStore } from "react";

/**
 * Mochi's spoken voice: a tiny controller over the browser's free Web Speech API
 * (window.speechSynthesis). No network calls of our own, no keys, no dependencies. The voice itself
 * comes from the OS / browser, so it sounds different on Windows, macOS, Android and Chrome.
 *
 * - One utterance at a time: every speak() cancels whatever was playing (never overlaps).
 * - Long text is cleaned (emoji, symbols, ₹, %, URLs) and split into short sentence chunks, spoken in
 *   order (Chrome cuts utterances off after ~15s / ~200 chars).
 * - Browsers block speech until the first user gesture. Lines requested before that wait as
 *   "pending" and play on the first click / key press anywhere (see unlock()).
 * - Missing API (old browsers, some Firefox builds): isSupported() is false and everything is a no-op.
 *
 * Screen-reader users: the dialogue text is still announced through its aria-live region; speech
 * never replaces it. Anyone who prefers silence can mute Mochi with the speaker button, the menu item
 * "Voice: On/Off", or the M key while Mochi's dialogue has focus.
 *
 * Tuning: change VOICE_TUNING (pitch / rate / volume) and MOOD_TUNING below; the voice preference
 * order is in pickVoice().
 */

/* ------------------------------------------------------------------ tuning */

/**
 * Base voice: a little girl (about five) — pitch near the top of the range on a female voice,
 * a touch quick and bouncy. Web Speech ranges: pitch 0–2, rate 0.1–10.
 */
export const VOICE_TUNING = { pitch: 1.95, rate: 1.12, volume: 1 };

/** Per-mood nudges added to VOICE_TUNING (volume is a multiplier). */
const MOOD_TUNING: Record<string, { pitch?: number; rate?: number; volume?: number }> = {
  excited: { pitch: 0.15, rate: 0.1 },
  celebrate: { pitch: 0.2, rate: 0.1 },
  love: { pitch: 0.12, rate: 0.03 },
  happy: { pitch: 0.06, rate: 0.03 },
  wink: { pitch: 0.06 },
  surprised: { pitch: 0.18, rate: 0.06 },
  curious: { pitch: 0.04, rate: -0.03 },
  thinking: { pitch: -0.1, rate: -0.08 },
  worried: { pitch: -0.18, rate: -0.06, volume: 0.85 },
  sad: { pitch: -0.3, rate: -0.12, volume: 0.85 },
  sleepy: { pitch: -0.4, rate: -0.22, volume: 0.8 },
};

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tuningFor(mood?: string) {
  const m = (mood && MOOD_TUNING[mood]) || {};
  return {
    pitch: clampN(VOICE_TUNING.pitch + (m.pitch ?? 0), 0.5, 2),
    rate: clampN(VOICE_TUNING.rate + (m.rate ?? 0), 0.6, 1.5),
    volume: clampN(VOICE_TUNING.volume * (m.volume ?? 1), 0, 1),
  };
}

/* ------------------------------------------------------------- text clean-up */

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bOOS\b/g, "out of stock"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\be\.g\.\s?/gi, "for example, "],
  [/\bi\.e\.\s?/gi, "that is, "],
  [/\betc\.(?=\s|$)/gi, "etcetera"],
  [/\bapprox\.?(?=\s)/gi, "approximately"],
  [/\bqty\b\.?/gi, "quantity"],
  [/(\d)\s?hrs?\b\.?/gi, "$1 hours"],
  [/(\d)\s?mins?\b\.?/gi, "$1 minutes"],
  [/(\d)\s?secs?\b\.?/gi, "$1 seconds"],
  [/\bw\/(?=\s)/gi, "with"],
  [/\bShelfSense\b/g, "Shelf Sense"],
  [/\bSKUs\b/g, "S K Us"],
  [/\bSKU\b/g, "S K U"],
];

function rupees(whole: string, frac?: string) {
  const n = whole.replace(/,/g, "");
  const paise = frac ? Number((frac + "0").slice(0, 2)) : 0;
  return paise ? `${n} rupees ${paise} paise` : `${n} rupees`;
}

/** Turns a display line into something a TTS engine reads naturally. Pure, exported for tests. */
export function cleanForSpeech(input: string, maxChars = 0): string {
  let t = input;
  // Links, paths and markdown first (they contain symbols handled below).
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Links / in-app paths are read as words, not spelled out.
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+?(?=[.,!?)]?(?:\s|$))/gi, "the link");
  t = t.replace(/(^|[\s(])\/[a-z][\w\-./?=&#:%]*?(?=[.,!?)]?(?:\s|$))/gi, "$1that page");
  t = t.replace(/[*_`#>]+/g, " ");
  // Money, percentages, maths-ish symbols.
  t = t.replace(/(?:₹|\bRs\.?|\bINR)\s?(\d[\d,]*)(?:\.(\d{1,2}))?/gi, (_m, w: string, f?: string) => rupees(w, f));
  t = t.replace(/₹/g, " rupee sign ");
  t = t.replace(/(\d)\s?%/g, "$1 percent");
  t = t.replace(/%/g, " percent");
  t = t.replace(/(\d)\s?[x×]\s?(?=\d)/g, "$1 times ");
  t = t.replace(/~\s?(?=\d)/g, "about ");
  t = t.replace(/\s=\s/g, " means ");
  t = t.replace(/\s?&\s?/g, " and ");
  t = t.replace(/\s?[→⇒]\s?/g, " to ");
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to);
  // Emoji, pictographs, dingbats, arrows, bullets and other decoration.
  t = t.replace(/\p{Extended_Pictographic}/gu, " ");
  t = t.replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu, "");
  t = t.replace(/[←-⇿─-➿⬀-⯿▼▲►◄•·◆◇○●★☆✓✔✗✕]/g, " ");
  t = t.replace(/[“”«»"]/g, "").replace(/[‘’]/g, "'");
  // Pauses: ellipses and dashes read as short breaks.
  t = t.replace(/\s*(?:…|\.{3,})\s*(?=[\p{Ll}\d])/gu, ", ").replace(/…|\.{3,}/g, ". ").replace(/\s[—–-]\s|—|–/g, ", ");
  t = t.replace(/[|\\{}[\]<>^]/g, " ");
  t = t.replace(/\s*\n+\s*/g, ". ");
  t = t.replace(/\s+([,.!?])/g, "$1").replace(/([,.!?])(?:\s*[,.])+/g, "$1");
  t = t.replace(/\s{2,}/g, " ").replace(/^[\s,.]+/, "").trim();
  if (maxChars > 0 && t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = end > maxChars * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : maxChars)}.`;
  }
  return t;
}

/** Sentence chunks of at most ~`max` chars (short sentences are merged, long ones split at commas/spaces). */
export function chunkText(text: string, max = 170): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  const push = (s: string) => {
    const last = out[out.length - 1];
    if (last && last.length + s.length + 1 <= 90) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
  };
  for (let s of sentences) {
    while (s.length > max) {
      let at = s.lastIndexOf(", ", max);
      if (at < max * 0.4) at = s.lastIndexOf(" ", max);
      if (at <= 0) at = max;
      out.push(s.slice(0, at + 1).trim());
      s = s.slice(at + 1).trim();
    }
    if (s) push(s);
  }
  return out;
}

/** Roman-script Hindi words: such lines get an Indian English voice when one exists. */
const HINGLISH =
  /\b(chalo|accha|achha|acha|arre|arey|yaar|haan|nahi|kya|hai|bas|bhai|theek|thik|ekdum|bilkul|shabaash|shabash|wah|jaldi|sab|kaam|chai|namaste|bahut|thoda|matlab|zabardast|mast|dekho|kirana|dukaan|paisa|paise|ji|boss)\b/i;
export const isHinglish = (t: string) => HINGLISH.test(t);

/* ---------------------------------------------------------------- voices */

const FEMALE =
  /(heera|neerja|veena|raveena|aditi|kajal|isha|priya|swara|female|woman|zira|aria|jenny|samantha|karen|moira|tessa|fiona|victoria|susan|hazel|libby|sonia|natasha|emma|ava|allison|serena|kate|catherine|ana\b|michelle|sara|clara|leah|nicky)/i;
const MALE = /(ravi|prabhat|rishi|hemant|david|mark|george|daniel|alex\b|fred|male|guy|ryan|thomas|james|william|brian|eric|christopher|roger|steffan|aaron|arthur|gordon|oliver|rocko|grandpa)/i;
/** Named favourites (after en-IN female), in order. */
const FAVOURITES = [/google uk english female/i, /microsoft aria/i, /samantha/i, /zira/i, /microsoft jenny/i, /google us english/i];

let voices: SpeechSynthesisVoice[] = [];

function scoreVoice(v: SpeechSynthesisVoice, hinglish: boolean): number {
  const lang = v.lang.replace("_", "-").toLowerCase();
  if (!lang.startsWith("en")) return -1; // only English voices: Mochi's lines are Roman script
  const female = FEMALE.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/i, ""));
  const male = !female && MALE.test(v.name);
  const india = lang === "en-in";
  let s = 10;
  if (india) s += hinglish ? 80 : 40;
  // A child's voice needs a female base: high pitch on a male voice sounds like a cartoon man.
  if (female) s += 60;
  if (male) s -= 80;
  const fav = FAVOURITES.findIndex((re) => re.test(v.name));
  if (fav >= 0) s += 20 - fav * 2;
  if (/natural|neural|online/i.test(v.name)) s += 6; // Edge's natural voices sound much better
  if (v.default) s += 1;
  return s;
}

export function pickVoice(text = ""): SpeechSynthesisVoice | null {
  const hinglish = isHinglish(text);
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = scoreVoice(v, hinglish);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore >= 0 ? best : null;
}

/* ------------------------------------------------------------- controller */

export interface VoiceSnapshot {
  supported: boolean;
  /** A user gesture has happened, so the browser lets us speak. */
  unlocked: boolean;
  /** Audio is playing (or about to) for `owner`. */
  speaking: boolean;
  /** Who asked for the current line (a useTypewriter instance + line key), or null. */
  owner: string | null;
  /** A line is waiting for the first user gesture. */
  pending: boolean;
}

export interface SpeakOptions {
  mood?: string;
  owner?: string;
  /** Cut the spoken text near this length, at a sentence end when possible. */
  maxChars?: number;
  /** 0..1 progress through the spoken text (from `boundary` events, where the voice fires them). */
  onBoundary?: (fraction: number) => void;
  onEnd?: () => void;
}

const SERVER: VoiceSnapshot = { supported: false, unlocked: false, speaking: false, owner: null, pending: false };
let snap: VoiceSnapshot = SERVER;
let inited = false;
const listeners = new Set<() => void>();

let gen = 0;
let pending: { token: number; text: string; opts: SpeakOptions } | null = null;
/** Live utterances are kept referenced: Chrome garbage-collects them mid-speech otherwise. */
let live: SpeechSynthesisUtterance[] = [];
let keepAlive = 0;
let watchdog = 0;

function synth(): SpeechSynthesis | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.speechSynthesis;
    return s && typeof window.SpeechSynthesisUtterance === "function" ? s : null;
  } catch {
    return null;
  }
}

function set(patch: Partial<VoiceSnapshot>) {
  const next = { ...snap, ...patch };
  if (
    next.supported === snap.supported &&
    next.unlocked === snap.unlocked &&
    next.speaking === snap.speaking &&
    next.owner === snap.owner &&
    next.pending === snap.pending
  )
    return;
  snap = next;
  listeners.forEach((l) => l());
}

function loadVoices() {
  try {
    voices = synth()?.getVoices() ?? [];
  } catch {
    voices = [];
  }
}

function onGesture(e: Event) {
  if (e instanceof KeyboardEvent && (e.key === "Escape" || e.key === "Tab" || e.repeat)) return;
  unlock();
}

function init() {
  if (inited || typeof window === "undefined") return;
  inited = true;
  const s = synth();
  if (!s) {
    snap = { ...SERVER };
    return;
  }
  let active = false;
  try {
    active = !!(navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
  } catch {
    /* ignore */
  }
  snap = { supported: true, unlocked: active, speaking: false, owner: null, pending: false };
  loadVoices();
  try {
    s.addEventListener("voiceschanged", loadVoices);
  } catch {
    /* old engines: getVoices() is synchronous there */
  }
  if (!active) {
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
  }
  window.addEventListener("pagehide", () => cancel());
}

export function getVoiceSnapshot(): VoiceSnapshot {
  init();
  return snap;
}
export function subscribeVoice(cb: () => void) {
  init();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(subscribeVoice, getVoiceSnapshot, () => SERVER);
}
export const isSupported = () => getVoiceSnapshot().supported;

function stopTimers() {
  window.clearInterval(keepAlive);
  window.clearTimeout(watchdog);
  keepAlive = 0;
}

/** Stops audio right now. With `token`, only if that request is still the current one. */
export function cancel(token?: number) {
  if (token !== undefined && token !== gen) return;
  gen++;
  pending = null;
  if (live.length) live = [];
  if (typeof window !== "undefined") stopTimers();
  const s = synth();
  try {
    if (s && (s.speaking || s.pending)) s.cancel();
  } catch {
    /* ignore */
  }
  if (inited) set({ speaking: false, owner: null, pending: false });
}

/** First user gesture: the browser now allows speech; play the line that was waiting for it. */
export function unlock() {
  if (!inited) init();
  if (!snap.supported) return;
  window.removeEventListener("pointerdown", onGesture, true);
  window.removeEventListener("keydown", onGesture, true);
  const wasLocked = !snap.unlocked;
  set({ unlocked: true });
  if (pending && (wasLocked || !snap.speaking)) {
    const p = pending;
    pending = null;
    start(p.token, p.text, p.opts);
  }
}

/**
 * Speaks `text` (cleaned and chunked), replacing anything already playing. Returns a token for
 * cancel(token); 0 when nothing will be spoken.
 */
export function speak(text: string, opts: SpeakOptions = {}): number {
  init();
  if (!snap.supported) return 0;
  cancel();
  const clean = cleanForSpeech(text, opts.maxChars);
  if (!clean) return 0;
  const token = gen;
  if (!snap.unlocked) {
    pending = { token, text: clean, opts };
    set({ pending: true, owner: opts.owner ?? null, speaking: false });
    return token;
  }
  start(token, clean, opts);
  return token;
}

function start(token: number, clean: string, opts: SpeakOptions) {
  const s = synth();
  if (!s || token !== gen) return;
  if (!voices.length) loadVoices();
  const chunks = chunkText(clean);
  if (!chunks.length) return;
  const voice = pickVoice(clean);
  const tune = tuningFor(opts.mood);
  const lang = voice?.lang ?? (isHinglish(clean) ? "en-IN" : "en-US");
  const offsets: number[] = [];
  let acc = 0;
  for (const c of chunks) {
    offsets.push(acc);
    acc += c.length + 1;
  }
  const total = Math.max(1, acc - 1);
  set({ speaking: true, owner: opts.owner ?? null, pending: false });

  const done = () => {
    if (token !== gen) return;
    stopTimers();
    live = [];
    set({ speaking: false, owner: null });
    opts.onEnd?.();
  };

  const play = (i: number) => {
    if (token !== gen) return;
    if (i >= chunks.length) return done();
    let u: SpeechSynthesisUtterance;
    try {
      u = new SpeechSynthesisUtterance(chunks[i]);
    } catch {
      return done();
    }
    if (voice) u.voice = voice;
    u.lang = lang;
    u.pitch = tune.pitch;
    u.rate = tune.rate;
    u.volume = tune.volume;
    let ended = false;
    const next = () => {
      if (ended) return;
      ended = true;
      window.clearTimeout(watchdog);
      opts.onBoundary?.(Math.min(1, (offsets[i] + chunks[i].length) / total));
      play(i + 1);
    };
    u.onboundary = (e) => {
      if (token !== gen) return;
      opts.onBoundary?.(Math.min(1, (offsets[i] + (e.charIndex ?? 0)) / total));
    };
    u.onend = () => token === gen && next();
    u.onerror = (e) => {
      if (token !== gen) return;
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === "interrupted" || err === "canceled") return;
      if (err === "not-allowed") {
        // Blocked (no gesture yet after all): wait for one and retry this line.
        ended = true;
        window.clearTimeout(watchdog);
        pending = { token, text: chunks.slice(i).join(" "), opts };
        window.addEventListener("pointerdown", onGesture, true);
        window.addEventListener("keydown", onGesture, true);
        set({ unlocked: false, pending: true, speaking: false });
        return;
      }
      next();
    };
    live = [u];
    // Watchdog: some engines never fire `end` (Chrome after GC / sleep). Move on when silent.
    const budget = (chunks[i].length * 95) / tune.rate + 4000;
    const check = () => {
      if (token !== gen || ended) return;
      if (s.speaking && !s.paused) watchdog = window.setTimeout(check, 1500);
      else next();
    };
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(check, budget);
    try {
      s.speak(u);
    } catch {
      next();
    }
  };

  // Chrome stops long or network-voice speech after ~15s and sometimes sticks in "paused" after a tab
  // switch: nudge it while we speak.
  window.clearInterval(keepAlive);
  keepAlive = window.setInterval(() => {
    if (token !== gen) return;
    try {
      if (!s.speaking) return;
      if (voice && voice.localService === false && !document.hidden) {
        s.pause();
        s.resume();
      } else s.resume();
    } catch {
      /* ignore */
    }
  }, 9000);

  try {
    // A fresh queue: Chrome can be left paused by an earlier tab.
    s.resume();
  } catch {
    /* ignore */
  }
  play(0);
}
