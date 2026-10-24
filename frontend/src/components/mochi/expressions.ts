/**
 * Mochi's face kit: colours, part geometry and the expression table. Pure data, no React.
 * Geometry is in the 160×160 SVG canvas used by MochiFace.
 */

export type EyeKind = "open" | "wide" | "up" | "down" | "happy" | "star" | "heart" | "wink" | "sleepy" | "curious";
export type BrowKind = "raised" | "worried" | "focused" | "quizzical";
export type MouthKind = "smile" | "grin" | "o" | "hmm" | "frown" | "wavy" | "cat" | "snore";
export type TalkFrame = "A" | "B" | "C";
export type Extra = "sparkles" | "sparkle1" | "dots" | "zzz" | "sweat" | "tear" | "bang" | "question" | "hearts";

export type Expression =
  | "idle" | "happy" | "excited" | "thinking" | "surprised" | "wink"
  | "worried" | "sad" | "sleepy" | "love" | "celebrate" | "curious";

export const EXPRESSIONS: Expression[] = [
  "idle", "happy", "excited", "thinking", "surprised", "wink", "worried", "sad", "sleepy", "love", "celebrate", "curious",
];

export interface Face {
  eyes: EyeKind;
  brows: BrowKind | null;
  mouth: MouthKind;
  cheeks: number;
  cheekScale: number;
  antenna: "still" | "bob" | "wiggle" | "pulse" | "droop" | "perk" | "heart";
  body: "float" | "hop" | "hop2" | "tilt-l" | "tilt-r" | "droop" | "breathe" | "jump" | "stretch";
  extras: Extra[];
  blink: boolean;
  /** Eye tracking allowed. */
  track: boolean;
  /** Body tilt in degrees for tilt bodies. */
  tilt?: number;
  /** Antenna droop angle in degrees. */
  droop?: number;
  /** Antenna dot colour override. */
  dot?: string;
  /** Eye size multiplier and glint radius override (worried eyes). */
  eyeScale?: number;
  glint?: number;
  /** Wiggle the antenna once instead of twice. */
  wiggleOnce?: boolean;
}

export const INK = "#04342C";
export const C = {
  mint: "#9FE1CB",
  arm: "#8FD7BF",
  stem: "#0F6E56",
  dot: "#FAC775",
  dotLight: "#FFF4D6",
  cheek: "#ED93B1",
  heart: "#E0567F",
  tear: "#8FCBEA",
  slate: "#415A77",
  navy: "#0D1B2A",
  linen: "#F4F1DE",
  sand: "#D4C4A8",
  portrait: "#E6F7F0",
} as const;

export const FACES: Record<Expression, Face> = {
  idle: { eyes: "open", brows: null, mouth: "smile", cheeks: 0.7, cheekScale: 1, antenna: "still", body: "float", extras: [], blink: true, track: true },
  happy: { eyes: "happy", brows: null, mouth: "grin", cheeks: 0.85, cheekScale: 1.05, antenna: "wiggle", wiggleOnce: true, body: "hop", extras: [], blink: false, track: false },
  excited: { eyes: "star", brows: "raised", mouth: "grin", cheeks: 0.95, cheekScale: 1.15, antenna: "wiggle", body: "hop2", extras: ["sparkles"], blink: false, track: false },
  thinking: { eyes: "up", brows: "quizzical", mouth: "hmm", cheeks: 0.6, cheekScale: 1, antenna: "pulse", body: "tilt-l", tilt: -6, extras: ["dots"], blink: true, track: false },
  surprised: { eyes: "wide", brows: "raised", mouth: "o", cheeks: 0.7, cheekScale: 1, antenna: "perk", body: "stretch", extras: ["bang"], blink: false, track: true },
  wink: { eyes: "wink", brows: null, mouth: "cat", cheeks: 0.85, cheekScale: 1.05, antenna: "wiggle", body: "tilt-r", tilt: 4, extras: ["sparkle1"], blink: false, track: false },
  worried: { eyes: "open", eyeScale: 0.9, glint: 2.6, brows: "worried", mouth: "wavy", cheeks: 0.35, cheekScale: 1, antenna: "droop", droop: 14, body: "tilt-l", tilt: -3, extras: ["sweat"], blink: true, track: true },
  sad: { eyes: "down", brows: "worried", mouth: "frown", cheeks: 0.3, cheekScale: 1, antenna: "droop", droop: 22, body: "droop", extras: ["tear"], blink: true, track: false },
  sleepy: { eyes: "sleepy", brows: null, mouth: "snore", cheeks: 0.5, cheekScale: 1, antenna: "droop", droop: 25, dot: "#C9B27A", body: "breathe", extras: ["zzz"], blink: false, track: false },
  love: { eyes: "heart", brows: null, mouth: "grin", cheeks: 0.95, cheekScale: 1.2, antenna: "heart", body: "hop", extras: ["hearts"], blink: false, track: false },
  celebrate: { eyes: "happy", brows: "raised", mouth: "grin", cheeks: 1, cheekScale: 1.2, antenna: "wiggle", body: "jump", extras: ["sparkles"], blink: false, track: false },
  curious: { eyes: "curious", brows: "quizzical", mouth: "smile", cheeks: 0.7, cheekScale: 1, antenna: "perk", body: "tilt-r", tilt: 8, extras: ["question"], blink: true, track: true },
};

/* ------------------------------------------------------------------ geometry */

export const BODY_PATH = "M30 100 Q30 40 80 40 Q130 40 130 100 Q130 135 80 135 Q30 135 30 100 Z";
export const EYE_L = { x: 64, y: 86 };
export const EYE_R = { x: 96, y: 86 };
export const STAR_PATH = "M0 -9 L2.35 -3.24 L8.56 -2.78 L3.8 1.24 L5.29 7.28 L0 4 L-5.29 7.28 L-3.8 1.24 L-8.56 -2.78 L-2.35 -3.24 Z";
export const HEART_PATH = "M0 7 C-10 0 -8 -8 -3.5 -7.5 C-1.5 -7.2 0 -5.5 0 -4 C0 -5.5 1.5 -7.2 3.5 -7.5 C8 -8 10 0 0 7 Z";
export const SPARKLE_PATH = "M0 -6 Q1 -1 6 0 Q1 1 0 6 Q-1 1 -6 0 Q-1 -1 0 -6 Z";

/** Base offset of the eyes group per eye kind (looking up / down). */
export const EYE_BASE: Partial<Record<EyeKind, { x: number; y: number }>> = {
  up: { x: 1.5, y: -3.5 },
  down: { x: 0, y: 2 },
};

export const BROWS: Record<BrowKind, [string, string]> = {
  raised: ["M57 72 Q64 66 71 72", "M89 72 Q96 66 103 72"],
  worried: ["M56 75 Q62 74 69 70", "M91 70 Q98 74 104 75"],
  focused: ["M57 72 L70 76", "M90 76 L103 72"],
  quizzical: ["M57 75 Q64 73 71 75", "M89 71 Q96 65 103 70"],
};

/** Talking mouth frame for the character just typed: vowels open, letters mid, the rest closed. */
export function talkFrameFor(ch: string | undefined): TalkFrame {
  if (!ch) return "A";
  if (/[aeiouAEIOU]/.test(ch)) return "C";
  if (/\p{L}|\p{N}/u.test(ch)) return "B";
  return "A";
}
