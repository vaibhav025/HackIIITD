/**
 * Mochi's per-page tips, used by "What's on this page?" (the page tour). Edit freely.
 * Intro, tour, reactions and menu copy live in ./script.ts.
 *
 * Each tip belongs to a route (regex on the pathname) and to a section on that page (a CSS
 * selector) that the page tour spotlights, in the order listed here — so keep each route's tips in
 * the same order as the sections appear on the page.
 *
 * - `text` can be a plain string or a function of the page's already-loaded data (`ctx.data(key)`
 *   reads the SWR cache for that API path, it never fetches). Return null to skip the tip.
 * - `point` is a selector (or a function returning one) for an element the page tour rings with a
 *   second, dashed highlight while Mochi talks about the section.
 *
 * Section hooks are `data-mochi="…"` attributes or existing ids in the page components.
 */
import type { Alert, Dashboard, Me, Overview, ProductCard } from "@/lib/types";

type AlertList = { items: Alert[]; unread: number };

export interface MochiCtx {
  pathname: string;
  /** Product id on /products/[id]/… routes. */
  productId?: string;
  /** Data the page already fetched (SWR cache), or undefined while it loads. */
  data: <T>(key: string) => T | undefined;
}

type Dyn<T> = T | ((ctx: MochiCtx) => T);

export interface MochiTip {
  id: string;
  route: RegExp;
  section?: string;
  point?: Dyn<string | null | undefined>;
  text: Dyn<string | null>;
}

const LANDING = /^\/$/;
const DASHBOARD = /^\/dashboard\/?$/;
const PRODUCTS = /^\/products\/?$/;
const PRODUCT = /^\/products\/[^/]+\/?$/;
const PRODUCT_SETTINGS = /^\/products\/[^/]+\/settings\/?$/;
const PRODUCT_TELEGRAM = /^\/products\/[^/]+\/telegram\/?$/;
const HEATMAP = /^\/(heatmap|products\/[^/]+\/heatmap)\/?$/;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const MOCHI_TIPS: MochiTip[] = [
  /* ---------------------------------------------------------------- Landing */
  {
    id: "hero",
    route: LANDING,
    section: '[data-mochi="hero"]',
    point: '[data-mochi="hero-cta"]',
    text: "ShelfSense checks your price and stock in every pincode. “Map my product” opens the demo dashboard.",
  },
  {
    id: "problem",
    route: LANDING,
    section: "#problem",
    text: "From your office a listing can look in stock while the dark store 4 km away is empty. That's the blind spot.",
  },
  {
    id: "how",
    route: LANDING,
    section: "#how",
    text: "Four steps: add a product, agents check every pincode, read the heatmap, then approve fixes on Telegram.",
  },
  {
    id: "agents",
    route: LANDING,
    section: "#agents",
    text: "Every check is a real browser session run by a TinyFish agent, so you see the price a shopper actually pays.",
  },
  {
    id: "mobile",
    route: LANDING,
    section: "#mobile",
    text: "Alerts and approvals arrive on Telegram. You can say yes from your phone in one tap.",
  },
  {
    id: "features",
    route: LANDING,
    section: "#features",
    text: "The engine: a pincode heatmap, rival price tracking, and repricing steps that protect your margin.",
  },
  {
    id: "pricing",
    route: LANDING,
    section: "#pricing",
    point: '#pricing a[href="/settings#plan"]',
    text: "Free tracks 3 products. Pro and Brand switch on instantly in test mode, and no payment is taken.",
  },
  {
    id: "closing",
    route: LANDING,
    section: '[data-mochi="closing"]',
    point: '[data-mochi="closing"] a[href="/dashboard"]',
    text: "Ready? “Get started now” opens the dashboard with demo data loaded.",
  },

  /* -------------------------------------------------------------- Dashboard */
  {
    id: "dash-greeting",
    route: DASHBOARD,
    section: '[data-mochi="dash-greeting"]',
    point: (c) => (c.data<ProductCard[]>("/products")?.length === 0 ? '[data-mochi="add-product"]' : null),
    text: (c) => {
      const products = c.data<ProductCard[]>("/products");
      if (products && products.length === 0) return "No products yet. Click “Add product” and I'll help you track your first one.";
      return "This is your daily overview. Anything that needs attention shows up here first.";
    },
  },
  {
    id: "dash-tiles",
    route: DASHBOARD,
    section: '[data-mochi="dash-tiles"]',
    text: "These tiles are your vitals: plan usage, out-of-stock pincodes, how often you're cheaper than rivals, and approvals this week.",
  },
  {
    id: "dash-products",
    route: DASHBOARD,
    section: '[data-mochi="dash-products"]',
    point: '[data-mochi="dash-products"] [aria-label="Filter products"] button:nth-child(2)',
    text: "Your products at a glance. Filter by “Needs attention” to see stock-outs and price gaps first.",
  },
  {
    id: "dash-actions",
    route: DASHBOARD,
    section: '[data-mochi="dash-recs"]',
    point: (c) => (c.data<Dashboard>("/dashboard")?.recommendations.length ? '[data-mochi="dash-recs"] > .card' : null),
    text: (c) => {
      const n = c.data<Dashboard>("/dashboard")?.recommendations.length;
      if (n) return `You have ${plural(n, "recommendation")} waiting. Approve or Dismiss each one right here.`;
      return "Recommended actions appear here after each check. Nothing is waiting right now.";
    },
  },
  {
    id: "dash-plan",
    route: DASHBOARD,
    section: '[data-mochi="dash-plan"]',
    text: "Approved steps land in the Action plan. Mark each one done once you've acted on it.",
  },
  {
    id: "dash-telegram",
    route: DASHBOARD,
    section: '[data-mochi="dash-telegram"]',
    point: '[data-mochi="dash-telegram"] .btn',
    text: (c) => {
      const products = c.data<ProductCard[]>("/products");
      if (!products?.length) return "Connect Telegram to get alerts and approve actions from your phone.";
      const on = products.filter((p) => p.telegram_connected).length;
      if (on === products.length) return "All your products send alerts to Telegram. Nice!";
      return `${on} of ${plural(products.length, "product")} send alerts to Telegram. Connect the rest to approve from your phone.`;
    },
  },

  /* --------------------------------------------------------------- Products */
  {
    id: "products-head",
    route: PRODUCTS,
    section: '[data-mochi="products-head"]',
    point: (c) => (c.data<ProductCard[]>("/products")?.length === 0 ? '[data-mochi="add-product"]' : null),
    text: (c) => {
      const products = c.data<ProductCard[]>("/products");
      if (products && products.length === 0)
        return "No products yet. Click “Add product”, give it a search query and pick the pincodes you sell in.";
      return "Every product you track lives here. “Add product” starts tracking a new one.";
    },
  },
  {
    id: "products-toolbar",
    route: PRODUCTS,
    section: '[data-mochi="products-toolbar"]',
    text: "Filter by status, change the sort order, or switch between List and Grid. Click any product to open it.",
  },

  /* -------------------------------------------------------- Product overview */
  {
    id: "product-kpis",
    route: PRODUCT,
    section: '[data-mochi="product-kpis"]',
    point: '[data-mochi="recheck"]',
    text: "Your price, the cheapest rival, stock and rating, each with a 7-day trend. “Re-check now” fetches fresh data.",
  },
  {
    id: "product-recs",
    route: PRODUCT,
    section: '[data-mochi="product-recs"]',
    point: (c) => {
      const o = c.data<Overview>(`/products/${c.productId}/overview`);
      return o?.recommendations.some((r) => r.status === "pending") ? '[data-mochi="product-recs"] > .card' : null;
    },
    text: (c) => {
      const o = c.data<Overview>(`/products/${c.productId}/overview`);
      const n = o?.recommendations.filter((r) => r.status === "pending").length ?? 0;
      if (n) return `${plural(n, "recommendation")} for this product. Approve it, dismiss it, or send it to Telegram.`;
      return "Recommendations for this product appear here. “Refresh” asks for a new set.";
    },
  },
  {
    id: "product-plan",
    route: PRODUCT,
    section: '[data-mochi="product-plan"]',
    text: "Approved recommendations become steps in this Action plan.",
  },
  {
    id: "product-guardrails",
    route: PRODUCT,
    section: '[data-mochi="product-guardrails"]',
    point: 'nav[aria-label="Product sections"] a[href$="/settings"]',
    text: "Recommendations never break these price guardrails. Change the floor and margin in the Settings tab.",
  },
  {
    id: "product-competitors",
    route: PRODUCT,
    section: '[data-mochi="product-competitors"]',
    text: "Compare your price and stock with each rival, platform by platform.",
  },

  /* ---------------------------------------------------------------- Heatmap */
  {
    id: "heatmap-filters",
    route: HEATMAP,
    section: '[data-mochi="heatmap-filters"]',
    text: "Pick the region and app here to change what the map shows.",
  },
  {
    id: "heatmap-map",
    route: HEATMAP,
    section: '[data-mochi="heatmap-map"]',
    point: '[data-mochi="recheck"]',
    text: "Each pin is a pincode: green means in stock, dashed means out of stock, ₹ means a price gap. Need fresh data? Hit “Re-check now”.",
  },
  {
    id: "heatmap-snapshot",
    route: HEATMAP,
    section: '[data-mochi="heatmap-snapshot"]',
    text: "Tap a pin to select it, then “Re-check selected” sends agents to just those pincodes. The snapshot tabs show earlier checks.",
  },

  /* ----------------------------------------------------------------- Agents */
  {
    id: "agents-head",
    route: /^\/agents\/?$/,
    section: '[data-mochi="agents-head"]',
    text: "Every quick-commerce check is a real TinyFish agent session. The tiles show the credits you've used.",
  },
  {
    id: "agents-runs",
    route: /^\/agents\/?$/,
    section: '[data-mochi="agents-runs"]',
    text: "Pick a run on the left to watch it. Live runs stream here, and finished runs replay step by step.",
  },

  /* ----------------------------------------------------------------- Alerts */
  {
    id: "alerts-head",
    route: /^\/alerts\/?$/,
    section: '[data-mochi="alerts-head"]',
    text: (c) => {
      const unread = c.data<AlertList>("/me/alerts?limit=200")?.unread;
      if (unread) return `${plural(unread, "unread alert")} in your inbox. Use the Unread filter to see only those.`;
      return "Your alerts inbox: stock-outs, price moves and rival changes from every check.";
    },
  },
  {
    id: "alerts-inbox",
    route: /^\/alerts\/?$/,
    section: '[data-mochi="alerts-inbox"]',
    text: "Open the product from any alert, or mark it read once you've handled it.",
  },

  /* --------------------------------------------------------------- Settings */
  {
    id: "settings-plan",
    route: /^\/settings\/?$/,
    section: "#plan",
    text: (c) => {
      const plan = c.data<Me>("/me")?.plan;
      return `${plan ? `You're on the ${plan} plan. ` : ""}Plans switch instantly in test mode, and no payment is taken.`;
    },
  },
  {
    id: "settings-telegram",
    route: /^\/settings\/?$/,
    section: "#telegram",
    point: "#telegram a.btn-primary",
    text: "Connect Telegram to get alerts and approve actions from your phone.",
  },

  /* ------------------------------------------------------- Product settings */
  {
    id: "ps-pincodes",
    route: PRODUCT_SETTINGS,
    section: "#pincodes",
    text: "Choose which apps and pincodes get checked. More pincodes means more credits per re-check.",
  },
  {
    id: "ps-rules",
    route: PRODUCT_SETTINGS,
    section: "#rules",
    text: "Write an alert rule in plain English, like “alert me if a rival drops below ₹50”. Changes save right away.",
  },
  {
    id: "ps-sensitivity",
    route: PRODUCT_SETTINGS,
    section: '[data-mochi="price-sensitivity"]',
    point: '[data-mochi="price-sensitivity"]',
    text: "Price sensitivity sets how big a rival gap must be before I suggest a price change. Staples react to small gaps.",
  },
  {
    id: "ps-floor",
    route: PRODUCT_SETTINGS,
    section: '[data-mochi="safe-floor"]',
    point: '[data-mochi="safe-floor"]',
    text: "The safe floor is the lowest price ShelfSense will ever suggest: your floor or break-even plus margin, whichever is higher.",
  },

  /* --------------------------------------------------------------- Telegram */
  {
    id: "tg-steps",
    route: PRODUCT_TELEGRAM,
    section: '[data-mochi="tg-steps"]',
    text: "Five quick steps: choose a chat, get a code, send it to the bot, pick your alerts, then send a test.",
  },

  /* ------------------------------------------------------------------- Help */
  {
    id: "help-ask",
    route: /^\/help\/?$/,
    section: '[data-mochi="help-ask"]',
    point: '[data-mochi="help-ask"] input',
    text: "Ask anything here: your products, your plan or Telegram.",
  },
  {
    id: "help-suggested",
    route: /^\/help\/?$/,
    section: '[data-mochi="help-suggested"]',
    text: "Not sure what to ask? Tap a suggested question.",
  },
  {
    id: "help-chat",
    route: /^\/help\/?$/,
    section: '[data-mochi="help-chat"]',
    text: "Answers appear in this chat. “Answering about” narrows them to one product.",
  },
  {
    id: "help-topics",
    route: /^\/help\/?$/,
    section: '[data-mochi="help-topics"]',
    text: "Help topics cover each feature step by step.",
  },
];
