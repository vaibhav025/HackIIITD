"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { api, useApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { EASE } from "@/lib/motion";
import type { ChatMessage, Conversation, ConversationDetail, Health, HelpTopic, Me, ProductCard } from "@/lib/types";
import { Skeleton, useConfirm } from "@/components/ui";
import Reveal, { RevealItem } from "@/components/motion/Reveal";

/** Shown only when the deployment configures a real support inbox; there is no placeholder address. */
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null;

/** `source` is known only for replies received in this session ("gemini" | "fallback"). */
type LiveMessage = ChatMessage & { source?: string };
type ChatReply = { conversation_id: string; answer: string; actions: Record<string, unknown>[]; evidence: Record<string, unknown>[]; source: string };

/** Assistant actions may only deep-link to known in-app routes (never external or protocol-relative URLs). */
const SAFE_ACTION_PATH = /^\/(dashboard|products(\/[\w-]+(\/(settings|telegram|heatmap))?)?|heatmap|help|settings|agents)(\?[^#\s]*)?(#[\w-]*)?$/;
const isSafeActionPath = (path: unknown): path is string =>
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && SAFE_ACTION_PATH.test(path);

const SUGGESTED = [
  "Which pincodes are out of stock right now?",
  "Am I cheaper than my rivals at checkout?",
  "What should I do first today?",
  "How many checks do I have left?",
];

/** Backend topic slug → design tile (Figma 4:449). Colours follow the frame's slate/sage/sand order. */
const TOPIC_TILES: Record<string, { label: string; icon: string; w: number; h: number; tone: "slate" | "sage" | "sand" }> = {
  "getting-started": { label: "Getting started", icon: "/figma/help/imgContainer9.svg", w: 20.724, h: 20.789, tone: "slate" },
  heatmap: { label: "Heatmaps", icon: "/figma/help/imgContainer10.svg", w: 18.407, h: 18.418, tone: "sage" },
  recommendations: { label: "Recommendations", icon: "/figma/help/imgContainer11.svg", w: 22.371, h: 22.347, tone: "sand" },
  runs: { label: "Checks & runs", icon: "/figma/dashboard/imgSvg9.svg", w: 16, h: 16, tone: "slate" },
  credits: { label: "Plans & credits", icon: "/figma/help/imgContainer13.svg", w: 20.407, h: 16.407, tone: "sand" },
  weekly: { label: "Weekly report", icon: "/figma/dashboard/imgSvg12.svg", w: 16, h: 16, tone: "sage" },
};
const TILE_ORDER = ["getting-started", "heatmap", "recommendations", "runs", "credits", "weekly"];
const TONE_CLASS = { slate: "bg-slate text-linen", sage: "bg-sage text-ink", sand: "bg-sand text-ink" };

function dayLabel(iso: string) {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-IN", { weekday: "short" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

const rank = (slug: string) => (TILE_ORDER.includes(slug) ? TILE_ORDER.indexOf(slug) : 99);

function pincodesIn(text: string) {
  return [...new Set(text.match(/\b\d{6}\b/g) ?? [])];
}

/* Chat motion: user bubbles grow from their bottom-right corner, assistant rows (avatar + bubble) from
   the bottom-left. Messages loaded from history only get a quick fade. Exits are popped out of flow
   (AnimatePresence mode="popLayout"), so the reply takes the typing bubble's place without a jump. */
const bubble: Variants = {
  hidden: (side: number) => ({ opacity: 0, x: 18 * side, y: 8, scale: 0.94 }),
  shown: { opacity: 1, x: 0, y: 0, scale: 1, transition: { duration: 0.32, ease: EASE } },
  past: { opacity: 0 },
  pastShown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.15 } },
};

export default function HelpPage() {
  const me = useApi<Me>("/me");
  const products = useApi<ProductCard[]>("/products");
  const topics = useApi<{ items: HelpTopic[] }>("/help/topics");
  const history = useApi<{ items: Conversation[] }>("/chat/conversations");
  const health = useApi<Health>("/health");
  const aiConfigured = health.data?.integrations?.gemini;
  const [confirmUi, confirm] = useConfirm();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string>("");
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [ask, setAsk] = useState("");
  const [typing, setTyping] = useState(false);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  // `thread` remounts the message list when switching conversations (no exit replay);
  // messages before `liveFrom` came from history and only fade in.
  const [thread, setThread] = useState(0);
  const [liveFrom, setLiveFrom] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const chatCard = useRef<HTMLElement>(null);
  const scrollTopicIntoView = useRef(false);
  // Bumped whenever the visible thread changes, so a reply that lands after switching is dropped.
  const threadToken = useRef(0);

  // Braces matter: never return a value (scrollIntoView returns a Promise in newer Chrome) from an effect.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  const firstName = me.data?.profile.name?.split(" ")[0];
  const tiles = (topics.data?.items ?? [])
    .slice()
    .sort((a, b) => rank(a.slug) - rank(b.slug));
  const activeTopic = tiles.find((t) => t.slug === openTopic);
  const conversations = history.data?.items ?? [];
  const shownConversations = showAllHistory ? conversations : conversations.slice(0, 5);

  async function openConversation(id: string) {
    let c: ConversationDetail;
    try {
      c = await api<ConversationDetail>(`/chat/conversations/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open that conversation");
      return;
    }
    threadToken.current += 1;
    setTyping(false);
    setConversationId(c.id);
    setProductId(c.product_id ?? "");
    setThread((t) => t + 1);
    setLiveFrom(c.messages.length);
    setMessages(c.messages);
    revealChat();
  }

  function newChat() {
    threadToken.current += 1;
    setTyping(false);
    setConversationId(null);
    setThread((t) => t + 1);
    setLiveFrom(0);
    setMessages([]);
  }

  async function deleteConversation(c: Conversation) {
    const ok = await confirm({
      title: "Delete this conversation?",
      body: <>“{c.title}” and its {c.message_count} message{c.message_count === 1 ? "" : "s"} will be removed for good.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(c.id);
    try {
      await api(`/chat/conversations/${c.id}`, { method: "DELETE" });
      if (conversationId === c.id) newChat();
      await history.mutate();
      toast.success("Conversation deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete that conversation");
    } finally {
      setDeleting(null);
    }
  }

  function revealChat() {
    const el = chatCard.current;
    if (el && el.getBoundingClientRect().top > window.innerHeight * 0.6) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleTopic(slug: string) {
    const next = openTopic === slug ? null : slug;
    setOpenTopic(next);
    scrollTopicIntoView.current = !!next;
  }

  /** Returns false when nothing was sent (empty text or a reply still pending), so callers keep the draft. */
  function send(text: string): boolean {
    const content = text.trim();
    if (!content || typing) return false;
    void deliver(content);
    return true;
  }

  // POST /chat continues the open conversation (the server replays its history), else starts one.
  async function deliver(content: string) {
    const token = threadToken.current;
    setDraft("");
    revealChat();
    setMessages((m) => [...m, { role: "user", content, actions: [], evidence: [], created_at: new Date().toISOString() }]);
    setTyping(true);
    try {
      const res = await api<ChatReply>("/chat", {
        method: "POST",
        json: { message: content, conversation_id: conversationId, product_id: conversationId ? null : productId || null },
      });
      history.mutate();
      if (token !== threadToken.current) return;
      setConversationId(res.conversation_id);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: res.answer, actions: res.actions, evidence: res.evidence, created_at: new Date().toISOString(), source: res.source },
      ]);
    } catch (e) {
      if (token !== threadToken.current) return;
      const reason = e instanceof Error ? e.message : "I couldn't answer that";
      toast.error(`Chat failed: ${reason}`);
      setMessages((m) => [...m, { role: "assistant", content: `Sorry — ${reason}.`, actions: [], evidence: [], created_at: new Date().toISOString() }]);
    } finally {
      if (token === threadToken.current) setTyping(false);
    }
  }

  const heatmapHref = (pin: string) => `/heatmap?${new URLSearchParams({ pincode: pin, ...(productId ? { product: productId } : {}) })}`;

  return (
    <div className="flex flex-col gap-10 w-full max-w-[1100px]">
      {/* Page header */}
      <section data-mochi="help-ask" className="flex flex-col gap-6">
        <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px] font-semibold text-ink">
          How can we help{firstName ? `, ${firstName}` : ""}?
        </h1>
        <form
          className="relative flex items-center h-16 rounded-[16px] border-2 border-ink bg-linen shadow-[6px_6px_0_var(--ink)] pl-[22px] pr-[10px] gap-0 focus-within:ring-4 focus-within:ring-slate/20"
          onSubmit={(e) => {
            e.preventDefault();
            if (send(ask)) setAsk("");
          }}
        >
          <img src="/figma/help/imgMargin.svg" alt="" width={34.371} height={18.365} className="shrink-0" />
          <input
            aria-label="Ask a question"
            className="flex-1 min-w-0 bg-transparent outline-none text-[16px] text-ink placeholder:text-ink/60 pr-3"
            placeholder="Ask anything about your products, plan or Telegram…"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
          />
          <button className="btn btn-primary btn-sm h-11 px-[26px] text-[14px] leading-5 shrink-0" disabled={typing}>
            Ask
          </button>
        </form>
      </section>

      {/* Main layout: 4 / 8 columns */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
        {/* Suggested questions */}
        <section data-mochi="help-suggested" className="flex flex-col gap-4 lg:col-span-4 lg:row-start-1">
          <h2 className="text-[28px] md:text-[32px] leading-8 font-semibold">Suggested questions</h2>
          <Reveal stagger className="flex flex-col gap-3">
            {SUGGESTED.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                disabled={typing}
                className="group flex items-center justify-between gap-3 min-h-12 px-[18px] py-3 rounded-[12px] border-2 border-ink bg-linen press press-3 text-left text-[14px] leading-5 font-medium text-ink hover:bg-sand/40 disabled:opacity-60"
              >
                <span>{q}</span>
                <img src="/figma/help/imgContainer8.svg" alt="" width={10.938} height={10.938} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </Reveal>
        </section>

        {/* Chat panel */}
        <section ref={chatCard} data-mochi="help-chat" className="flex flex-col gap-3 scroll-mt-6 lg:col-start-5 lg:col-span-8 lg:row-start-1 lg:row-span-3">
          <div className="flex flex-col h-[600px] lg:h-[640px] overflow-hidden rounded-[20px] border-2 border-ink bg-linen shadow-[6px_6px_0_var(--ink)]">
            {/* Context bar */}
            <div className="flex items-center justify-between gap-3 min-h-16 px-4 sm:px-6 py-3 border-b border-ink">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="hidden sm:inline text-[14px] leading-5 font-medium whitespace-nowrap">Answering about:</span>
                <label className="relative min-w-0">
                  <span className="sr-only">Answering about</span>
                  <select
                    className="appearance-none h-9 max-w-[180px] sm:max-w-[220px] truncate rounded-[8px] border-2 border-ink bg-linen pl-[14px] pr-8 text-[14px] leading-5 font-semibold text-ink press press-3 cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                    value={productId}
                    disabled={!!conversationId}
                    onChange={(e) => setProductId(e.target.value)}
                    title={conversationId ? "Start a new chat to change focus" : undefined}
                  >
                    <option value="">All products</option>
                    {products.data?.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <img src="/figma/help/imgContainer16.svg" alt="" width={8.255} height={5.188} className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2" />
                </label>
              </div>
              <button
                onClick={newChat}
                className="flex items-center gap-1.5 h-9 px-[18px] rounded-[8px] border-2 border-ink bg-linen press press-3 text-[12px] leading-4 font-semibold whitespace-nowrap"
              >
                <img src="/figma/help/imgContainer17.svg" alt="" width={9.604} height={9.604} />
                New chat
              </button>
            </div>

            {/* Messages */}
            <div
              ref={scroller}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Conversation with the ShelfSense assistant"
              className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 sm:p-6 flex flex-col gap-5"
            >
              {messages.length === 0 && !typing && (
                <div className="m-auto text-center max-w-sm px-4">
                  <div className="mx-auto mb-4 grid place-items-center size-12 rounded-full border-2 border-ink bg-sand shadow-[3px_3px_0_var(--ink)]">
                    <img src="/figma/help/imgContainer18.svg" alt="" width={13.805} height={13.805} />
                  </div>
                  <p className="font-display text-[24px] leading-8 font-semibold">Ask anything about your shelf.</p>
                  <p className="mt-2 text-[14px] leading-5 text-ink/70">
                    Answers come from your latest checks{productId ? " for the selected product" : " across all products"}. Pick a suggested question or type your own.
                  </p>
                </div>
              )}
              <AnimatePresence key={thread} mode="popLayout">
                {messages.map((m, i) => {
                  const live = i >= liveFrom;
                  const anim = {
                    variants: bubble,
                    initial: live ? "hidden" : "past",
                    animate: live ? "shown" : "pastShown",
                    exit: "exit",
                  };
                  return m.role === "user" ? (
                    <motion.div key={i} className="flex justify-end" custom={1} style={{ originX: 1, originY: 1 }} {...anim}>
                      <div className="max-w-[min(500px,85%)] rounded-[16px] bg-slate p-4 text-[16px] leading-[26px] text-linen whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div key={i} className="flex gap-3 items-start max-w-[min(580px,100%)]" custom={-1} style={{ originX: 0, originY: 1 }} {...anim}>
                      <AssistantMessage message={m} heatmapHref={heatmapHref} live={live} aiConfigured={aiConfigured} />
                    </motion.div>
                  );
                })}
                {typing && (
                  <motion.div
                    key="typing"
                    className="flex gap-3 items-start"
                    style={{ originX: 0, originY: 1 }}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1, transition: { duration: 0.22, ease: EASE, delay: 0.12 } }}
                    exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.14 } }}
                  >
                    <Avatar />
                    <div className="rounded-[16px] bg-sand px-5 py-[18px] dot-typing" role="status" aria-label="Assistant is typing">
                      <span /><span /><span />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Input bar */}
            <form
              className="flex items-center min-h-20 px-4 sm:px-6 py-4 border-t border-ink"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <div className="relative flex-1">
                <input
                  aria-label="Type your question"
                  className="w-full h-12 rounded-[12px] border-2 border-ink bg-linen pl-[46px] pr-[58px] text-[14px] text-ink placeholder:text-ink/60 outline-none focus:ring-4 focus:ring-slate/20"
                  placeholder="Type your question…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  type="button"
                  disabled
                  title="Attachments aren't supported yet"
                  aria-label="Attach a file (not available yet)"
                  className="absolute left-[14px] top-1/2 -translate-y-1/2 grid place-items-center opacity-60 cursor-not-allowed"
                >
                  <img src="/figma/help/imgIcon1.svg" alt="" width={10.835} height={17.005} />
                </button>
                <button
                  aria-label="Send"
                  disabled={typing}
                  className="absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center size-8 rounded-[8px] border-2 border-ink bg-slate press press-3 disabled:opacity-50"
                >
                  <img src="/figma/help/imgContainer21.svg" alt="" width={12.95} height={10.922} />
                </button>
              </div>
            </form>
          </div>
          <p className="px-2 text-[14px] leading-5 text-ink/80">
            {aiConfigured === false
              ? "Offline assistant: answers come from built-in guides and your latest check data (no AI key configured)."
              : "AI answers use your latest check data."}
            {SUPPORT_EMAIL && (
              <>
                {" "}Need a human?{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold underline decoration-2 underline-offset-2">
                  Email {SUPPORT_EMAIL}
                </a>
                .
              </>
            )}
          </p>
        </section>

        {/* Help topics */}
        <section data-mochi="help-topics" className="flex flex-col gap-4 lg:col-span-4 lg:row-start-2">
          <h2 className="text-[28px] md:text-[32px] leading-8 font-semibold">Help topics</h2>
          {!topics.data ? (
            <div className="grid grid-cols-2 gap-[14px]">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[114px] rounded-[16px]" />)}
            </div>
          ) : (
            <>
              <Reveal stagger className="grid grid-cols-2 gap-[14px]" itemClassName="grid">
                {tiles.map((t, i) => {
                  const tile = TOPIC_TILES[t.slug] ?? { label: t.title, icon: "/figma/help/imgContainer9.svg", w: 20.724, h: 20.789, tone: (["slate", "sage", "sand"] as const)[i % 3] };
                  const active = openTopic === t.slug;
                  return (
                    <button
                      key={t.slug}
                      onClick={() => toggleTopic(t.slug)}
                      aria-expanded={active}
                      aria-controls="help-topic-panel"
                      title={t.title}
                      className={`flex flex-col items-start gap-3 min-h-[114px] p-[18px] rounded-[16px] border-2 border-ink text-left leading-[22px] font-semibold ${TONE_CLASS[tile.tone]} ${active ? "translate-x-1 translate-y-1 shadow-none ring-2 ring-ink ring-offset-2 ring-offset-linen" : "press press-4"}`}
                    >
                      <span className="grid place-items-center size-11 shrink-0 rounded-[12px] border-2 border-ink bg-linen">
                        <img src={tile.icon} alt="" width={tile.w} height={tile.h} />
                      </span>
                      <span className={tile.label.length > 13 ? "text-[15.2px]" : "text-[16px]"}>{tile.label}</span>
                    </button>
                  );
                })}
              </Reveal>
              <AnimatePresence mode="wait" initial={false}>
                {activeTopic && (
                <motion.div
                  key={activeTopic.slug}
                  id="help-topic-panel"
                  ref={(el: HTMLDivElement | null) => {
                    if (el && scrollTopicIntoView.current) {
                      scrollTopicIntoView.current = false;
                      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
                    }
                  }}
                  className="card p-5 scroll-mb-6"
                  initial={{ opacity: 0, y: -8, clipPath: "inset(0% -12px 100% -12px round 20px)" }}
                  animate={{ opacity: 1, y: 0, clipPath: "inset(0% -12px -6% -12px round 20px)", transition: { duration: 0.32, ease: EASE } }}
                  exit={{ opacity: 0, y: -6, clipPath: "inset(0% -12px 100% -12px round 20px)", transition: { duration: 0.16, ease: "easeIn" } }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-[20px] leading-7 font-semibold">{activeTopic.title}</h3>
                    <button onClick={() => setOpenTopic(null)} aria-label="Close topic" className="shrink-0 grid place-items-center size-8 rounded-[8px] border-2 border-ink bg-linen text-[16px] font-semibold leading-none press press-2">
                      ×
                    </button>
                  </div>
                  <p className="mt-2 text-[14px] leading-[22px] text-ink/85 whitespace-pre-line">{activeTopic.body}</p>
                  <button className="mt-4 text-[14px] font-semibold underline decoration-2 underline-offset-2" onClick={() => send(`Tell me more about ${activeTopic.title.toLowerCase()}`)}>
                    Ask the assistant about this →
                  </button>
                </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </section>

        {/* Past conversations */}
        <section className="flex flex-col gap-4 lg:col-span-4 lg:row-start-3">
          <h2 className="text-[28px] md:text-[32px] leading-8 font-semibold">Past conversations</h2>
          {!history.data ? (
            <Skeleton className="h-36" />
          ) : conversations.length === 0 ? (
            <p className="text-[14px] text-ink/70">No conversations yet — your questions will show up here.</p>
          ) : (
            <div className="flex flex-col">
              <ul className="flex flex-col">
                {shownConversations.map((c, i) => (
                  <RevealItem as="li" index={i} key={c.id} className={`flex items-center gap-2 ${i < shownConversations.length - 1 ? "border-b border-ink" : ""}`}>
                    <button
                      onClick={() => openConversation(c.id)}
                      className={`flex-1 min-w-0 flex items-center justify-between gap-3 py-[14px] text-left transition-colors hover:text-slate ${conversationId === c.id ? "text-slate" : "text-ink"}`}
                      title={`${c.message_count} messages`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <img src="/figma/help/imgContainer15.svg" alt="" width={15.305} height={15.305} className="shrink-0" />
                        <span className={`truncate text-[16px] leading-6 font-semibold ${conversationId === c.id ? "underline decoration-2 underline-offset-4" : ""}`}>{c.title}</span>
                      </span>
                      <span className="shrink-0 text-[14px] leading-5 font-medium text-ink/70">{dayLabel(c.created_at)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteConversation(c)}
                      disabled={deleting === c.id}
                      aria-label={`Delete conversation “${c.title}”`}
                      title="Delete conversation"
                      className="shrink-0 grid place-items-center size-8 rounded-[8px] border-2 border-transparent text-[18px] leading-none font-semibold text-ink/60 transition-colors hover:border-ink hover:bg-sand/40 hover:text-ink focus-visible:border-ink disabled:opacity-50"
                    >
                      ×
                    </button>
                  </RevealItem>
                ))}
              </ul>
              {conversations.length > 5 && (
                <button className="self-start mt-1 text-[14px] font-semibold underline decoration-2 underline-offset-2" onClick={() => setShowAllHistory((v) => !v)}>
                  {showAllHistory ? "Show fewer" : `Show all ${conversations.length}`}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <Policies />
      {confirmUi}
    </div>
  );
}

const POLICIES: { id: string; title: string; points: string[] }[] = [
  {
    id: "terms",
    title: "Terms",
    points: [
      "ShelfSense is a hackathon prototype provided as-is, with no uptime or accuracy guarantee.",
      "Plans and upgrades run in test mode: no card is charged and no real payment is taken.",
      "Prices, stock and recommendations are informational. You decide every price change; nothing is applied to your listings automatically.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy",
    points: [
      "We store what you enter (products, pincodes, rivals, alert rules) and the check results our agents collect, on the ShelfSense server.",
      "Data isn't sold or shared. AI summaries send only aggregated check data for your products to the model provider when an API key is configured.",
      "You can export everything (Settings → Export) and delete your account at any time.",
    ],
  },
  {
    id: "security",
    title: "Security",
    points: [
      "TinyFish agents only read product pages, the way a shopper would. They never use your personal marketplace accounts; where an app requires sign-in (Instamart), a ShelfSense team test account is used.",
      "Every check is read-only: agents never add to cart, open checkout, place an order or enter payment details.",
      "Evidence screenshots are tied to your account. In production they are served only to you, after an ownership check.",
    ],
  },
];

function Policies() {
  // `:target` doesn't update on client-side navigation (/help#terms from the landing footer), so
  // track the hash ourselves: scroll the card into view and outline it.
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (!POLICIES.some((p) => p.id === id)) return setTarget(null);
      setTarget(id);
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <section aria-labelledby="policies-title" className="mt-16 flex flex-col gap-6">
      <div className="section-head">
        <h2 id="policies-title" className="text-[28px] md:text-[32px] leading-8 font-semibold">
          Terms, privacy &amp; security
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {POLICIES.map((p) => (
          <article
            key={p.id}
            id={p.id}
            className={`card p-[22px] scroll-mt-28 target:outline-[3px] target:outline-slate target:outline-offset-4 ${target === p.id ? "outline-[3px] outline-slate outline-offset-4" : ""}`}
          >
            <h3 className="text-[22px] leading-8 font-semibold">{p.title}</h3>
            <ul className="mt-3 flex flex-col gap-2.5 text-[14px] leading-[22px] text-ink/85">
              {p.points.map((t) => (
                <li key={t} className="flex gap-2">
                  <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink" />
                  {t}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function Avatar() {
  return (
    <div className="grid place-items-center size-9 shrink-0 rounded-full border-2 border-ink bg-sand shadow-[3px_3px_0_var(--ink)]">
      <img src="/figma/help/imgContainer18.svg" alt="" width={13.805} height={13.805} />
    </div>
  );
}

const chipClass =
  "inline-flex items-center gap-1 h-8 px-[14px] rounded-[8px] border-2 border-ink press press-3 text-[12px] leading-4 font-semibold whitespace-nowrap";

/** Chips under a fresh reply rise in 60ms apart after the bubble lands. CSS `backwards` fill (not
 *  `both`) so once done the animation releases transform and the press hover/active works. */
const chipIn = (j: number) => ({ animation: `rise 280ms cubic-bezier(0.22, 1, 0.36, 1) ${220 + Math.min(j, 7) * 60}ms backwards` });

/** Avatar + bubble + chips; the row wrapper (and its entrance) lives in the message list. */
function AssistantMessage({
  message,
  heatmapHref,
  live,
  aiConfigured,
}: {
  message: LiveMessage;
  heatmapHref: (pin: string) => string;
  live: boolean;
  aiConfigured: boolean | undefined;
}) {
  const pins = pincodesIn(message.content);
  const actions = (message.actions ?? []).filter((a) => isSafeActionPath(a.path) && typeof a.label === "string" && a.label.trim());
  const offline = message.source === "fallback";
  const notes = [
    message.evidence?.length > 0 ? `Grounded in ${message.evidence.length} figure${message.evidence.length === 1 ? "" : "s"} from your account` : null,
    offline ? (aiConfigured ? "Offline assistant — the AI service didn't answer, so built-in rules replied" : "Offline assistant — AI key not configured") : null,
  ].filter(Boolean);
  return (
    <>
      <Avatar />
      <div className="flex flex-col gap-3 min-w-0">
        <div className="rounded-[16px] bg-sand p-4 text-[16px] leading-[26px] text-ink whitespace-pre-wrap break-words">
          {message.content}
          {notes.length > 0 && (
            <p className="mt-2 pt-1.5 border-t border-ink/20 text-[12px] leading-4 text-ink/70">{notes.join(" · ")}</p>
          )}
        </div>
        {(pins.length > 0 || actions.length > 0) && (
          <div className="flex flex-wrap gap-2 items-center">
            {pins.map((p, j) => (
              <Link key={p} href={heatmapHref(p)} className={`${chipClass} bg-linen text-ink hover:bg-sand/40`} title={`Open ${p} on the heatmap`} style={live ? chipIn(j) : undefined}>
                {p}
              </Link>
            ))}
            {actions.map((a, j) => (
              <Link key={j} href={String(a.path)} className={`${chipClass} bg-slate text-linen`} style={live ? chipIn(pins.length + j) : undefined}>
                {String(a.label)}
                <img src="/figma/help/imgContainer19.svg" alt="" width={7.102} height={2.813} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
