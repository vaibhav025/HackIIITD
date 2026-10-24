"use client";

/* eslint-disable @next/next/no-img-element */
import { Suspense, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { api, errorMessage, useApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { EASE } from "@/lib/motion";
import type { LinkCode, Product, TelegramStatus, UserSettings } from "@/lib/types";
import { ALERT_KIND_LABEL, formatTime, timeAgo } from "@/lib/format";
import ProductHeader from "@/components/ProductHeader";
import { CardSkeleton, ErrorCard, useConfirm } from "@/components/ui";

/** Every alert kind the engine can raise, plus the two non-alert streams. */
const ALERT_TYPES = ["oos_any", "oos_area", "price_change_pct", "price_gap_pct", "rating_below", "rival_oos", "custom", "recommendations", "briefing"];
const LABELS: Record<string, string> = { ...ALERT_KIND_LABEL, recommendations: "New recommendations", briefing: "Morning briefing" };
/**
 * API semantics for a chat's `alert_types`: null = everything (including kinds added later),
 * [] = nothing, otherwise exactly the listed kinds/streams.
 */
type AlertSelection = Set<string> | null;
type Status = TelegramStatus & { simulate_available?: boolean };
type ChatLink = Omit<TelegramStatus["links"][number], "alert_types"> & { alert_types: string[] | null };
const STEPS = ["Where alerts go", "Get a code", "Send it to the bot", "Choose alerts", "Test alert"];

/** Status pill from the Settings frame Telegram card (36px, 12px radius, sage = connected, sand = not). */
function StatusPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 h-9 px-[14px] rounded-[12px] border-2 border-ink bg-sage text-[14px] leading-5 font-semibold">
      <img src="/figma/product-pages/pill-check.svg" alt="" width={10} height={7} /> Connected
    </span>
  ) : (
    <span className="inline-flex items-center h-9 px-[14px] rounded-[12px] border-2 border-ink bg-sand text-[14px] leading-5 font-semibold">Not connected</span>
  );
}


/** Circle pop when it becomes current or done (keyframes replay on each state change, not on mount). */
const circle: Variants = {
  todo: { scale: 1 },
  current: { scale: [1, 1.14, 1], transition: { duration: 0.36, ease: EASE, delay: 0.18 } },
  done: { scale: [1, 1.14, 1], transition: { duration: 0.36, ease: EASE } },
};

/** Step cards cross-fade with a small slide in the direction of travel (10px keeps the 6px shadow
 *  inside the 16px mobile gutter, so no horizontal scroll mid-transition). */
const stepCard: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: 10 * dir }),
  center: { opacity: 1, x: 0, transition: { duration: 0.28, ease: EASE } },
  exit: (dir: number) => ({ opacity: 0, x: -10 * dir, transition: { duration: 0.16, ease: "easeIn" } }),
};

/** Numbered stepper: sand = current, sage + check = done, linen = to do.
 *  The connector to circle n fills left→right (scaleX) once step n is reached. */
function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-start" aria-label="Setup progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const current = step === n;
        return (
          <li key={label} className="flex-1 flex flex-col items-center gap-2 relative min-w-0" aria-current={current ? "step" : undefined}>
            {i > 0 && (
              <span className="absolute top-5 right-1/2 w-full h-[2px] -z-0 bg-ink/20" aria-hidden>
                <motion.span
                  className="absolute inset-0 bg-ink"
                  style={{ originX: 0 }}
                  initial={false}
                  animate={{ scaleX: step >= n ? 1 : 0 }}
                  transition={{ duration: 0.4, ease: EASE }}
                />
              </span>
            )}
            <motion.span
              variants={circle}
              initial={false}
              animate={done ? "done" : current ? "current" : "todo"}
              className={`relative z-10 grid place-items-center size-10 rounded-full border-2 border-ink font-display text-[18px] leading-none transition-colors ${
                done ? "bg-sage shadow-[3px_3px_0_var(--ink)]" : current ? "bg-sand shadow-[3px_3px_0_var(--ink)]" : "bg-linen text-ink/75"
              }`}
            >
              {done ? <img src="/figma/product-pages/pill-check.svg" alt="Done" width={14} height={11} /> : n}
            </motion.span>
            <span className={`text-center text-[14px] leading-5 px-1 hidden md:block ${current ? "font-semibold" : "font-medium text-ink/70"}`}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function StepCard({ n, title, hint, children }: { n: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-[26px] flex flex-col gap-5 min-w-0">
      <div>
        <p className="eyebrow text-slate">Step {n} of {STEPS.length}</p>
        <h2 className="text-[28px] sm:text-[32px] leading-10 tracking-[-0.64px] mt-1">{title}</h2>
        {hint && <p className="text-[16px] leading-6 text-ink/80 mt-1">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

type Busy = null | "code" | "simulate" | "save" | "test" | "disconnect";

/** Copies `text`; falls back to selecting nothing when the Clipboard API is unavailable (http, old browsers). */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy(text: string, what: string) {
      if (!navigator.clipboard) {
        toast.error("Copying isn't available here — select the text and copy it manually");
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(text);
          toast(`${what} copied`);
          setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
        },
        (e) => toast.error(errorMessage(e, `Couldn't copy the ${what.toLowerCase()}`)),
      );
    },
  };
}

/** True once `iso` is in the past; flips on time without polling. */
function useExpired(iso: string | null | undefined) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!iso) return;
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    const t = setTimeout(() => setExpired(true), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [iso]);
  return expired;
}

export default function TelegramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<CardSkeleton rows={6} />}>
      <TelegramFlow id={id} />
    </Suspense>
  );
}

function TelegramFlow({ id }: { id: string }) {
  const search = useSearchParams();
  const product = useApi<Product>(`/products/${id}`);
  const [chatType, setChatType] = useState<"personal" | "group">(search.get("mode") === "group" ? "group" : "personal");
  const [code, setCode] = useState<LinkCode | null>(null);
  const [step, setStep] = useState(1);
  const expired = useExpired(code?.expires_at);
  // Poll only while a live code is waiting to be redeemed.
  const status = useApi<Status>(`/products/${id}/telegram/status`, { refreshInterval: code && step === 3 && !expired ? 3000 : 0 });
  const userSettings = useApi<UserSettings>("/me/settings");
  const [types, setTypes] = useState<AlertSelection>(null);
  const [briefing, setBriefing] = useState("08:00");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const { copied, copy } = useCopy();
  const [confirmUi, confirm] = useConfirm();
  // Link ids that existed when "Add another chat" started; a new id means the new chat is linked.
  const [knownLinks, setKnownLinks] = useState<Set<string> | null>(null);
  // Direction of travel for the step-card transition (adjusted during render, not in an effect).
  const [view, setView] = useState({ step, dir: 1 });
  if (view.step !== step) setView({ step, dir: step > view.step ? 1 : -1 });

  const links = useMemo(() => (status.data?.links ?? []) as ChatLink[], [status.data]);
  const connected = status.data?.status === "connected";
  const newLink = knownLinks ? links.find((l) => !knownLinks.has(l.id)) : undefined;
  const addingChat = knownLinks != null;

  // Jump to "Choose alerts" when connected — on load, or when the code we issued gets redeemed.
  useEffect(() => {
    if (step >= 4) return;
    if (addingChat ? newLink : connected) {
      if (code) toast(addingChat ? "Another chat connected" : "Telegram connected");
      setKnownLinks(null);
      setCode(null);
      setStep(4);
    }
  }, [connected, step, code, addingChat, newLink]);

  // Seed the alert form from the saved link once (don't clobber the user's edits on every poll).
  const seeded = useRef(false);
  useEffect(() => {
    const link = links[0];
    if (!link || seeded.current) return;
    seeded.current = true;
    setTypes(link.alert_types == null ? null : new Set(link.alert_types));
    if (link.briefing_time) setBriefing(link.briefing_time);
  }, [links]);

  const wants = (t: string) => types === null || types.has(t);
  function toggleType(t: string) {
    setTypes((s) => {
      const n = new Set(s ?? ALERT_TYPES);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      // Every option picked is the same as "everything", which also covers kinds added later.
      return ALERT_TYPES.every((x) => n.has(x)) ? null : n;
    });
  }

  async function act(kind: Exclude<Busy, null>, fn: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e, fallback));
    } finally {
      setBusy(null);
    }
  }

  const getCode = () =>
    act(
      "code",
      async () => {
        const c = await api<LinkCode>(`/products/${id}/telegram/link-code`, { method: "POST", json: { chat_type: chatType } });
        setCode(c);
        setStep(3);
        toast(code ? "New code generated — the old one no longer works" : "Link code generated");
      },
      "Couldn't create a link code",
    );

  function addAnotherChat() {
    setKnownLinks(new Set(links.map((l) => l.id)));
    setCode(null);
    setNote(null);
    setStep(1);
  }

  function cancelAddChat() {
    setKnownLinks(null);
    setCode(null);
    setStep(4);
  }

  async function disconnect() {
    const many = links.length > 1;
    const ok = await confirm({
      title: many ? `Disconnect all ${links.length} chats?` : "Disconnect Telegram?",
      body: `${product.data?.name ?? "This product"} will stop sending alerts and briefings${many ? " to every linked chat" : ""}. You can reconnect any time.`,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    await act(
      "disconnect",
      async () => {
        await api(`/products/${id}/telegram`, { method: "DELETE" });
        setCode(null);
        setKnownLinks(null);
        setNote(null);
        seeded.current = false;
        // Refresh first, or the "connected" effect would bounce us back to step 4.
        await status.mutate();
        setStep(1);
        toast("Telegram disconnected");
      },
      "Couldn't disconnect",
    );
  }

  if (product.error) return <ErrorCard error={product.error} onRetry={() => product.mutate()} />;
  if (status.error && !status.data) return <ErrorCard error={status.error} onRetry={() => status.mutate()} />;

  const ready = status.data && product.data;
  const mock = !status.data?.enabled;
  // No bot and no demo shortcut (production without a token): a code could never be redeemed.
  const unavailable = mock && !status.data?.simulate_available;
  const bot = status.data?.bot_username;
  const command = code ? code.command ?? `/start ${code.code}` : "";
  const channelOff = (userSettings.data?.channels as Record<string, unknown> | undefined)?.telegram === false;
  const nothingSelected = types !== null && types.size === 0;

  return (
    <div className="flex flex-col">
      <ProductHeader productId={id} active="telegram" action={status.data ? <StatusPill connected={connected} /> : undefined} />
      {!ready ? (
        <CardSkeleton rows={6} />
      ) : (
        <div className="flex flex-col gap-8 max-w-[860px]">
          <p className="text-[18px] leading-[27px] font-medium text-slate -mt-2">Get alerts, a morning briefing, and approve actions with one tap.</p>

          {mock && (
            <div className="card bg-sand px-[26px] py-4 flex items-start gap-3">
              <span className="grid place-items-center size-9 shrink-0 rounded-[10px] bg-linen border-2 border-ink">
                <img src="/figma/shell/alert-bot.svg" alt="" width={16} height={16} />
              </span>
              <p className="text-[15px] leading-[22.5px]">
                {unavailable ? (
                  <>
                    <b className="font-semibold">Telegram isn&apos;t set up on this server.</b> There&apos;s no bot to send a code to, so chats can&apos;t be connected yet. Ask your admin to add a Telegram bot token.
                  </>
                ) : (
                  <>
                    <b className="font-semibold">Demo mode:</b> no Telegram bot is configured, so there&apos;s no real bot to message and alerts are logged instead of sent. In step 3, use “Simulate bot confirmation” to link a demo chat.
                  </>
                )}
              </p>
            </div>
          )}

          {channelOff && (
            <div className="card bg-sand px-[26px] py-4">
              <p className="text-[15px] leading-[22.5px]">
                <b className="font-semibold">Telegram alerts are switched off</b> in{" "}
                <Link href="/settings" className="underline underline-offset-2 font-semibold">
                  Settings
                </Link>
                , so no alerts or briefings are sent to any chat until you turn them back on.
              </p>
            </div>
          )}

          {addingChat && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink rounded-[16px] bg-linen px-5 py-3">
              <p className="text-[15px] font-semibold">Adding another chat · {links.length} already connected</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={cancelAddChat}>
                Cancel
              </button>
            </div>
          )}

          <div data-mochi="tg-steps">
            <Stepper step={step} />
          </div>

          <AnimatePresence mode="wait" initial={false} custom={view.dir}>
          <motion.div key={step} className="min-w-0" custom={view.dir} variants={stepCard} initial="enter" animate="center" exit="exit">
          {step === 1 && (
            <StepCard n={1} title={addingChat ? "Where should the new chat get alerts?" : "Choose where alerts go"}>
              <div className="grid sm:grid-cols-2 gap-4" role="radiogroup" aria-label="Chat type">
                {(["personal", "group"] as const).map((t) => {
                  const on = chatType === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setChatType(t)}
                      className={`text-left border-2 border-ink rounded-[16px] p-5 flex flex-col gap-1 transition-[background,box-shadow,transform] ${
                        on ? "bg-sage/50 press press-4 -translate-x-0.5 -translate-y-0.5" : "bg-linen hover:bg-ink/5"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-[18px] leading-[27px]">{t === "personal" ? "Personal chat" : "Team group"}</span>
                        <span className={`size-5 rounded-full border-2 border-ink grid place-items-center ${on ? "bg-slate" : "bg-linen"}`} aria-hidden>
                          {on && <span className="size-2 rounded-full bg-linen" />}
                        </span>
                      </span>
                      <span className="text-[15px] leading-[22.5px] text-ink/80">
                        {t === "personal" ? "Just you, in a private chat with the bot." : "Add the bot to your sales or distributor group."}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div>
                <button type="button" className="btn btn-primary h-12 px-[26px]" disabled={unavailable} onClick={() => setStep(2)}>Continue →</button>
              </div>
            </StepCard>
          )}

          {step === 2 && (
            <StepCard
              n={2}
              title="Get your one-time code"
              hint={<>We&apos;ll create a code that links this {chatType === "group" ? "group" : "chat"} to <b className="font-semibold text-ink">{product.data!.name}</b>. It expires in 10 minutes.</>}
            >
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary h-12 px-[26px]" disabled={!!busy || unavailable} onClick={getCode}>
                  {busy === "code" ? "Generating…" : "Generate code"}
                </button>
                <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={!!busy} onClick={() => setStep(1)}>Back</button>
              </div>
            </StepCard>
          )}

          {step === 3 && (
            <StepCard
              n={3}
              title={expired ? "This code has expired" : mock ? "Confirm your demo code" : "Open the bot and send the code"}
              hint={expired ? "Codes last 10 minutes. Generate a new one to continue." : undefined}
            >
              {code && (
                <>
                  <div className="flex flex-wrap items-center gap-4">
                    <motion.code
                      initial={{ opacity: 0, scale: 0.94, clipPath: "inset(0% 50% 0% 50% round 20px)" }}
                      animate={{ opacity: 1, scale: 1, clipPath: "inset(-10% -10% -10% -10% round 20px)" }}
                      transition={{ duration: 0.4, ease: EASE, delay: 0.12 }}
                      aria-label={expired ? `Expired code ${code.code}` : `Link code ${code.code}`}
                      className={`font-display text-[24px] sm:text-[48px] leading-none tracking-[0.06em] sm:tracking-[0.1em] max-w-full break-all bg-linen border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] px-5 sm:px-8 py-5 ${
                        expired ? "line-through decoration-2 text-ink/75 border-dashed shadow-none" : ""
                      }`}
                    >
                      {code.code}
                    </motion.code>
                    {!expired && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(code.code, "Code")}>
                        {copied === code.code ? "✓ Copied" : "Copy"}
                      </button>
                    )}
                  </div>
                  {!expired && mock && (
                    <p className="text-[15px] leading-[22.5px] text-ink/80">
                      There&apos;s no Telegram bot on this server to send the code to. Press “Simulate bot confirmation” below to link a demo
                      {chatType === "group" ? " group" : " chat"} as if the bot had received <code className="font-semibold">{command}</code>. Demo chats only log messages.
                    </p>
                  )}
                  {!expired && !mock && (
                    <div className="text-[16px] leading-6 flex flex-col gap-3">
                      {code.deep_link ? (
                        <div>
                          <a href={code.deep_link} target="_blank" rel="noreferrer" className="btn btn-sand h-12 px-[22px]">
                            <img src="/figma/heatmaps/imgContainer14.svg" alt="" width={16} height={13} />
                            {bot ? `Open @${bot} in Telegram` : "Open in Telegram"} <span aria-hidden>↗</span>
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        </div>
                      ) : null}
                      <div>
                        <p className="text-[15px] leading-[22.5px] text-ink/80 mb-2">
                          {code.deep_link ? "Or send this message" : "In Telegram, send this message"} to {bot ? `@${bot}` : "the ShelfSense bot"}
                          {chatType === "group" ? " in your group (add the bot to the group first)" : ""}:
                        </p>
                        <div className="flex flex-wrap items-center gap-3">
                          <code className="font-semibold text-[16px] bg-sand/60 border-2 border-ink rounded-[10px] px-3 py-2 break-all">{command}</code>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(command, "Command")}>
                            {copied === command ? "✓ Copied" : "Copy command"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-4 border-t border-ink/20 pt-4">
                    {expired ? (
                      <p className="text-[14px] font-semibold" role="status">
                        Expired at {formatTime(code.expires_at)} · no longer checking
                      </p>
                    ) : (
                      <p className="text-[14px] font-medium text-ink/80 flex items-center gap-2" role="status">
                        <span className="dot-typing shrink-0 whitespace-nowrap" aria-hidden><span /><span /><span /></span>
                        Waiting for confirmation · expires {formatTime(code.expires_at)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setStep(2)}>
                        Back
                      </button>
                      <button type="button" className={`btn btn-sm ${expired ? "btn-primary" : "btn-ghost"}`} disabled={!!busy} onClick={getCode}>
                        {busy === "code" ? "Generating…" : "Regenerate code"}
                      </button>
                      {status.data?.simulate_available && !expired && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!!busy}
                          onClick={() =>
                            act(
                              "simulate",
                              async () => {
                                await api(`/products/${id}/telegram/simulate-link`, { method: "POST", json: { code: code.code, chat_type: chatType } });
                                await status.mutate();
                              },
                              "Simulation failed",
                            )
                          }
                        >
                          {busy === "simulate" ? "Simulating…" : "Simulate bot confirmation"}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </StepCard>
          )}

          {step === 4 && (
            <StepCard n={4} title="Choose your alerts" hint={links.length > 1 ? `These settings apply to all ${links.length} connected chats.` : undefined}>
              <LinkedList links={links} />
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <p className="text-[14px] leading-5 font-semibold" id="tg-alert-types">Send me</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={types === null} onClick={() => setTypes(null)}>
                      Select all
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={nothingSelected} onClick={() => setTypes(new Set())}>
                      Clear
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="tg-alert-types">
                  {ALERT_TYPES.map((t) => (
                    <button key={t} type="button" className="pill" data-active={wants(t)} aria-pressed={wants(t)} onClick={() => toggleType(t)}>
                      {wants(t) ? "✓ " : ""}
                      {LABELS[t] ?? t}
                    </button>
                  ))}
                </div>
                <p className={`text-[14px] leading-5 mt-3 ${nothingSelected ? "font-semibold bg-sand border-2 border-ink rounded-[8px] px-3 py-2" : "text-ink/80"}`} role="status">
                  {types === null
                    ? "Everything is on, including alert types added later."
                    : nothingSelected
                      ? "Nothing selected: this chat stays linked but gets no alerts, recommendations or briefings."
                      : `${types.size} of ${ALERT_TYPES.length} selected. Anything unselected is not sent to this chat.`}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-y border-ink/20 py-4">
                <div className="min-w-0">
                  <label htmlFor="briefing" className="text-[16px] leading-6 font-semibold">Morning briefing time</label>
                  {!wants("briefing") && <p className="text-[14px] leading-5 text-ink/80">Turn on “Morning briefing” above to get one.</p>}
                </div>
                <input
                  id="briefing"
                  type="time"
                  required
                  disabled={!wants("briefing")}
                  className="input h-12 px-[18px] text-[16px] font-normal w-[176px] disabled:opacity-60 disabled:cursor-not-allowed"
                  value={briefing}
                  onChange={(e) => setBriefing(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn btn-primary h-12 px-[26px]"
                  disabled={!!busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(briefing)}
                  onClick={() =>
                    act(
                      "save",
                      async () => {
                        await api(`/products/${id}/telegram`, { method: "PATCH", json: { alert_types: types === null ? null : [...types], briefing_time: briefing } });
                        await status.mutate();
                        setStep(5);
                        toast("Alerts saved");
                      },
                      "Couldn't save alerts",
                    )
                  }
                >
                  {busy === "save" ? "Saving…" : "Save alerts"}
                </button>
                <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={!!busy} onClick={addAnotherChat}>
                  + Add another chat
                </button>
              </div>
            </StepCard>
          )}

          {step === 5 && (
            <StepCard n={5} title="Send a test alert" hint="Check that messages reach the chat, then you're done.">
              <LinkedList links={links} />
              <div className="flex gap-3 flex-wrap">
                <button
                  type="button"
                  className="btn btn-sand h-12 px-[22px]"
                  disabled={!!busy}
                  onClick={() =>
                    act(
                      "test",
                      async () => {
                        setNote(null);
                        const r = await api<{ sent: boolean; message: string }>(`/products/${id}/telegram/test`, { method: "POST" });
                        if (r.sent) {
                          setNote({ ok: true, text: "Test alert sent — check Telegram." });
                          toast("Test alert sent");
                        } else {
                          setNote({ ok: false, text: r.message || "The test alert wasn't delivered." });
                          toast.error(r.message || "Test alert not delivered");
                        }
                      },
                      "Test alert failed",
                    )
                  }
                >
                  <img src="/figma/heatmaps/imgContainer14.svg" alt="" width={16} height={13} /> {busy === "test" ? "Sending…" : "Send test alert"}
                </button>
                <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={!!busy} onClick={() => setStep(4)}>Edit alerts</button>
                <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={!!busy} onClick={addAnotherChat}>+ Add another chat</button>
                <button type="button" className="btn btn-ghost h-12 px-[22px]" disabled={!!busy} onClick={disconnect}>
                  {busy === "disconnect" ? "Disconnecting…" : links.length > 1 ? "Disconnect all" : "Disconnect"}
                </button>
              </div>
              {note && (
                <p className={`text-[15px] font-semibold border-2 border-ink rounded-[12px] px-4 py-3 ${note.ok ? "bg-sage/40" : "bg-sand"}`} role="status">
                  {note.ok ? "✓ " : "! "}
                  {note.text}
                </p>
              )}
            </StepCard>
          )}
          </motion.div>
          </AnimatePresence>
        </div>
      )}
      {confirmUi}
    </div>
  );
}

function LinkedList({ links }: { links: ChatLink[] }) {
  if (!links.length) return null;
  return (
    <ul className="flex flex-col border-b border-ink/20 pb-2">
      {links.map((l) => (
        <li key={l.id} className="flex flex-wrap items-center gap-3 pb-2">
          <span className="text-[16px] leading-6 font-semibold break-all">{l.chat_title ?? l.chat_id}</span>
          <StatusPill connected />
          <span className="text-[14px] font-medium text-ink/80">linked {timeAgo(l.connected_at)}</span>
        </li>
      ))}
    </ul>
  );
}
