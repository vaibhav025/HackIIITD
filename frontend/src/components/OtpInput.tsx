"use client";

import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

/**
 * N separate digit boxes that behave like one field: typing advances, Backspace goes back,
 * arrows move, and pasting (or the phone's one-time-code autofill) fills every box at once.
 * `onComplete` fires when the last digit lands.
 */
export default function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  label = "Verification code",
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  label?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const commit = (next: string, focusAt: number) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    focus(focusAt);
    if (clean.length === length) onComplete?.(clean);
  };

  const type = (i: number, raw: string) => {
    const got = raw.replace(/\D/g, "");
    if (!got) return;
    // Autofill or a fast typist can drop several digits into one box.
    const next = (value.slice(0, i) + got + value.slice(i + got.length)).slice(0, length);
    commit(next, i + got.length);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) commit(value.slice(0, i) + value.slice(i + 1), i);
      else if (i > 0) commit(value.slice(0, i - 1) + value.slice(i), i - 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const got = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!got) return;
    e.preventDefault();
    commit(got, got.length);
  };

  return (
    <div className="flex justify-between gap-2" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`otp-box ${invalid ? "otp-box-bad" : ""}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={length}
          aria-label={`${label}, digit ${i + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={d}
          onChange={(e) => type(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
