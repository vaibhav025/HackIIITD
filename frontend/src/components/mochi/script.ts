/**
 * Everything Mochi v2 says, in one editable file: the opening intro, the guided tour, page
 * intros, greetings, reactions and menu labels. Page-by-page tips for "What's on this page?"
 * stay in ./messages.ts.
 *
 * Tone: friendly, short, a little playful. Light Hinglish only where natural.
 */
import type { Expression } from "./expressions";

/* ===================================================================== Intro */

export interface IntroChoice {
  id: "tour" | "solo" | "explain";
  label: string;
}
export interface IntroBeat {
  id: string;
  mood: Expression;
  gesture?: "wave";
  text: string | ((name: string | null) => string);
  input?: { placeholder: string; max: number; submit: string; skip: string };
  choices?: IntroChoice[];
}

export const INTRO: IntroBeat[] = [
  { id: "hello", mood: "excited", gesture: "wave", text: "Hey! Welcome to ShelfSense! I'm Mochi 💚" },
  {
    id: "what",
    mood: "happy",
    text: "I keep an eye on your price and stock in every pincode — Blinkit, Zepto, Instamart and more. No more refreshing 40 apps!",
  },
  {
    id: "name",
    mood: "curious",
    text: "Before we start… what should I call you?",
    input: { placeholder: "Your name", max: 24, submit: "Continue", skip: "Skip" },
  },
  {
    id: "nice",
    mood: "love",
    text: (name) => (name ? `Nice to meet you, ${name}! ✨` : "A mystery seller, huh? I like it 😎"),
  },
  {
    id: "goal",
    mood: "happy",
    text: "So, what would you like to do?",
    choices: [
      { id: "tour", label: "Show me around! (about 2 min)" },
      { id: "solo", label: "I know my way — just help when I'm stuck" },
      { id: "explain", label: "Wait, what is ShelfSense exactly?" },
    ],
  },
];

/** Played after "Wait, what is ShelfSense exactly?", then back to the "goal" beat. */
export const INTRO_EXPLAIN: { mood: Expression; text: string }[] = [
  { mood: "thinking", text: "Okay, quick version!" },
  {
    mood: "happy",
    text: "Real browser agents shop your product pincode by pincode, like a customer would. So you see the true price and stock shoppers see.",
  },
  {
    mood: "excited",
    text: "Then I suggest fixes — reprice, restock, chase a rival — and you approve them here or on Telegram. Simple!",
  },
];

export const INTRO_OUTRO: Record<"tour" | "solo" | "skipped", { mood: Expression; text: string }> = {
  tour: { mood: "excited", text: "Yay! Follow me ✨" },
  solo: { mood: "wink", text: "Got it, boss. I'll chill in the corner — tap me (or press ?) whenever you need me." },
  skipped: { mood: "happy", text: "No problem! I'm right here if you need me." }, // companion bubble after Esc
};

/* ====================================================================== Tour */

export type Chapter = "welcome" | "dashboard" | "products" | "product" | "heatmap" | "agents" | "settings" | "help";
export const CHAPTERS: Chapter[] = ["welcome", "dashboard", "products", "product", "heatmap", "agents", "settings", "help"];
/** Shown next to the progress pips ("Dashboard · 3/5"). */
export const CHAPTER_NAMES: Record<Chapter, string> = {
  welcome: "Welcome",
  dashboard: "Dashboard",
  products: "Products",
  product: "Product",
  heatmap: "Heatmap",
  agents: "Agents",
  settings: "Settings",
  help: "Help",
};

export interface TourCtx {
  productId: string | null;
  name: string | null;
  mobile: boolean;
}

export interface TourStep {
  id: string;
  chapter: Chapter;
  /** Where the step lives. */
  route: RegExp;
  /** Where to navigate if not there (null = skip the chapter). */
  href: string | ((c: TourCtx) => string | null);
  /** Selectors tried in order; omitted = centre stage. */
  target?: string | string[];
  /** Secondary ring (page tour). */
  point?: string | null;
  desktopOnly?: boolean;
  text: string | ((c: TourCtx) => string);
  /** Default "idle" (talking overlays). */
  mood?: Expression;
  /** Default "Next". */
  nextLabel?: string;
  /** E.g. capture the first product id. */
  onNext?: (c: TourCtx) => Partial<TourCtx> | "skip-chapter" | void;
  /** Spotlight padding, default 8. */
  pad?: number;
  /** Final step: centre stage with Finish / Restart choices. */
  finale?: boolean;
}

const LANDING = /^\/$/;
const DASHBOARD = /^\/dashboard\/?$/;
const PRODUCTS = /^\/products\/?$/;
const PRODUCT = /^\/products\/[^/]+\/?$/;
const HEATMAP = /^\/heatmap\/?$/;
const AGENTS = /^\/agents\/?$/;
const SETTINGS = /^\/settings\/?$/;
const HELP = /^\/help\/?$/;

const productHref = (c: TourCtx) => (c.productId ? `/products/${c.productId}` : null);
const heatmapHref = (c: TourCtx) => (c.productId ? `/heatmap?product=${c.productId}` : "/heatmap");

/** First product link in the products list (the visible one: table on desktop, cards on phones). */
function firstProductId(): string | null {
  const links = document.querySelectorAll<HTMLAnchorElement>('[data-mochi="products-list"] a[href^="/products/"]:not([href*="/telegram"])');
  for (const a of Array.from(links)) {
    const r = a.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const id = a.getAttribute("href")?.split(/[/?#]/)[2];
    if (id) return id;
  }
  return null;
}

/** Agents page: is the run list a column beside the player (wide screens), or stacked above it? */
function runListBeside(c: TourCtx): boolean {
  const list = document.querySelector('[data-mochi="agents-runlist"]');
  const replay = document.querySelector('[data-mochi="agents-replay"]');
  if (!list || !replay) return !c.mobile;
  const a = list.getBoundingClientRect();
  const b = replay.getBoundingClientRect();
  if (!a.width || !b.width) return !c.mobile;
  return b.left >= a.right - 1;
}

export const TOUR: TourStep[] = [
  { id: "land-hero", chapter: "welcome", route: LANDING, href: "/", target: '[data-mochi="hero"]', mood: "excited",
    text: "This is ShelfSense: your price and stock, in every pincode, on every quick-commerce app. All in one place." },
  { id: "land-problem", chapter: "welcome", route: LANDING, href: "/", target: "#problem", mood: "worried",
    text: "Here's the scary bit: your listing looks fine from the office, but the dark store 4 km away is empty. Customers just… leave." },
  { id: "land-how", chapter: "welcome", route: LANDING, href: "/", target: "#how", mood: "happy",
    text: "The fix is four steps: add a product, agents check pincodes, read the heatmap, approve the fixes." },
  { id: "land-agents", chapter: "welcome", route: LANDING, href: "/", target: "#agents", mood: "curious",
    text: "These are real browser agents. They shop like a customer, so the price you see is the real checkout price." },
  { id: "land-cta", chapter: "welcome", route: LANDING, href: "/", target: ['[data-mochi="closing"]', '[data-mochi="hero-cta"]'], mood: "excited",
    text: "Enough talk — let's open the dashboard. Demo data is already loaded!", nextLabel: "Open dashboard →" },

  { id: "dash-greeting", chapter: "dashboard", route: DASHBOARD, href: "/dashboard", target: '[data-mochi="dash-greeting"]', mood: "happy",
    text: (c) => `Welcome to your dashboard${c.name ? `, ${c.name}` : ""}! Anything urgent floats to the top right here.` },
  { id: "dash-tiles", chapter: "dashboard", route: DASHBOARD, href: "/dashboard", target: '[data-mochi="dash-tiles"]', mood: "curious",
    text: "Your vitals: plan usage, out-of-stock pincodes, how often you beat rivals on price, and approvals this week." },
  { id: "dash-recs", chapter: "dashboard", route: DASHBOARD, href: "/dashboard", target: '[data-mochi="dash-recs"]', mood: "excited",
    text: "My favourite part — recommendations! Approve one and watch me do a happy dance 💃" },
  { id: "dash-plan", chapter: "dashboard", route: DASHBOARD, href: "/dashboard", target: '[data-mochi="dash-plan"]', mood: "happy",
    text: "Approved steps land in your Action plan. Tick them off as you go." },
  { id: "dash-nav", chapter: "dashboard", route: DASHBOARD, href: "/dashboard", target: 'nav[aria-label="Main"] a[data-nav-href="/products"]', desktopOnly: true, mood: "wink",
    text: "All your products live here. Chalo, let's go!", nextLabel: "Go to Products →" },

  { id: "prod-head", chapter: "products", route: PRODUCTS, href: "/products", target: '[data-mochi="products-head"]', mood: "happy",
    text: "Every product you track. “Add product” starts tracking a new one in under a minute." },
  { id: "prod-list", chapter: "products", route: PRODUCTS, href: "/products", target: ['[data-mochi="products-list"]', '[data-mochi="products-toolbar"]'], mood: "curious",
    text: "Click any product to see its full report. I'll open the first one for you.", nextLabel: "Open it →",
    onNext: () => {
      const id = firstProductId();
      return id ? { productId: id } : "skip-chapter";
    } },

  { id: "p-kpis", chapter: "product", route: PRODUCT, href: productHref, target: '[data-mochi="product-kpis"]', mood: "happy",
    text: "Your price, the cheapest rival, stock and rating — each with a 7-day trend." },
  { id: "p-recheck", chapter: "product", route: PRODUCT, href: productHref, target: '[data-mochi="recheck"]', mood: "excited",
    text: "“Re-check now” sends the agents out right away. I get a little nervous waiting 😅" },
  { id: "p-recs", chapter: "product", route: PRODUCT, href: productHref, target: '[data-mochi="product-recs"]', mood: "love",
    text: "Recommendations for just this product. Approve, dismiss, or send to Telegram — your call." },
  { id: "p-plan", chapter: "product", route: PRODUCT, href: productHref, target: ['[data-mochi="product-plan"]', '[data-mochi="product-guardrails"]'], mood: "happy",
    text: "Approved ideas become steps here. And relax — I never suggest a price below your safe floor." },
  { id: "p-tabs", chapter: "product", route: PRODUCT, href: productHref, target: 'nav[aria-label="Product sections"]', mood: "curious",
    text: "Each product has tabs: Heatmap, Telegram and Settings. Let's see the heatmap!", nextLabel: "Show heatmap →" },

  { id: "hm-map", chapter: "heatmap", route: HEATMAP, href: heatmapHref, target: '[data-mochi="heatmap-map"]', mood: "excited",
    text: "The heatmap! Every pin is a pincode. Green = in stock, dashed = out of stock, ₹ = price gap." },
  { id: "hm-filters", chapter: "heatmap", route: HEATMAP, href: heatmapHref, target: '[data-mochi="heatmap-filters"]', mood: "happy",
    text: "Switch region and app here to change what the map shows." },
  { id: "hm-snapshot", chapter: "heatmap", route: HEATMAP, href: heatmapHref, target: '[data-mochi="heatmap-snapshot"]', mood: "curious",
    text: "Pick some pins, then “Re-check selected” sends agents to just those. Snapshots show earlier checks.", nextLabel: "Meet the agents →" },

  { id: "ag-runs", chapter: "agents", route: AGENTS, href: "/agents", target: ['[data-mochi="agents-runlist"]', '[data-mochi="agents-runs"]'], mood: "happy",
    text: (c) => `Agent HQ! Every check is a real browser session. Pick a run ${runListBeside(c) ? "on the left" : "below"} to watch it.` },
  { id: "ag-replay", chapter: "agents", route: AGENTS, href: "/agents", target: ['[data-mochi="agents-player"]', '[data-mochi="agents-replay"]'], mood: "excited",
    text: "Live runs stream here, and finished ones replay step by step. Like a cricket highlight reel 🏏", nextLabel: "Settings →" },

  { id: "set-telegram", chapter: "settings", route: SETTINGS, href: "/settings", target: "#telegram", mood: "excited",
    text: "Connect Telegram and approve fixes from your phone in one tap. Highly recommended!" },
  { id: "set-plan", chapter: "settings", route: SETTINGS, href: "/settings", target: "#plan", mood: "wink",
    text: "Your plan lives here. In test mode, plans switch instantly — no payment taken.", nextLabel: "Last stop →" },

  { id: "help-ask", chapter: "help", route: HELP, href: "/help", target: '[data-mochi="help-ask"]', mood: "happy",
    text: "Stuck? Ask anything here — or just tap me and choose “Ask Mochi”." },
  { id: "finale", chapter: "help", route: HELP, href: "/help", mood: "celebrate", finale: true,
    text: (c) => `That's the whole tour${c.name ? `, ${c.name}` : ""}! You're officially a ShelfSense pro 🎉` },
];

/** If the tour starts anywhere but the landing page, it begins here. */
export const TOUR_APP_START = "dash-greeting";

export const FINALE_CHOICES = [
  { id: "finish", label: "Finish" },
  { id: "restart", label: "Restart tour" },
] as const;

export const TOUR_LINES = {
  walking: "One sec, walking over…",
  missing: "Hmm, this bit isn't here right now — moving on!",
  noProducts: "No products yet — let's peek at the heatmap instead!",
  dimClick: "Psst, over here!",
  pause: "Paused. Tap me to resume!",
  skip: "Okay! I'll be in the corner if you need me.",
  modalWait: "I'll wait here!",
  modalBack: "Where were we? Ah, yes!",
  resume: (n: number, total: number) => `Want to continue the tour? You're on step ${n} of ${total}.`, // buttons: Continue / Later
  detour: "Taking a detour? Tap me to resume the tour anytime.",
  /** Reaction when the user approves / finishes something mid-tour (the "happy dance"). */
  dance: ["Woohoo! 💃", "Happy dance! 💃✨", "Yesss! That's the spirit 🎉"],
};

/* =========================================================== Page intros */

/** First visit to each route (companion bubble). Keys are normalised route patterns. */
export const PAGE_INTROS: Record<string, { text: string | ((name: string | null) => string); mood: Expression }> = {
  "/": { text: "Welcome to ShelfSense! Scroll down — I'll pop in with the good parts.", mood: "excited" },
  "/dashboard": { text: (name) => `Hey${name ? ` ${name}` : ""}! This is your dashboard. Urgent stuff floats to the top.`, mood: "happy" },
  "/products": { text: "All your tracked products. Click one to open its full report.", mood: "curious" },
  "/products/:id": { text: "This product's full report: prices, stock, rivals and what to do next.", mood: "curious" },
  "/products/:id/settings": { text: "Product settings. The guardrails here keep my suggestions safe.", mood: "wink" },
  "/products/:id/telegram": { text: "Five quick steps to get this product's alerts on Telegram.", mood: "excited" },
  "/heatmap": { text: "The heatmap! Every pin is a pincode. Tap one to peek inside.", mood: "excited" },
  "/agents": { text: "Agent HQ. Watch real browser sessions live, or replay old ones.", mood: "curious" },
  "/alerts": { text: "Your alerts inbox. Stock-outs and price moves land here.", mood: "worried" },
  "/settings": { text: "Account settings: plan, Telegram, notifications and more.", mood: "happy" },
  "/help": { text: "Help Centre! Ask anything here — or just ask me 😉", mood: "wink" },
};

/** Landing page: one short line the first time each section scrolls into view. */
export const LANDING_SECTIONS: { selector: string; key: string; mood: Expression; text: string }[] = [
  { selector: "#problem", key: "/#problem", mood: "worried", text: "This is the scary bit: one empty dark store, and shoppers just leave. 😟" },
  { selector: "#how", key: "/#how", mood: "happy", text: "Four steps, start to finish. Step 4 is my favourite — approving fixes!" },
  { selector: "#agents", key: "/#agents", mood: "curious", text: "These are the agents I send out. They shop like real customers 🕵️" },
  { selector: '[data-mochi="closing"]', key: "/#closing", mood: "excited", text: "Ready? The demo data is already loaded — hop in!" },
];

/** "/products/abc/settings" → "/products/:id/settings". */
export function routeKey(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  const m = p.match(/^\/products\/([^/]+)(\/.*)?$/);
  if (m) return `/products/:id${m[2] ?? ""}`;
  return p;
}

/* ===================================================== Greetings and idle */

export const GREETINGS = {
  returning: (name: string | null, hour: number) => {
    const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    return `${part}${name ? `, ${name}` : ""}! Ready to check your shelves? 🛒`;
  },
  wake: "Huh? Oh! I'm awake, I'm awake! 😳",
  pet: "Hehe, that tickles!",
  dragFirst: "Wheee!",
  hidden: "Bye for now! Tap the tab to bring me back.",
  quietOn: "Shh… I'll only talk when you ask. 🤫",
  quietOff: "I'm back to chatting! 💬",
};

/* ============================================================== Reactions */

export const REACTIONS = {
  toastSuccess: ["Nice! ✨", "Done and dusted!", "Ooh, look at you go!", "Saved! High five 🙌"],
  /** First match wins, tested on the toast message. */
  toastError: [
    [/credit|budget/i, "That check needs more credits than you have left. Try fewer pincodes, or peek at your plan in Settings."],
    [/network|fetch|reach|offline|timed? ?out/i, "Looks like I lost the server. Check your internet, then try again."],
    [/telegram|chat/i, "Telegram didn't go through. Is a chat linked? The product's Telegram tab sets it up."],
    [/guardrail|floor|margin/i, "That would break your price guardrails. You can adjust the safe floor in the product's Settings."],
    [/already/i, "Someone already decided that one — maybe from Telegram?"],
  ] as [RegExp, string][],
  toastErrorDefault: "Oops, that didn't work. Want to ask me about it?", // + "Ask Mochi" button
  askAbout: (message: string) => `Why did I get: "${message}"?`,
  runStart: (total?: number) => `Agents are out shopping${total ? ` in ${total} checks` : ""}… 🛒 I'll tell you when they're back.`,
  runDone: "They're back! Fresh prices and stock are in. 🎉",
  runPartial: (failed: number, total: number) => `Done! ${failed} of ${total} checks failed, but the rest is fresh.`,
  runFailed: "The check didn't finish. Try “Re-check now” again in a minute?",
  runFirst: "First result's in! The agents are on a roll 🛍️",
  runHalf: (done: number, total: number) => `Halfway there — ${done} of ${total} checks done!`,
  runOos: "Uh-oh, an agent found a pincode that's out of stock. I'll have the full picture soon.",
  recApprove: "Approved! Added to your Action plan 💚",
  recDismiss: "Dismissed. Your call, boss 😉",
  recDone: "Step done! One less thing to worry about.",
  recTelegram: "Sent to Telegram! Check your phone 📱",
  recReopen: "Back on the list! Let's give it another look.",
  tourMissing: "Hmm, this bit isn't here right now — moving on!",
  chatThinking: "Hmm, let me think…",
  chatError: "I couldn't reach my brain just now. Try again, or open the Help Centre?",
  chatNoAi: "My AI brain isn't switched on for this server yet. The Help Centre topics still work!", // on 503 / integration error
  chatSuggestions: ["Why is my product out of stock?", "How do I connect Telegram?", "What does the safe floor mean?"],
  chatContinue: "Continue in Help Centre →",
  chatPlaceholder: "Ask me anything…",
  chatHello: "Ask me anything about your products, pincodes or plan!",
};

export const MENU = {
  tour: "Take the tour",
  resume: (n: number, t: number) => `Resume tour (${n}/${t})`,
  replay: "Replay the tour",
  page: "What's on this page?",
  ask: "Ask Mochi",
  quiet: (on: boolean) => `Quiet mode: ${on ? "On" : "Off"}`,
  move: (side: "left" | "right") => `Move to ${side === "right" ? "left" : "right"} side`,
  hide: "Hide Mochi",
  intro: "Replay intro",
  /** Spoken narration (Web Speech API). */
  speech: (on: boolean) => `Voice: ${on ? "On" : "Off"}`,
  title: "Mochi",
};

export const ACTIONS = {
  showMe: "Show me",
  later: "Later",
  ask: "Ask Mochi",
  continue: "Continue",
  resume: "Resume",
};
