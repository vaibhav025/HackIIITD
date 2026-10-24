/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import type { ReactNode } from "react";

// Marketing homepage — Figma frame 8:943 ("homepage"). Static page: the numbers
// in the widgets are the design's illustrative marketing copy.
// Sections use a larger scroll margin below lg, where the sticky header has a second nav row.

const A = "/figma/home";
// Fraunces with the file's variation settings, for non-heading elements
// (`.font-display` pins weight 600, these need Bold/Italic).
const SERIF = "font-serif [font-variation-settings:'SOFT'_0,'WONK'_1]";
// Hard-shadow press + hover lift, shared by buttons and cards.
const PRESS = "transition-[translate,box-shadow,filter] duration-100 hover:brightness-[1.04] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none";
const LIFT = "transition-[translate,box-shadow] duration-200 hover:-translate-x-0.5 hover:-translate-y-1";
const WRAP = "mx-auto w-full max-w-[1240px] px-4 sm:px-6";

function Icon({ name, w, h, className = "" }: { name: string; w: number; h: number; className?: string }) {
  return <img src={`${A}/${name}.svg`} alt="" width={w} height={h} className={`block shrink-0 ${className}`} />;
}

function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[13px] leading-[19.5px] font-extrabold tracking-[2.6px] uppercase text-center pb-3 ${className}`}>{children}</p>;
}

const H2 = "text-[40px] leading-[48px] sm:text-[52px] sm:leading-[64px] lg:text-[64px] lg:leading-[80px] text-center";

/* ---------------------------------------------------------------- 1 NAVBAR */

const NAV = [
  ["How it works", "#how"],
  ["Agents", "#agents"],
  ["Mobile", "#mobile"],
  ["Features", "#features"],
  ["Pricing", "#pricing"],
  ["Help", "/help"],
] as const;

function Navbar() {
  return (
    <header className="sticky top-0 z-50 bg-linen border-b-2 border-ink">
      <div className={`${WRAP} h-[80px] flex items-center justify-between gap-4`}>
        <Link href="/" className="flex items-center gap-3 shrink-0" aria-label="ShelfSense home">
          <span className="grid place-items-center size-10 rounded-[10px] border-2 border-ink bg-sand shadow-[3px_3px_0_var(--ink)]">
            <Icon name="navLogo" w={19.7} h={19.7} />
          </span>
          <span className="flex flex-col">
            <span className="font-display text-[22px] leading-[27.5px] tracking-[-0.55px]">ShelfSense</span>
            <span className="text-[10px] leading-[10px] font-bold tracking-[2px] uppercase">Intelligence</span>
          </span>
        </Link>
        <nav className="hidden lg:flex items-center gap-8" aria-label="Sections">
          {NAV.map(([t, href]) => (
            <a key={t} href={href} className="tab p-0 text-[16px] leading-[24px] font-bold">{t}</a>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <Link href="/login" className={`hidden sm:block bg-linen border-2 border-ink rounded-[12px] px-[18px] py-[10px] text-[15px] leading-[22.5px] font-bold ${PRESS}`}>
            Log in
          </Link>
          <Link href="/dashboard" className={`flex items-center gap-2 h-[44px] px-4 sm:px-[22px] rounded-[12px] border-2 border-ink bg-slate text-linen text-[14px] leading-[20px] font-bold shadow-[3px_3px_0_var(--ink)] ${PRESS}`}>
            Open dashboard <Icon name="navArrow" w={12} h={12} />
          </Link>
        </div>
      </div>
      <nav className="lg:hidden flex gap-5 overflow-x-auto px-4 sm:px-6 pb-3 -mt-1 text-[14px] font-bold" aria-label="Sections">
        {NAV.map(([t, href]) => <a key={t} href={href} className="whitespace-nowrap">{t}</a>)}
        <Link href="/login" className="sm:hidden whitespace-nowrap underline underline-offset-4">Log in</Link>
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ 2 HERO */

type Cell = [string, "in" | "gap" | "oos" | "na"];
const MESH: Cell[] = [
  ["110001", "in"], ["110003", "in"], ["110014", "in"], ["110016", "gap"], ["110017", "in"], ["110019", "in"],
  ["110020", "in"], ["110024", "in"], ["110048", "oos"], ["110049", "oos"], ["110021", "in"], ["110022", "in"],
  ["110025", "in"], ["110029", "in"], ["110065", "oos"], ["110066", "oos"], ["110070", "in"], ["110074", "in"],
  ["122001", "in"], ["122002", "in"], ["122003", "in"], ["122018", "gap"], ["122050", "in"], ["122052", "in"],
  ["201301", "in"], ["201304", "in"], ["201307", "in"], ["201310", "in"], ["110091", "na"], ["110092", "na"],
];

function MeshDot({ s }: { s: Cell[1] }) {
  const base = "grid place-items-center size-7 rounded-full border-2 border-ink text-[12px] leading-4";
  if (s === "in") return <span className={`${base} bg-sage`}><Icon name="heroCheck" w={10.19} h={7.52} /></span>;
  if (s === "gap") return <span className={`${base} bg-sand font-extrabold`}>₹</span>;
  if (s === "oos") return <span className={`${base} bg-linen border-dashed font-semibold`}>✕</span>;
  return <span className={`${base} bg-linen font-bold`}>·</span>;
}

function LiveMesh() {
  return (
    <div className="relative mt-6 lg:mt-0">
      <div className="bg-linen border-2 border-ink rounded-[20px] shadow-[8px_8px_0_var(--ink)] overflow-hidden">
        <div className="bg-ink border-b-2 border-ink flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 pl-6 pr-6 pt-10 sm:pt-4 pb-[18px]">
          <div className="flex items-center gap-[10px]">
            <span className="size-3 rounded-full bg-sand" />
            <span className={`${SERIF} font-bold text-[18px] leading-[28px] tracking-[0.45px] text-linen whitespace-nowrap`}>Delhi NCR Live Mesh</span>
          </div>
          <div className="flex gap-[6px]">
            {["Blinkit", "Zepto", "Instamart"].map((p) => (
              <span key={p} className="bg-slate border border-linen/30 rounded-[6px] px-[11px] py-[5px] text-[11px] leading-[16.5px] font-bold text-linen">{p}</span>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-5 p-4 sm:p-6">
          <div className="bg-sand border-2 border-ink rounded-[12px] shadow-[3px_3px_0_var(--ink)] p-[14px] flex items-center justify-between gap-3">
            <div className="flex items-center gap-[10px]">
              <span className="grid place-items-center size-6 shrink-0 rounded-[6px] bg-ink text-linen text-[12px] font-bold">!</span>
              <span className="text-[12px] leading-4 font-bold">South Delhi · 4 pincodes out of stock</span>
            </div>
            <span className="bg-ink text-linen rounded-[4px] px-2 py-[2px] text-[11px] leading-[16.5px] font-extrabold tracking-[0.55px] uppercase">Alert</span>
          </div>
          <div className="bg-linen border-2 border-ink rounded-[12px] p-3 sm:p-[18px]">
            <div className="grid grid-cols-6 gap-x-1 sm:gap-x-3 gap-y-3">
              {MESH.map(([pin, s]) => (
                <div key={pin} className="flex flex-col items-center gap-1">
                  <MeshDot s={s} />
                  <span className={`text-[9px] leading-[13.5px] ${s === "oos" ? "font-extrabold" : "font-bold"} ${s === "na" ? "text-ink/75" : ""}`}>{pin}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t-2 border-ink pt-[18px] grid grid-cols-2 gap-2 text-[12px] leading-4 font-bold">
            <span className="flex items-center gap-2"><span className="size-[14px] shrink-0 rounded-full bg-sage border border-ink" />In stock (24)</span>
            <span className="flex items-center gap-2"><span className="size-[14px] shrink-0 rounded-full bg-linen border-2 border-dashed border-ink" />Out of stock (4)</span>
            <span className="flex items-center gap-2"><span className="grid place-items-center w-[14px] h-4 shrink-0 rounded-full bg-sand border border-ink text-[10px] font-extrabold">₹</span>₹12 above rival (2)</span>
            <span className="flex items-center gap-2"><span className="size-[14px] shrink-0 rounded-full bg-linen border border-ink" />Not checked recently</span>
          </div>
        </div>
      </div>
      <span className="absolute -right-2 -top-[21.7px] -rotate-4 bg-sand border-2 border-ink rounded-[8px] shadow-[6px_6px_0_var(--ink)] px-[18px] pt-[13.5px] pb-[10.5px] text-[12px] leading-4 font-extrabold tracking-[0.6px] uppercase whitespace-nowrap">
        Live pincode data
      </span>
    </div>
  );
}

function Hero() {
  return (
    <section data-mochi="hero" className="bg-slate border-b-2 border-ink pt-16 pb-16 lg:pt-24 lg:pb-[98px]">
      <div className={`${WRAP} grid gap-12 lg:grid-cols-12 items-center`}>
        <div className="lg:col-span-7 lg:pr-4 flex flex-col items-start">
          <span className="bg-sand border-2 border-ink rounded-[8px] shadow-[3px_3px_0_var(--ink)] px-4 pt-[11px] pb-[9px] text-[11px] sm:text-[13px] leading-[19.5px] font-extrabold tracking-[2.6px] uppercase">
            Pricing &amp; shelf intelligence
          </span>
          <h1 className="mt-6 text-linen text-[44px] leading-[48px] min-[400px]:text-[48px] min-[400px]:leading-[52px] sm:text-[80px] sm:leading-[80px] xl:text-[104px] xl:leading-[104px] tracking-[-0.025em]">
            See your market
            <span className={`block ${SERIF} italic font-normal text-sand`}>the way shoppers</span>
            <span className={`block ${SERIF} italic font-normal text-sand`}>do.</span>
          </h1>
          <p className="mt-6 max-w-[560px] text-linen text-[18px] leading-[29px] sm:text-[20px] sm:leading-[32.5px] font-medium">
            ShelfSense watches your competitors and your stock in every pincode, then tells you exactly how to win, without a price war.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/dashboard" data-mochi="hero-cta" className={`flex items-center gap-2 h-14 px-[34px] rounded-[20px] border-2 border-ink bg-sand text-[18px] leading-[28px] font-bold shadow-[6px_6px_0_var(--ink)] ${PRESS} active:translate-x-1.5 active:translate-y-1.5`}>
              Map my product <Icon name="heroArrow" w={13.33} h={13.33} />
            </Link>
            <a href="#how" className={`flex items-center h-14 px-[34px] rounded-[20px] border-2 border-ink bg-linen text-[18px] leading-[28px] font-bold shadow-[6px_6px_0_var(--ink)] ${PRESS} active:translate-x-1.5 active:translate-y-1.5`}>
              See how it works
            </a>
          </div>
          <div className="mt-12 flex flex-wrap gap-3">
            {["15-min sync", "Blinkit, Zepto, Instamart", "Amazon & Flipkart"].map((c) => (
              <span key={c} className="flex items-center gap-2 bg-linen border-2 border-ink rounded-[12px] shadow-[3px_3px_0_var(--ink)] px-4 py-[10px] text-[12px] leading-4 font-bold">
                <span className="grid place-items-center size-5 rounded-[6px] bg-sage"><Icon name="heroCheck" w={10.19} h={7.52} /></span>
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="lg:col-span-5"><LiveMesh /></div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- 3 MARQUEE */

const TICKER = "In stock ✓ · Out of stock ✕ · Price gap ₹ · 110017 · 110016 · 110048 · 560038 · 560001 · 560102 · Live pincode intelligence · ";

function Marquee() {
  const copy = (hidden?: boolean) => (
    <span aria-hidden={hidden} className="shrink-0 whitespace-pre pr-0">{TICKER.repeat(3)}</span>
  );
  return (
    <div className="bg-ink border-b-2 border-ink pt-3 pb-[14px] overflow-hidden">
      <div className="flex w-max animate-[marquee_45s_linear_infinite] motion-reduce:animate-none text-sand text-[14px] leading-[20px] font-extrabold tracking-[1.4px] uppercase">
        {copy()}
        {copy(true)}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- 4 PROBLEM */

const REASONS = [
  { t: "Prices change hourly", d: "Blinkit, Zepto, and Instamart adjust surge discounts per micro-zone faster than any spreadsheet can keep up with.", bg: "bg-slate", fg: "text-linen", sub: "text-linen/90", box: "bg-sand", icon: ["probClock", 27.13, 27.13] },
  { t: "Every dark store has its own stock", d: "City-level visibility is a myth. When a dark store runs dry, your product silently vanishes from search results.", bg: "bg-sage", fg: "text-ink", sub: "text-ink/90", box: "bg-linen", icon: ["probStore", 27.17, 25] },
  { t: "Existing tools show data, not decisions", d: "You don't need 20 charts of raw CSVs. You need a direct nudge on Telegram saying \"re-allocate 15 units now.\"", bg: "bg-deep", fg: "text-linen", sub: "text-linen/90", box: "bg-slate", icon: ["probBolt", 23.84, 27.38] },
] as const;

function Problem() {
  return (
    <section id="problem" className="bg-sand border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px] scroll-mt-[136px] lg:scroll-mt-20">
      <div className={`${WRAP} grid gap-14 lg:grid-cols-12 items-start`}>
        <div className="lg:col-span-6 lg:pr-6 flex flex-col items-start gap-[19.3px]">
          <span className="bg-ink border-2 border-ink rounded-[8px] px-[14px] pt-[10.5px] pb-[7.5px] text-sand text-[12px] leading-[18px] font-extrabold tracking-[2.4px] uppercase">
            The hyperlocal blindspot
          </span>
          <h2 className="text-[48px] leading-[50px] sm:text-[64px] sm:leading-[66px] xl:text-[76px] xl:leading-[77.52px] max-w-[544px]">
            Your product is in stock 2 km away.
            <span className={`block ${SERIF} italic font-normal`}>Not here.</span>
          </h2>
          <p className="pt-1 text-[17px] leading-[28px] sm:text-[19px] sm:leading-[30.88px] font-medium max-w-[544px]">
            When you check your Amazon or Blinkit listing from your corporate office, it looks available. But a consumer living 4 kilometers east opens their phone to find your shelf empty, instantly handing market share to your rival.
          </p>
          <div className={`w-full bg-deep border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] px-6 sm:px-[34px] pt-[46.7px] pb-[34px] flex flex-col gap-4 ${LIFT} hover:shadow-[8px_10px_0_var(--ink)]`}>
            <p className={`${SERIF} font-bold text-sand text-[80px] leading-[80px] sm:text-[110px] sm:leading-[110px]`}>34.2%</p>
            <p className="text-linen text-[13px] sm:text-[14px] leading-[20px] font-extrabold tracking-[2.24px] uppercase max-w-[460px]">
              Average silent revenue leak across Indian FMCG &amp; D2C brands
            </p>
          </div>
        </div>
        <div className="lg:col-span-6 lg:pt-2 flex flex-col gap-6">
          {REASONS.map((r) => (
            <div key={r.t} className={`${r.bg} border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-6 sm:p-[30px] flex gap-5 items-start ${LIFT} hover:shadow-[8px_10px_0_var(--ink)]`}>
              <span className={`grid place-items-center size-14 shrink-0 rounded-[16px] border-2 border-ink ${r.box} shadow-[3px_3px_0_var(--ink)]`}>
                <Icon name={r.icon[0]} w={r.icon[1]} h={r.icon[2]} />
              </span>
              <div className="flex flex-col gap-2">
                <h3 className={`font-sans font-bold text-[20px] leading-[28px] sm:text-[24px] sm:leading-[32px] ${r.fg}`}>{r.t}</h3>
                <p className={`text-[15px] sm:text-[16px] leading-[26px] font-medium ${r.sub}`}>{r.d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- 5 HOW IT WORKS */

const STEPS = [
  { n: "1", t: "Add a product", d: "Paste your SKU URL. We auto-link rival ASINs.", bg: "bg-slate", num: "text-sand", fg: "text-linen", sub: "text-linen/90" },
  { n: "2", t: "Agents check every pincode", d: "Distributed headless agents probe dark stores 24/7.", bg: "bg-sage", num: "text-linen", fg: "text-ink", sub: "text-ink/90" },
  { n: "3", t: "See the heatmap", d: "Instant visual clarity on stock-outs and competitor gains.", bg: "bg-sand", num: "text-ink", fg: "text-ink", sub: "text-ink/90" },
  { n: "4", t: "Approve on Telegram", d: "Tap once to accept AI repricing and stock nudges.", bg: "bg-deep", num: "text-sand", fg: "text-linen", sub: "text-linen/90" },
];

function HowItWorks() {
  return (
    <section id="how" className="bg-linen border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px] scroll-mt-[136px] lg:scroll-mt-20">
      <div className={`${WRAP} flex flex-col items-center gap-12 lg:gap-20`}>
        <div className="max-w-[700px] flex flex-col items-center">
          <Eyebrow className="text-slate">Autopilot workflow</Eyebrow>
          <h2 className={H2}>Four steps to shelf<br className="hidden sm:inline" /> dominance</h2>
        </div>
        <div className="w-full grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className={`${s.bg} border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-[30px] xl:p-[34px] xl:px-[30px] min-h-[220px] lg:min-h-[300px] flex flex-col justify-between gap-6 ${LIFT} hover:shadow-[8px_10px_0_var(--ink)]`}>
              <p className={`${SERIF} font-bold text-[96px] leading-[96px] pb-4 ${s.num}`}>{s.n}</p>
              <div className="flex flex-col gap-[6.875px]">
                <h3 className={`font-sans font-bold text-[20px] leading-[28px] ${s.fg}`}>{s.t}</h3>
                <p className={`text-[14px] leading-[22.75px] font-medium ${s.sub}`}>{s.d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------- 5b TINYFISH AGENT */

// Illustrative run (marketing copy, like the other widgets on this page) mirroring the
// real agent step sequence the product's Agent console shows.
const AGENT_STEPS = [
  { k: "session", t: "Starting browser session", d: "tf_sess_7c1e9a42" },
  { k: "navigate", t: "Opening blinkit.com", d: null },
  { k: "location", t: "Setting delivery pincode 110017", d: "Malviya Nagar, South Delhi" },
  { k: "search", t: "Searching “Amul Taaza 500 ml”", d: null },
  { k: "open", t: "Opening best match", d: "Amul Taaza Toned Fresh Milk · 500 ml" },
  { k: "extract", t: "Reading price, stock and delivery time", d: "₹29 · MRP ₹30 · In stock · 11 min" },
  { k: "checkout", t: "Computing true price at checkout", d: "Item ₹29 + handling ₹4 + delivery ₹0 = ₹33" },
  { k: "screenshot", t: "Capturing evidence screenshot", d: "Saved to the pin on your heatmap" },
  { k: "done", t: "Check complete", d: "3.2 s · no order placed" },
] as const;

const AGENT_POINTS = [
  ["Opens the real app", "A headless browser visits Blinkit, Zepto or Instamart like a shopper would."],
  ["Sets your pincode", "Every dark store has its own shelf, so each check is pinned to one delivery area."],
  ["Reads price and stock", "Listed price, MRP, availability and delivery time, straight from the page."],
  ["Finds the true price", "Walks to checkout to add handling and delivery fees. It never places an order."],
  ["Keeps a screenshot", "Every result comes with evidence you can open from the heatmap."],
] as const;

/**
 * CSS-only playback (keeps the page a server component). One 14s loop: steps light up in turn
 * (spinner → check + detail), then the result card lands; everything resets together at 94%.
 * Without motion (prefers-reduced-motion) the static styles show the finished run.
 */
const LOOP = 14;
const STEP_SPAN = 76 / AGENT_STEPS.length; // % of the loop each step takes
const pct = (n: number) => `${n.toFixed(2)}%`;
const AGENT_CSS = [
  ...AGENT_STEPS.map((_, i) => {
    const a = 3 + i * STEP_SPAN;
    const b = a + STEP_SPAN * 0.7;
    return `
@keyframes tf-row-${i}{0%,${pct(a)}{opacity:.35}${pct(a + 0.6)},94%{opacity:1}100%{opacity:.35}}
@keyframes tf-spin-${i}{0%,${pct(a)}{opacity:0}${pct(a + 0.4)},${pct(b)}{opacity:1}${pct(b + 0.4)},100%{opacity:0}}
@keyframes tf-ok-${i}{0%,${pct(b)}{opacity:0;transform:scale(.4)}${pct(b + 0.8)},94%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tf-detail-${i}{0%,${pct(b)}{opacity:0;max-height:0}${pct(b + 1)},94%{opacity:1;max-height:24px}100%{opacity:0;max-height:0}}
.tf-row-${i}{animation:tf-row-${i} ${LOOP}s linear infinite}
.tf-spin-${i}{animation:tf-spin-${i} ${LOOP}s linear infinite}
.tf-ok-${i}{animation:tf-ok-${i} ${LOOP}s cubic-bezier(.2,.9,.3,1.3) infinite}
.tf-detail-${i}{animation:tf-detail-${i} ${LOOP}s ease-out infinite}`;
  }),
  `
@keyframes tf-result{0%,80%{opacity:0;transform:translateY(12px) rotate(-1deg)}83%,94%{opacity:1;transform:none}100%{opacity:0}}
@keyframes tf-bar{0%,3%{transform:scaleX(0)}79%,94%{transform:scaleX(1)}100%{transform:scaleX(0)}}
.tf-result{animation:tf-result ${LOOP}s cubic-bezier(.22,1,.36,1) infinite}
.tf-bar{transform-origin:left;animation:tf-bar ${LOOP}s linear infinite}
@media (prefers-reduced-motion: reduce){
  [class*="tf-"]{animation:none!important}
  .tf-spin{opacity:0!important}
}`,
].join("");

function AgentConsoleMock() {
  return (
    <div className="relative">
      <div className="bg-linen border-2 border-ink rounded-[20px] shadow-[8px_8px_0_var(--ink)] overflow-hidden">
        {/* console header */}
        <div className="bg-ink flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4">
          <div className="flex items-center gap-[10px]">
            <span className="size-3 rounded-full bg-sage border border-linen/40" />
            <span className={`${SERIF} font-bold text-[18px] leading-[28px] text-linen whitespace-nowrap`}>TinyFish · agent run</span>
          </div>
          <span className="bg-sand border border-ink rounded-[6px] px-[10px] py-[3px] text-[11px] leading-[16.5px] font-extrabold tracking-[0.55px] uppercase">
            1 of 12 checks
          </span>
        </div>
        {/* address bar */}
        <div className="flex items-center gap-2 border-b-2 border-ink px-4 sm:px-6 py-3">
          <span className="flex-1 min-w-0 truncate bg-sand/40 border-2 border-ink rounded-[10px] px-3 py-[6px] text-[12px] leading-4 font-bold">
            blinkit.com/prn/amul-taaza-toned-fresh-milk
          </span>
          <span className="shrink-0 bg-slate text-linen border-2 border-ink rounded-[10px] px-[10px] py-[6px] text-[12px] leading-4 font-extrabold">110017</span>
        </div>
        <div className="h-[6px] bg-ink/10" aria-hidden>
          <div className="tf-bar h-full bg-sage" />
        </div>
        {/* step timeline */}
        <ol className="flex flex-col px-4 sm:px-6 py-4" aria-label="Agent steps">
          {AGENT_STEPS.map((s, i) => (
            <li key={s.k} className={`tf-row-${i} relative flex gap-3 pb-3 last:pb-0`}>
              {i < AGENT_STEPS.length - 1 && <span className="absolute left-[11px] top-6 bottom-0 w-[2px] bg-ink/20" aria-hidden />}
              <span className="relative grid place-items-center size-6 shrink-0" aria-hidden>
                <span className={`tf-spin tf-spin-${i} absolute inset-0 grid place-items-center rounded-full border-2 border-ink bg-sand opacity-0`}>
                  <span className="animate-spin block size-3 rounded-full border-2 border-ink border-t-transparent" />
                </span>
                <span className={`tf-ok-${i} absolute inset-0 grid place-items-center rounded-full border-2 border-ink ${s.k === "done" ? "bg-slate" : "bg-sage"}`}>
                  <Icon name="heroCheck" w={10.19} h={7.52} />
                </span>
              </span>
              <span className="min-w-0 flex flex-col">
                <span className="text-[13px] sm:text-[14px] leading-6 font-bold">{s.t}</span>
                {s.d && <span className={`tf-detail-${i} overflow-hidden text-[12px] leading-[18px] font-semibold text-ink/80 truncate`}>{s.d}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {/* result + evidence */}
      <div className="tf-result relative mt-6 lg:mt-0 lg:absolute lg:-right-6 lg:-bottom-12 w-full lg:w-[300px] bg-sand border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-[18px] flex gap-4 items-center">
        <div className="shrink-0 w-[92px] border-2 border-ink rounded-[10px] bg-linen overflow-hidden" aria-hidden>
          <div className="h-3 bg-ink flex items-center gap-[3px] px-[5px]">
            <span className="size-[4px] rounded-full bg-sand" />
            <span className="size-[4px] rounded-full bg-sage" />
            <span className="size-[4px] rounded-full bg-linen" />
          </div>
          <div className="h-3 bg-slate border-b border-ink" />
          <div className="p-[6px] flex flex-col gap-[3px]">
            <span className="h-[5px] w-[70%] rounded-full bg-ink/70" />
            <span className="h-[5px] w-[40%] rounded-full bg-ink/40" />
            <span className="mt-1 self-start rounded-[3px] bg-sage px-1 text-[7px] leading-[10px] font-extrabold">IN STOCK</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] leading-[16.5px] font-extrabold tracking-[0.55px] uppercase">True price · 110017</p>
          <p className="flex items-baseline gap-2">
            <span className="text-[14px] font-bold line-through decoration-2">₹29</span>
            <span className={`${SERIF} font-bold text-[34px] leading-[38px]`}>₹33</span>
          </p>
          <p className="text-[12px] leading-4 font-bold">+₹4 handling at checkout · screenshot saved</p>
        </div>
      </div>
    </div>
  );
}

function AgentFlow() {
  return (
    <section id="agents" className="bg-deep border-b-2 border-ink py-20 lg:pt-28 lg:pb-[130px] scroll-mt-[136px] lg:scroll-mt-20">
      <style dangerouslySetInnerHTML={{ __html: AGENT_CSS }} />
      <div className={`${WRAP} grid gap-14 lg:grid-cols-12 items-center`}>
        <div className="lg:col-span-5 flex flex-col items-start gap-6">
          <span className="bg-sand border-2 border-ink rounded-[8px] shadow-[3px_3px_0_var(--ink)] px-[14px] pt-[10.5px] pb-[7.5px] text-[12px] leading-[18px] font-extrabold tracking-[2.4px] uppercase">
            Powered by TinyFish web agents
          </span>
          <h2 className="text-linen text-[44px] leading-[50px] sm:text-[56px] sm:leading-[62px] xl:text-[64px] xl:leading-[70px]">
            An agent shops
            <span className={`block ${SERIF} italic font-normal text-sand`}>every pincode for you.</span>
          </h2>
          <p className="text-linen/90 text-[17px] leading-[28px] sm:text-[19px] sm:leading-[30px] font-medium max-w-[520px]">
            Each check is a real browser session, not a scraped feed. That is how ShelfSense sees the price a shopper actually pays.
          </p>
          <ol className="w-full flex flex-col gap-3">
            {AGENT_POINTS.map(([t, d], i) => (
              <li key={t} className="flex gap-4 items-start bg-slate border-2 border-ink rounded-[16px] shadow-[4px_4px_0_var(--ink)] p-4">
                <span className={`grid place-items-center size-9 shrink-0 rounded-[10px] border-2 border-ink bg-linen ${SERIF} font-bold text-[18px]`}>{i + 1}</span>
                <span className="flex flex-col gap-[2px]">
                  <span className="text-linen text-[16px] leading-6 font-bold">{t}</span>
                  <span className="text-linen/90 text-[14px] leading-[21px] font-medium">{d}</span>
                </span>
              </li>
            ))}
          </ol>
          <Link
            href="/agents"
            className={`flex items-center gap-2 h-14 px-[30px] rounded-[20px] border-2 border-ink bg-sand text-[17px] leading-[28px] font-bold shadow-[6px_6px_0_var(--ink)] ${PRESS} active:translate-x-1.5 active:translate-y-1.5`}
          >
            Watch agents run <Icon name="heroArrow" w={13.33} h={13.33} />
          </Link>
        </div>
        <div className="lg:col-span-7 lg:pl-6 lg:pb-12">
          <AgentConsoleMock />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- 6 MOBILE SHOWCASE */

const ALERTS = [
  { a: "Malviya Nagar", p: "₹29", tag: "OUT", dot: "border border-dashed border-ink", chip: "border border-ink" },
  { a: "Hauz Khas", p: "₹31", tag: "GAP", dot: "bg-sand border border-ink", chip: "bg-sand border border-ink" },
  { a: "Gr. Kailash", p: "₹28", tag: "STOCK", dot: "bg-sage border border-ink", chip: "bg-sage border border-ink text-linen" },
  { a: "Lajpat Nagar", p: "₹29", tag: "STOCK", dot: "bg-sage border border-ink", chip: "bg-sage border border-ink text-linen" },
];

function Phone() {
  return (
    <div className="relative z-10 w-full max-w-[360px] h-[700px] bg-ink border-2 border-ink rounded-[44px] shadow-[8px_8px_0_var(--ink)] p-[14px] flex">
      <div className="flex-1 flex flex-col overflow-hidden bg-linen border-2 border-ink rounded-[36px] p-[2px]">
        <div className="flex items-center justify-between px-6 pt-3 pb-2">
          <span className="text-[12px] leading-4 font-extrabold">9:41</span>
          <span className="h-5 w-24 rounded-full bg-ink" />
          <span className="flex items-center gap-1">
            <Icon name="mobSignal" w={9.6} h={10.33} />
            <Icon name="mobBattery" w={7.03} h={12.66} />
          </span>
        </div>
        <div className="flex-1 flex flex-col gap-4 px-5 py-2 overflow-hidden">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] leading-[15px] font-extrabold uppercase">Wednesday, 12 Aug</p>
              <p className={`${SERIF} font-bold text-[24px] leading-[32px]`}>Overview</p>
            </div>
            <span className="grid place-items-center size-9 rounded-[12px] bg-slate border border-ink text-linen text-[12px] font-bold">RS</span>
          </div>
          <div className="bg-slate border-2 border-ink rounded-[16px] shadow-[3px_3px_0_var(--ink)] px-[18px] pt-[24.5px] pb-[18px] flex flex-col gap-[6.5px]">
            <p className="text-sand text-[10px] leading-[15px] font-extrabold tracking-[0.5px] uppercase">Shelf health today</p>
            <p className="flex items-baseline gap-2 text-linen pb-[1.5px]">
              <span className="text-[30px] leading-[36px] font-extrabold">11 / 15</span>
              <span className="text-[12px] leading-4 font-bold">pincodes in stock</span>
            </p>
            <div className="h-2 rounded-full bg-deep border border-ink overflow-hidden"><div className="h-full w-[72.4%] bg-sand" /></div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 bg-sand border-2 border-ink rounded-[12px] p-[14px]">
              <p className="text-[10px] leading-[15px] font-extrabold uppercase">Out of stock</p>
              <p className="text-[20px] leading-[28px] font-extrabold">4</p>
            </div>
            <div className="flex-1 bg-linen border-2 border-ink rounded-[12px] p-[14px]">
              <p className="text-[10px] leading-[15px] font-extrabold uppercase">Price gap</p>
              <p className="text-[20px] leading-[28px] font-extrabold">2</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[11px] leading-[16.5px] font-extrabold tracking-[0.55px] uppercase">Recent alerts</p>
            <div className="flex flex-col gap-[6px]">
              {ALERTS.map((r) => (
                <div key={r.a} className="grid grid-cols-[1fr_auto_1fr] items-center bg-linen border-2 border-ink rounded-[12px] p-[10px]">
                  <span className="flex items-center gap-[6px] min-w-0">
                    <span className={`size-[10px] shrink-0 rounded-full ${r.dot}`} />
                    <span className="text-[12px] leading-4 font-bold truncate max-w-[95px]">{r.a}</span>
                  </span>
                  <span className="text-[11px] leading-4 font-bold">{r.p}</span>
                  <span className={`justify-self-end rounded-[4px] px-[7px] py-[3px] text-[9px] leading-4 font-extrabold ${r.chip}`}>{r.tag}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="h-14 shrink-0 border-t-2 border-ink flex items-center justify-around px-4">
          {([["mobTabHome", 12, 13.5, "Home"], ["mobTabHeatmap", 13.5, 13.5, "Heatmap"], ["mobTabAlerts", 12, 15, "Alerts"], ["mobTabYou", 12, 12, "You"]] as const).map(([ic, w, h, t]) => (
            <span key={t} className="flex flex-col items-center">
              <span className="h-[15px] grid place-items-center"><Icon name={ic} w={w} h={h} /></span>
              <span className={`text-[9px] leading-[13.5px] font-bold ${t === "Home" ? "text-slate" : ""}`}>{t}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const FLOAT = "bg-linen border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-[22px] flex flex-col transition-[translate,rotate,box-shadow] duration-200 hover:-translate-y-1 hover:rotate-0";
const FLOAT_LABEL = "flex items-center gap-2 text-[11px] leading-[16.5px] font-extrabold tracking-[0.55px] uppercase whitespace-nowrap";

function FloatCards() {
  return (
    <>
      <div className={`${FLOAT} gap-2 w-full lg:w-[290px] -rotate-2 lg:absolute lg:left-[44px] lg:top-[27px]`}>
        <p className={FLOAT_LABEL}><span className="size-3 rounded-full bg-linen border-2 border-dashed border-ink" />Out of stock today</p>
        <p className="text-[30px] leading-[36px] font-extrabold">4 pincodes</p>
        <div className="flex flex-col gap-2 pt-1">
          {["Malviya Nagar", "Saket"].map((a) => (
            <div key={a} className="flex items-center justify-between border-2 border-ink rounded-[12px] p-3">
              <span className="text-[12px] leading-4 font-bold">{a}</span>
              <span className="border-2 border-dashed border-ink rounded-[4px] px-[10px] py-1 text-[10px] leading-4 font-extrabold">OUT</span>
            </div>
          ))}
        </div>
      </div>
      <div className={`${FLOAT} gap-1 w-full lg:w-[290px] rotate-1 lg:absolute lg:left-[62.5px] lg:bottom-[37.5px]`}>
        <p className={FLOAT_LABEL}><span className="size-3 rounded-full bg-sand border border-ink" />Price position</p>
        <p className="pt-1 text-[30px] leading-[36px] font-extrabold">₹29 / ₹27</p>
        <p className="pb-2 text-[12px] leading-4 font-bold">cheapest rival</p>
        <div className="h-3 rounded-full bg-sand border-2 border-ink overflow-hidden"><div className="h-full w-[74%] bg-slate" /></div>
        <p className="pt-1 text-[11px] leading-[16.5px] font-bold">Zepto · updated 1h ago</p>
      </div>
      <div className={`${FLOAT} gap-1 w-full lg:w-[310px] rotate-2 lg:absolute lg:right-[45px] lg:top-[42.6px]`}>
        <p className={FLOAT_LABEL}><span className="size-3 rounded-full bg-sand border border-ink" />Awaiting approval</p>
        <p className="pt-1 text-[30px] leading-[36px] font-extrabold">₹2 price cut</p>
        <p className="text-[12px] leading-4 font-medium">Amul Taaza 500 ml · Zepto · rival 9% cheaper</p>
        {/* Static preview of the dashboard card: the real Approve / Reject live in the app. */}
        <div className="flex gap-[10px] pt-3" aria-hidden>
          <span className="flex-1 text-center bg-linen border-2 border-dashed border-ink/60 rounded-[12px] px-[14px] py-[10px] text-[12px] leading-4 font-bold text-ink/70 select-none">Reject</span>
          <span className="flex-1 text-center bg-slate/80 text-linen border-2 border-dashed border-ink/60 rounded-[12px] px-[14px] py-[10px] text-[12px] leading-4 font-bold select-none">Approve</span>
        </div>
        <Link href="/dashboard" className="pt-2 text-[12px] leading-4 font-bold underline underline-offset-4 self-start">
          Preview · see it live on the dashboard →
        </Link>
      </div>
      <div className={`${FLOAT} gap-1 w-full lg:w-[290px] -rotate-1 lg:absolute lg:right-[62.4px] lg:bottom-[45.5px]`}>
        <div className="flex items-center justify-between gap-2">
          <p className={FLOAT_LABEL}><span className="size-3 rounded-full bg-sage border border-ink" />In stock this week</p>
          <span className="bg-sage border border-ink rounded-[6px] px-[9px] py-[3px] text-linen text-[10px] leading-[15px] font-extrabold whitespace-nowrap">+2 vs last week</span>
        </div>
        <p className="pt-1 text-[30px] leading-[36px] font-extrabold">11/15</p>
        <div className="h-[52px] flex items-start justify-center pt-[6px]">
          <Icon name="mobSpark" w={175.93} h={34.67} />
        </div>
        <p className="text-[11px] leading-[16.5px] font-bold">Last 7 days</p>
      </div>
    </>
  );
}

function MobileShowcase() {
  return (
    <section id="mobile" className="bg-sage border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px] scroll-mt-[136px] lg:scroll-mt-20">
      <div className={`${WRAP} flex flex-col items-center`}>
        <div className="max-w-[760px] flex flex-col items-center">
          <Eyebrow>Live on Telegram &amp; mobile</Eyebrow>
          <h2 className={`${H2} pb-4`}>Decide in one tap,<br className="hidden sm:inline" /> wherever you are.</h2>
          <p className="text-center text-[17px] sm:text-[20px] leading-[28px] font-medium">Alerts, prices and approvals from every pincode, on your phone.</p>
        </div>
        <div className="relative w-full mt-12 lg:mt-16 lg:min-h-[760px] lg:py-[30px] flex flex-col items-center">
          <Phone />
          <div className="w-full grid gap-8 sm:grid-cols-2 mt-12 lg:mt-0 lg:contents">
            <FloatCards />
          </div>
        </div>
        <p className="mt-12 text-center text-[13px] sm:text-[16px] leading-[24px] font-extrabold tracking-[0.4px] uppercase">
          No spreadsheets · Live pincode data · Approve in one tap
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- 7 FEATURES */

const MESH_ROWS = [
  { pin: "560038", area: "Indiranagar (Dark Store #14)", tag: "in" },
  { pin: "110017", area: "Malviya Nagar", tag: "gap" },
  { pin: "110048", area: "Greater Kailash", tag: "oos" },
  { pin: "560102", area: "HSR Layout (B-05)", tag: "in" },
] as const;

function RowTag({ tag }: { tag: (typeof MESH_ROWS)[number]["tag"] }) {
  if (tag === "in")
    return (
      <span className="flex items-center gap-[6px] bg-sage border border-ink rounded-[6px] px-[11px] py-[5px] text-linen text-[12px] leading-4 font-extrabold whitespace-nowrap">
        <span className="size-[6px] rounded-full bg-linen" />In stock
      </span>
    );
  if (tag === "gap") return <span className="bg-sand border border-ink rounded-[6px] px-[11px] py-[5px] text-[12px] leading-4 font-extrabold whitespace-nowrap">₹14 Price gap</span>;
  return <span className="bg-linen border-2 border-dashed border-ink rounded-[6px] px-3 py-[6px] text-[12px] leading-4 font-extrabold whitespace-nowrap">✕ Out of stock</span>;
}

const TILE = "border-2 rounded-[20px] shadow-[6px_6px_0_rgba(0,0,0,0.4)] transition-[translate,box-shadow] duration-200 hover:-translate-x-0.5 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(0,0,0,0.45)]";
const TILE_EYEBROW = "text-[12px] leading-[18px] font-extrabold tracking-[2.4px] uppercase";
const TILE_TITLE = `${SERIF} font-bold text-[26px] leading-[32px] sm:text-[30px] sm:leading-[36px]`;

function Features() {
  return (
    <section id="features" className="bg-ink border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px] scroll-mt-[136px] lg:scroll-mt-20">
      <div className={`${WRAP} flex flex-col items-center gap-12 lg:gap-20`}>
        <div className="max-w-[700px] flex flex-col items-center">
          <Eyebrow className="text-sand">Intelligence engine</Eyebrow>
          <h2 className={`${H2} text-linen`}>Precision crafted for<br className="hidden sm:inline" /> rapid decisions</h2>
        </div>
        <div className="w-full grid gap-6 grid-cols-[minmax(0,1fr)] lg:grid-cols-12 lg:grid-rows-[282px_291.5px_auto] items-start">
          <div className={`${TILE} bg-slate border-linen p-6 sm:p-[34px] lg:col-span-6 lg:row-span-2 lg:self-stretch flex flex-col justify-between gap-10`}>
            <div className="flex flex-col gap-2 pb-6">
              <p className={`${TILE_EYEBROW} text-sand`}>Hyperlocal map</p>
              <h3 className={`${TILE_TITLE} text-linen`}>Pincode heatmap</h3>
              <p className="pt-1 text-[16px] leading-[26px] font-medium text-linen/90">Real-time shelf availability by postal code across Blinkit, Zepto, and Instamart.</p>
            </div>
            <div className="bg-deep border-2 border-ink rounded-[20px] p-3 sm:p-[18px] flex flex-col gap-3">
              {MESH_ROWS.map((r) => (
                <div key={r.pin} className="bg-slate border-2 border-ink rounded-[12px] p-[14px] flex items-center justify-between gap-3">
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="text-linen text-[14px] leading-5 font-bold">{r.pin}</span>
                    <span className="text-linen/90 text-[12px] leading-4 font-medium truncate">{r.area}</span>
                  </span>
                  <RowTag tag={r.tag} />
                </div>
              ))}
            </div>
          </div>
          <div className={`${TILE} bg-sand border-ink p-6 sm:p-[34px] lg:col-span-6 flex flex-col gap-2`}>
            <p className={TILE_EYEBROW}>Catalog monitor</p>
            <h3 className={TILE_TITLE}>Weekly changes on every site</h3>
            <p className="pt-1 text-[16px] leading-[26px] font-medium text-ink/90">Track catalog displacement, sponsored banner takeover, and bundle offers across quick commerce and marketplaces.</p>
            <div className="pt-6 flex flex-wrap gap-4">
              {([["featUptime", 14.67, 14, "bg-sage", "99.4%", "uptime"], ["featTimer", 12, 14, "bg-slate", "< 3 mins", "detection"]] as const).map(([ic, w, h, bg, v, l]) => (
                <span key={l} className="flex items-center gap-[10px] bg-linen border-2 border-ink rounded-[12px] shadow-[3px_3px_0_var(--ink)] px-[18px] py-[14px]">
                  <span className={`grid place-items-center size-7 rounded-[6px] ${bg}`}><Icon name={ic} w={w} h={h} /></span>
                  <span className="text-[18px] leading-[28px] font-extrabold">{v}</span>
                  <span className="text-[12px] leading-4 font-bold">{l}</span>
                </span>
              ))}
            </div>
          </div>
          <div className={`${TILE} bg-linen border-ink p-6 sm:p-[34px] lg:col-span-6 flex flex-col gap-2`}>
            <p className={`${TILE_EYEBROW} text-slate`}>Prescriptive engine</p>
            <h3 className={TILE_TITLE}>AI recommendations</h3>
            <p className="pt-1 text-[16px] leading-[26px] font-medium text-ink/90">Not just reports. ShelfSense generates actionable replenishment orders and margin-protecting repricing steps.</p>
            <div className="bg-sand border-2 border-ink rounded-[12px] shadow-[3px_3px_0_var(--ink)] px-[18px] pt-[26px] pb-[18px] flex gap-3 items-start">
              <span className="mt-[2px] grid place-items-center size-8 shrink-0 rounded-[8px] bg-ink"><Icon name="featQuote" w={11.33} h={8} /></span>
              <p className="text-[14px] leading-[22.75px] font-bold italic">“Increase price by ₹8 in Indiranagar; nearest rival is out of stock in dark store #41.”</p>
            </div>
          </div>
          <div className={`${TILE} bg-sage border-ink px-[26px] pt-[26px] pb-[34.5px] lg:col-span-3 flex flex-col gap-2`}>
            <span className="grid place-items-center size-12 rounded-[12px] bg-linen border-2 border-ink shadow-[3px_3px_0_var(--ink)]"><Icon name="featReceipt" w={20.05} h={22.1} /></span>
            <h4 className={`${SERIF} font-bold pt-2 text-[20px] leading-[28px]`}>True-price checks</h4>
            <p className="text-[12px] leading-[19.5px] font-bold text-ink/90">Uncovers hidden cart fees, surge costs, and actual checkout surcharges across platforms.</p>
          </div>
          <div className={`${TILE} bg-deep border-linen p-[26px] lg:col-span-3 flex flex-col gap-2`}>
            <span className="grid place-items-center size-12 rounded-[12px] bg-slate border border-linen/30"><Icon name="featSend" w={20.78} h={17.6} /></span>
            <h4 className={`${SERIF} font-bold pt-2 text-[20px] leading-[28px] text-linen`}>Telegram one-tap<br className="hidden lg:inline" /> approvals</h4>
            <p className="text-[12px] leading-[19.5px] font-medium text-linen/90">One-tap interactive bot alerts sent right to your leadership team&apos;s pocket.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- 8 PRICING */

function Check({ ink }: { ink?: boolean }) {
  return (
    <span className={`grid place-items-center size-5 shrink-0 rounded-[6px] border border-ink ${ink ? "bg-sand" : "bg-sage"}`}>
      <Icon name={ink ? "priceCheckInk" : "priceCheck"} w={8.15} h={6.01} />
    </span>
  );
}

const PLAN_BTN = `block text-center border-2 border-ink rounded-[12px] py-[18px] text-[14px] leading-5 font-extrabold ${PRESS}`;

function Pricing() {
  return (
    <section id="pricing" className="bg-linen border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px] scroll-mt-[136px] lg:scroll-mt-20">
      <div className={`${WRAP} flex flex-col items-center gap-12`}>
        <div className="max-w-[680px] flex flex-col items-center">
          <Eyebrow className="text-slate">Transparent plans</Eyebrow>
          <h2 className={H2}>Invest in visibility</h2>
        </div>
        <div className="w-full max-w-[1100px] grid gap-10 lg:gap-[23.4px] lg:grid-cols-[345fr_363fr_345fr] items-start">
          {/* Free */}
          <div className={`bg-linen border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-6 sm:p-[34px] lg:mt-[12.4px] lg:h-[496px] flex flex-col justify-between gap-[34px] ${LIFT}`}>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h3 className={`${SERIF} font-bold text-[30px] leading-[36px]`}>Free</h3>
                <p className="text-[12px] leading-4 font-bold text-ink/70">For independent solo sellers testing quick commerce.</p>
              </div>
              <p className="flex items-baseline gap-1">
                <span className={`${SERIF} font-bold text-[72px] leading-[72px]`}>₹0</span>
                <span className="text-[14px] leading-5 font-bold">/ forever</span>
              </p>
              <ul className="border-t-2 border-ink pt-[26px] flex flex-col gap-[14px]">
                {["3 products tracked", "5 pincodes coverage", "Weekly automated refresh"].map((i) => (
                  <li key={i} className="flex items-center gap-[10px] text-[12px] leading-4 font-bold"><Check />{i}</li>
                ))}
              </ul>
            </div>
            <Link href="/dashboard" className={`${PLAN_BTN} bg-linen shadow-[3px_3px_0_var(--ink)]`}>Get started free</Link>
          </div>
          {/* Pro */}
          <div className={`relative bg-slate border-2 border-ink rounded-[20px] shadow-[8px_8px_0_var(--ink)] p-6 sm:p-[34px] lg:h-[524px] flex flex-col justify-between gap-[34px] ${LIFT}`}>
            <span className="absolute left-1/2 -translate-x-1/2 -top-[20.8px] -rotate-4 bg-sand border-2 border-ink rounded-[8px] shadow-[3px_3px_0_var(--ink)] px-[18px] py-2 text-[12px] leading-4 font-extrabold tracking-[0.6px] uppercase whitespace-nowrap">
              Most popular
            </span>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h3 className={`${SERIF} font-bold text-[30px] leading-[36px] text-linen`}>Pro</h3>
                <p className="text-[12px] leading-4 font-medium text-linen/90">High-velocity D2C brands expanding regional distribution.</p>
              </div>
              <p className="flex items-baseline gap-1">
                <span className={`${SERIF} font-bold text-[72px] leading-[72px] text-sand`}>₹999</span>
                <span className="text-[14px] leading-5 font-bold text-linen">/ month</span>
              </p>
              <ul className="border-t-2 border-linen/30 pt-[26px] flex flex-col gap-[14px]">
                {["25 products tracked", "100 pincodes live mesh", "Fast refresh (every 30 mins)", "Telegram autopilot & approvals"].map((i) => (
                  <li key={i} className="flex items-center gap-[10px] text-[12px] leading-4 font-bold text-linen"><Check ink />{i}</li>
                ))}
              </ul>
            </div>
            <Link href="/settings#plan" className={`${PLAN_BTN} bg-sand shadow-[6px_6px_0_var(--ink)]`}>Try Pro (test mode)</Link>
          </div>
          {/* Brand */}
          <div className={`bg-sand border-2 border-ink rounded-[20px] shadow-[6px_6px_0_var(--ink)] p-6 sm:p-[34px] lg:mt-[12.4px] lg:h-[496px] flex flex-col justify-between gap-2 ${LIFT}`}>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h3 className={`${SERIF} font-bold text-[30px] leading-[36px]`}>Brand</h3>
                <p className="text-[12px] leading-4 font-bold text-ink/80">Enterprise FMCG manufacturers and national distributors.</p>
              </div>
              <p className={`${SERIF} font-bold text-[64px] leading-[64px]`}>Custom</p>
              <ul className="border-t-2 border-ink pt-[26px] flex flex-col gap-[14px]">
                {["Unlimited products", "City-wide dark store coverage", "Custom distributor reports & ERP API", "Dedicated account engineer"].map((i) => (
                  <li key={i} className="flex items-center gap-[10px] text-[12px] leading-4 font-bold"><Check />{i}</li>
                ))}
              </ul>
            </div>
            <Link href="/settings#plan" className={`${PLAN_BTN} bg-linen shadow-[3px_3px_0_var(--ink)] mt-8 lg:mt-0`}>Try Brand (test mode)</Link>
          </div>
        </div>
        <p className="text-[12px] leading-4 font-bold text-center">Prices are illustrative. Plans switch instantly in test mode and no payment is taken.</p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- 9 CLOSING BAND */

function Closing() {
  return (
    <section data-mochi="closing" className="bg-sand border-b-2 border-ink py-20 lg:pt-28 lg:pb-[114px]">
      <div className="mx-auto max-w-[880px] px-4 sm:px-5 flex flex-col items-center gap-6 text-center">
        <h2 className="text-[44px] leading-[50px] sm:text-[64px] sm:leading-[70px] lg:text-[80px] lg:leading-[84px]">
          “Others show the listed price.
          <span className="block">
            <span className={`${SERIF} italic font-normal text-slate`}>We show the real one.</span>”
          </span>
        </h2>
        <p className="max-w-[540px] text-[17px] sm:text-[20px] leading-[28px] font-medium">
          Stop losing sales to silent dark store stock-outs. Deploy ShelfSense in 2 minutes.
        </p>
        <div className="pt-4">
          <Link href="/dashboard" className={`flex items-center gap-2 h-14 px-[42px] rounded-[20px] border-2 border-ink bg-slate text-linen text-[18px] leading-[28px] font-bold shadow-[6px_6px_0_var(--ink)] ${PRESS} active:translate-x-1.5 active:translate-y-1.5`}>
            Get started now <Icon name="closeArrow" w={13.33} h={13.33} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- 10 FOOTER */

function Footer() {
  return (
    <footer className="bg-ink py-12">
      <div className={`${WRAP} flex flex-col gap-6 md:flex-row md:items-center md:justify-between`}>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {([["Terms of Service", "/help#terms"], ["Privacy Policy", "/help#privacy"], ["Security", "/help#security"]] as const).map(([t, href]) => (
            <Link key={t} href={href} className="text-[14px] leading-5 font-bold text-linen/90 hover:text-linen">{t}</Link>
          ))}
        </div>
        <p className="text-[14px] leading-5 font-bold text-sand">Built by Team CodeCrunchers · USICT, GGSIPU</p>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <div className="overflow-x-clip">
      <Navbar />
      <main>
        <Hero />
        <Marquee />
        <Problem />
        <HowItWorks />
        <AgentFlow />
        <MobileShowcase />
        <Features />
        <Pricing />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
