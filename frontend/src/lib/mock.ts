/**
 * Hard-coded demo backend. While NEXT_PUBLIC_MOCK_MODE is not "false" every `/api` call is answered
 * here instead of over the network, so the whole app can be shown without the FastAPI server.
 * Data mirrors backend/scripts/seed.py (Riya Store, South Delhi pincodes) and
 * backend/data/demo_results.json; shapes follow ./types.ts. State lives in memory and resets on reload.
 */
import type {
  ActionItem,
  Alert,
  AlertRule,
  AgentStep,
  AppStatus,
  CheckResultDetail,
  Competitor,
  CompetitorRow,
  Conversation,
  ChatMessage,
  Dashboard,
  HelpTopic,
  Me,
  Overview,
  PinDetail,
  PinStatus,
  Pincode,
  Plans,
  Product,
  ProductCard,
  Recommendation,
  Reviews,
  RunDetail,
  RunEvent,
  RunResultRef,
  RunSummary,
  TelegramStatus,
  UserSettings,
  Weekly,
} from "./types";

export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_MODE !== "false";

export interface MockResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

// ---- Helpers ------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(Date.now() - ms);

/** Deterministic 0..1 from a string, so the same pin always shows the same numbers. */
function rand(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}
const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

// ---- Catalogue ----------------------------------------------------------------------------------

const PINCODES: Pincode[] = [
  ["110001", "Connaught Place", 28.6315, 77.2167],
  ["110003", "Lodhi Road", 28.5914, 77.2277],
  ["110005", "Karol Bagh", 28.651, 77.19],
  ["110007", "Civil Lines", 28.6769, 77.2256],
  ["110008", "Rajinder Nagar", 28.641, 77.1845],
  ["110014", "Jangpura", 28.5783, 77.2457],
  ["110015", "Kirti Nagar", 28.6531, 77.1424],
  ["110016", "Hauz Khas", 28.5494, 77.2001],
  ["110017", "Saket", 28.5245, 77.2066],
  ["110018", "Janakpuri", 28.6219, 77.0878],
  ["110019", "Kalkaji", 28.5416, 77.26],
  ["110020", "Okhla Industrial Area", 28.5355, 77.271],
  ["110021", "Anand Niketan", 28.5694, 77.1709],
  ["110022", "R K Puram", 28.5677, 77.178],
  ["110023", "Sarojini Nagar", 28.5755, 77.1968],
  ["110024", "Lajpat Nagar", 28.5677, 77.2432],
  ["110025", "Jamia Nagar", 28.561, 77.278],
  ["110028", "Naraina", 28.619, 77.139],
  ["110029", "Safdarjung Enclave", 28.5597, 77.1962],
  ["110030", "Mehrauli", 28.52, 77.1855],
  ["110048", "Greater Kailash", 28.549, 77.2426],
  ["110049", "Gulmohar Park", 28.5598, 77.2143],
  ["110057", "Vasant Vihar", 28.5589, 77.1577],
  ["110060", "Patel Nagar", 28.6519, 77.1642],
  ["110065", "East of Kailash", 28.5572, 77.2521],
].map(([code, area_name, lat, lng]) => ({ code: code as string, area_name: area_name as string, city: "Delhi", lat: lat as number, lng: lng as number }));
const PIN = new Map(PINCODES.map((p) => [p.code, p]));

const PLATFORMS = ["blinkit", "zepto", "instamart", "amazon", "flipkart"];
const AGENT_PLATFORMS = new Set(["zepto", "instamart", "blinkit"]);
const SCREENSHOTS: Record<string, string[]> = {
  zepto: ["/mock/zepto_110016_ca7023b6.jpg", "/mock/zepto_110017_5811def6.jpg", "/mock/zepto_110048_2b647b8e.jpg"],
  instamart: ["/mock/instamart_110016_a411fc1a.jpg", "/mock/instamart_110017_4614353b.jpg", "/mock/instamart_110048_847e1017.jpg"],
};

const SOUTH_DELHI = ["110003", "110014", "110016", "110017", "110019", "110024", "110029", "110048", "110049", "110057", "110065", "110021"];

interface Seed {
  product: Product;
  pincodes: string[];
  platforms: string[];
  /** Typical selling price the generator wobbles around. */
  base: number;
  /** Pins forced out of stock: `${platform}:${pincode}`. */
  oos: Set<string>;
  /** Pins where we're priced well above rivals. */
  gap: Set<string>;
  listings: Record<string, string | null>;
}

function makeProduct(id: string, p: Partial<Product> & Pick<Product, "name" | "brand">, createdDaysAgo: number): Product {
  return {
    id,
    user_id: "u-riya",
    search_query: p.name,
    image_url: null,
    cost_price: null,
    min_margin_pct: 8,
    max_change_pct: 10,
    floor_price: null,
    commission_pct: null,
    mrp: null,
    price_sensitivity: "regular",
    round_to_price_point: false,
    check_frequency: "6h",
    volatile_boost: false,
    approval_required: true,
    paused: false,
    created_at: ago(createdDaysAgo * DAY),
    ...p,
  };
}

const seeds: Seed[] = [
  {
    product: makeProduct("p-amul", { name: "Amul Taaza Toned Milk 500 ml", brand: "Amul", cost_price: 24, floor_price: 26, mrp: 30, commission_pct: 6, price_sensitivity: "essential", check_frequency: "3h", volatile_boost: true }, 21),
    pincodes: SOUTH_DELHI,
    platforms: ["zepto", "instamart"],
    base: 29,
    oos: new Set(["zepto:110017", "zepto:110019", "zepto:110048", "zepto:110049"]),
    gap: new Set(["instamart:110065"]),
    listings: { zepto: "https://www.zeptonow.com/pn/amul-taaza-toned-fresh-milk/pvid/amul-taaza-500", instamart: "https://www.swiggy.com/instamart/item/amul-taaza-500ml" },
  },
  {
    product: makeProduct("p-haldiram", { name: "Haldiram Bhujia 200 g", brand: "Haldiram", cost_price: 40, floor_price: 47, mrp: 55, commission_pct: 8, round_to_price_point: true }, 18),
    pincodes: SOUTH_DELHI.slice(0, 10),
    platforms: ["zepto", "instamart"],
    base: 52,
    oos: new Set(["instamart:110024"]),
    gap: new Set(["zepto:110016", "zepto:110029", "instamart:110003"]),
    listings: { zepto: "https://www.zeptonow.com/pn/haldiram-bhujia-200g", instamart: null },
  },
  {
    product: makeProduct("p-paperboat", { name: "Paper Boat Aamras 250 ml", brand: "Paper Boat", cost_price: 26, floor_price: 31, mrp: 40, price_sensitivity: "premium", check_frequency: "12h" }, 12),
    pincodes: SOUTH_DELHI.slice(0, 8),
    platforms: ["zepto", "instamart"],
    base: 38,
    oos: new Set(),
    gap: new Set(),
    listings: { zepto: null, instamart: "https://www.swiggy.com/instamart/item/paper-boat-aamras" },
  },
  {
    product: makeProduct("p-boat", { name: "boAt Airdopes 141", brand: "boAt", cost_price: 610, floor_price: 699, mrp: 3990, commission_pct: 12, check_frequency: "daily" }, 9),
    pincodes: ["110016", "110017", "110048", "110024", "110065", "110003"],
    platforms: ["amazon", "flipkart"],
    base: 849,
    oos: new Set(["flipkart:110016", "flipkart:110017", "flipkart:110048"]),
    gap: new Set(["amazon:110024"]),
    listings: { amazon: "https://www.amazon.in/dp/B09N3ZNHTY", flipkart: "https://www.flipkart.com/boat-airdopes-141/p/itm6d5a7d7b3d1c1" },
  },
];

const competitors: Competitor[] = [
  { id: "c-amul-1", product_id: "p-amul", name: "Mother Dairy Toned Milk 500 ml", platform: "zepto", url: null, search_query: "mother dairy toned milk", confirmed: true },
  { id: "c-amul-2", product_id: "p-amul", name: "Amul Gold Full Cream 500 ml", platform: "instamart", url: null, search_query: "amul gold 500ml", confirmed: true },
  { id: "c-amul-3", product_id: "p-amul", name: "Country Delight Cow Milk 450 ml", platform: "zepto", url: null, search_query: "country delight milk", confirmed: false },
  { id: "c-haldiram-1", product_id: "p-haldiram", name: "Bikaji Bhujia 200 g", platform: "zepto", url: null, search_query: "bikaji bhujia 200g", confirmed: true },
  { id: "c-haldiram-2", product_id: "p-haldiram", name: "Balaji Ratlami Sev 200 g", platform: "instamart", url: null, search_query: "balaji sev", confirmed: true },
  { id: "c-paperboat-1", product_id: "p-paperboat", name: "Maaza Mango Drink 250 ml", platform: "zepto", url: null, search_query: "maaza 250ml", confirmed: true },
  { id: "c-paperboat-2", product_id: "p-paperboat", name: "Frooti Mango 250 ml", platform: "instamart", url: null, search_query: "frooti 250ml", confirmed: true },
  { id: "c-boat-1", product_id: "p-boat", name: "Noise Buds VS104", platform: "amazon", url: null, search_query: "noise buds vs104", confirmed: true },
  { id: "c-boat-2", product_id: "p-boat", name: "realme Buds T110", platform: "flipkart", url: null, search_query: "realme buds t110", confirmed: true },
];

const telegram: Record<string, TelegramStatus["links"]> = {
  "p-amul": [{ id: "tl-1", chat_id: "-100482771", chat_title: "Riya Store Ops", alert_types: null, briefing_time: "09:00", connected_at: ago(15 * DAY) }],
  "p-haldiram": [{ id: "tl-2", chat_id: "58213907", chat_title: "Riya Sharma", alert_types: ["oos_any", "price_gap_pct"], briefing_time: "08:30", connected_at: ago(10 * DAY) }],
};
const pendingCodes = new Map<string, string>();

const alertRules: Record<string, AlertRule[]> = {};
const defaultRules = (): AlertRule[] => [
  { kind: "oos_any", threshold: null, rule_text: "Any pin is out of stock", rule_json: {}, active: true },
  { kind: "price_change_pct", threshold: 10, rule_text: "A rival changes price by 10% or more", rule_json: {}, active: true },
  { kind: "rating_below", threshold: 4, rule_text: "Rating drops below 4.0", rule_json: {}, active: true },
  { kind: "price_gap_pct", threshold: 5, rule_text: "I'm 5% or more above the cheapest rival", rule_json: {}, active: false },
];

let me: Me = {
  profile: {
    id: "u-riya",
    name: "Riya Sharma",
    email: "riya@riyastore.in",
    business_name: "Riya Store",
    business_type: "marketplace_seller",
    language: "en",
    timezone: "Asia/Kolkata",
    default_city: "Delhi",
    created_at: ago(30 * DAY),
  },
  plan: "pro",
  usage: { products: 0, pincodes: 0, checks_this_week: 0 },
};
let settings: UserSettings = {
  briefing_time: "09:00",
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  default_thresholds: { price_gap_pct: 5 },
  channels: { telegram: true, email: false },
};

// ---- Check results ------------------------------------------------------------------------------

/** When the newest scheduled check ran; a mock "Re-check now" moves it forward. */
const lastRunAt: Record<string, number> = {};
const lastCheck = (pid: string) => lastRunAt[pid] ?? Date.now() - (pid === "p-boat" ? 5 : 1.4) * HOUR;

interface Obs {
  in_stock: boolean;
  price: number;
  rival_price: number;
  mrp: number;
  eta: number;
  rating: number;
  status: PinStatus;
  checked_at: string;
}

/** One check of our product (rival === null) or a competitor at a pin; `sample` 0 = latest. */
function observe(seed: Seed, platform: string, pincode: string, sample = 0, rival: string | null = null): Obs {
  const key = `${seed.product.id}:${platform}:${pincode}:${sample}`;
  const r = rand(key);
  const pinKey = `${platform}:${pincode}`;
  const forcedOos = sample < 2 && seed.oos.has(pinKey);
  const gap = seed.gap.has(pinKey);
  const price = round(seed.base * (0.97 + r * 0.06) * (gap ? 1.09 : 1), seed.base > 200 ? 0 : 0);
  const rivalPrice = round(seed.base * (0.99 + rand(key + "r") * 0.06), 0);
  const mrp = seed.product.mrp ?? round(seed.base * 1.2);
  const checked = lastCheck(seed.product.id) - sample * 6 * HOUR;
  const in_stock = rival ? rand(key + rival) > 0.12 : !forcedOos && r > 0.04;
  const status: PinStatus = !in_stock ? "out_of_stock" : !rival && price >= rivalPrice * 1.05 ? "price_gap" : "in_stock";
  const amazonish = platform === "amazon" || platform === "flipkart";
  return {
    in_stock,
    price: rival ? round(rivalPrice * (0.98 + rand(key + rival + "p") * 0.06)) : price,
    rival_price: rivalPrice,
    mrp,
    eta: amazonish ? 1440 + Math.round(r * 1440) : 8 + Math.round(r * 18),
    rating: round(3.9 + rand(key + "rt") * 0.8, 1),
    status,
    checked_at: iso(checked),
  };
}

const seedOf = (id: string) => seeds.find((s) => s.product.id === id);
const rivalsOf = (pid: string, platform?: string) =>
  competitors.filter((c) => c.product_id === pid && c.confirmed && (!platform || c.platform === platform));

const SEVERITY: Record<string, number> = { out_of_stock: 3, price_gap: 2, stale: 1, in_stock: 0 };

function productCard(seed: Seed): ProductCard {
  const p = seed.product;
  const pairs = seed.platforms.flatMap((platform) => seed.pincodes.map((pincode) => ({ platform, pincode, o: observe(seed, platform, pincode) })));
  const count = (s: PinStatus) => pairs.filter((x) => x.o.status === s).length;
  const avgOwn = pairs.reduce((a, x) => a + x.o.price, 0) / pairs.length;
  const avgRival = pairs.reduce((a, x) => a + x.o.rival_price, 0) / pairs.length;
  const oos = count("out_of_stock");
  const gap = count("price_gap");
  const strip = [...pairs].sort((a, b) => SEVERITY[b.o.status] - SEVERITY[a.o.status]).slice(0, 12);
  return {
    ...p,
    status_strip: strip.map((x) => ({ platform: x.platform, pincode: x.pincode, status: x.o.status })),
    price_position_vs_avg_rival: round(((avgOwn - avgRival) / avgRival) * 100, 1),
    last_checked: iso(lastCheck(p.id)),
    telegram_connected: (telegram[p.id]?.length ?? 0) > 0,
    total_pairs: pairs.length,
    ok_pairs: count("in_stock"),
    oos_pairs: oos,
    gap_pairs: gap,
    stale_pairs: 0,
    state: p.paused ? "paused" : oos || gap ? "attention" : "ok",
  };
}

// ---- Heatmap ------------------------------------------------------------------------------------

const SNAPSHOT_SAMPLE: Record<string, number> = { now: 0, "6h": 1, "24h": 4, "7d": 28 };

function heatmap(seed: Seed, platform: string | null, snapshot: string) {
  const sample = SNAPSHOT_SAMPLE[snapshot] ?? 0;
  const platforms = platform ? [platform] : seed.platforms;
  const pins = seed.pincodes.map((code) => {
    const obs = platforms.map((pl) => ({ pl, o: observe(seed, pl, code, sample) }));
    const worst = obs.sort((a, b) => SEVERITY[b.o.status] - SEVERITY[a.o.status])[0];
    const pin = PIN.get(code)!;
    return {
      pincode: code,
      area: pin.area_name,
      lat: pin.lat,
      lng: pin.lng,
      status: worst.o.status,
      price: worst.o.price,
      rival_price: worst.o.rival_price,
      mrp: worst.o.mrp,
      eta: worst.o.eta,
      checked_at: worst.o.checked_at,
      platform: worst.pl,
      stale_reason: null,
    };
  });
  const n = (s: PinStatus) => pins.filter((p) => p.status === s).length;
  const oosPins = pins.filter((p) => p.status === "out_of_stock");
  const hot_zones =
    oosPins.length >= 3
      ? [{ lat: oosPins.reduce((a, p) => a + p.lat, 0) / oosPins.length, lng: oosPins.reduce((a, p) => a + p.lng, 0) / oosPins.length, count: oosPins.length, pincodes: oosPins.map((p) => p.pincode) }]
      : [];
  return {
    pins,
    summary: { in_stock: n("in_stock"), out_of_stock: n("out_of_stock"), price_gap: n("price_gap"), stale: 0, failed: 0, unavailable: 0, total: pins.length },
    hot_zones,
    platform,
    snapshot,
    unavailable_platforms: [],
  };
}

function pinDetail(seed: Seed, code: string, platform: string | null): PinDetail {
  const pin = PIN.get(code)!;
  const runId = latestRunId(seed.product.id);
  return {
    pincode: code,
    area: pin.area_name,
    city: pin.city,
    lat: pin.lat,
    lng: pin.lng,
    platforms: (platform ? [platform] : seed.platforms).map((pl) => {
      const o = observe(seed, pl, code);
      return {
        platform: pl,
        status: o.status,
        seller: {
          in_stock: o.in_stock,
          price: o.price,
          mrp: o.mrp,
          eta: o.eta,
          rating: o.rating,
          status: "ok",
          checked_at: o.checked_at,
          run_id: runId,
          screenshot_url: screenshotFor(pl, code),
          result_id: resultId(runId, pl, code, null),
        },
        rivals: rivalsOf(seed.product.id, pl).map((c) => {
          const ro = observe(seed, pl, code, 0, c.id);
          return {
            competitor_id: c.id,
            name: c.name,
            in_stock: ro.in_stock,
            price: ro.price,
            mrp: ro.mrp,
            eta: ro.eta,
            rating: round(ro.rating - 0.1, 1),
            status: "ok",
            checked_at: ro.checked_at,
            result_id: resultId(runId, pl, code, c.id),
            run_id: runId,
          };
        }),
      };
    }),
  };
}

function screenshotFor(platform: string, pincode: string) {
  const list = SCREENSHOTS[platform];
  return list ? list[Math.floor(rand(platform + pincode) * list.length)] : null;
}

// ---- Product insights ---------------------------------------------------------------------------

function spark(seed: Seed, fn: (o: Obs[]) => number | null) {
  return Array.from({ length: 14 }, (_, i) => {
    const sample = 13 - i;
    const obs = seed.platforms.flatMap((pl) => seed.pincodes.map((c) => observe(seed, pl, c, sample)));
    return fn(obs);
  });
}
const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null);

const summaries: Record<string, string> = {
  "p-amul": "Amul Taaza is out of stock on Zepto across a tight South Delhi cluster (Saket, Kalkaji, Greater Kailash, Gulmohar Park) for the last two checks, while Mother Dairy stays in stock there. Instamart coverage is healthy; East of Kailash is ~9% above the cheapest rival.",
  "p-haldiram": "Haldiram Bhujia is in stock almost everywhere, but you're priced 8–10% above Bikaji on Zepto in Hauz Khas and Safdarjung Enclave. Lajpat Nagar on Instamart went out of stock this morning.",
  "p-paperboat": "Paper Boat Aamras is fully in stock across all 8 tracked pincodes on both apps. Prices are steady and in line with Maaza and Frooti; no action needed this week.",
  "p-boat": "Flipkart shows boAt Airdopes 141 as sold out in Hauz Khas, Saket and Greater Kailash while Amazon is in stock at ₹849. realme Buds T110 is undercutting you by about ₹50 on Flipkart.",
};

function recsFor(pid: string): (Recommendation & { product_name: string | null })[] {
  return recommendations.filter((r) => r.product_id === pid);
}

const recommendations: (Recommendation & { product_name: string | null })[] = [
  { id: "r-1", product_id: "p-amul", product_name: "Amul Taaza Toned Milk 500 ml", priority: "high", action_text: "Restock Zepto dark stores serving Saket, Kalkaji, GK and Gulmohar Park", impact_text: "4 pincodes out of stock for 12h+ — roughly 18% of your Zepto reach", evidence: { kind: "restock", pincodes: ["110017", "110019", "110048", "110049"] }, status: "pending", created_at: ago(1.3 * HOUR) },
  { id: "r-2", product_id: "p-amul", product_name: "Amul Taaza Toned Milk 500 ml", priority: "medium", action_text: "Hold price at ₹29 on Instamart in East of Kailash instead of matching ₹27", impact_text: "Matching would cut margin below your 8% floor", evidence: { kind: "margin_risk", safe_floor: 28.5 }, status: "pending", created_at: ago(1.3 * HOUR) },
  { id: "r-3", product_id: "p-haldiram", product_name: "Haldiram Bhujia 200 g", priority: "high", action_text: "Drop Zepto price to ₹49 in Hauz Khas and Safdarjung Enclave", impact_text: "Closes a 9% gap to Bikaji while staying above your ₹47 floor", evidence: { kind: "price_match", target_price: 49 }, status: "pending", created_at: ago(2 * HOUR) },
  { id: "r-4", product_id: "p-haldiram", product_name: "Haldiram Bhujia 200 g", priority: "low", action_text: "Ask Instamart to restock Lajpat Nagar", impact_text: "1 pincode out of stock since this morning", evidence: { kind: "restock" }, status: "pending", created_at: ago(2 * HOUR) },
  { id: "r-5", product_id: "p-boat", product_name: "boAt Airdopes 141", priority: "high", action_text: "Replenish Flipkart inventory for South Delhi", impact_text: "Sold out in 3 of 6 pincodes while Amazon is in stock", evidence: { kind: "restock" }, status: "pending", created_at: ago(5 * HOUR) },
  { id: "r-6", product_id: "p-boat", product_name: "boAt Airdopes 141", priority: "medium", action_text: "Run a ₹50 coupon on Amazon in Lajpat Nagar", impact_text: "Noise Buds VS104 is 6% cheaper there", evidence: { kind: "price_match", target_price: 799 }, status: "pending", created_at: ago(5 * HOUR) },
];

const actions: ActionItem[] = [
  { id: "r-0a", product_id: "p-haldiram", product_name: "Haldiram Bhujia 200 g", priority: "medium", action_text: "Set Instamart price to ₹52 across South Delhi", impact_text: "Matches Bikaji without breaking your floor", status: "approved", created_at: ago(2 * DAY), decided_at: ago(1.8 * DAY), decided_via: "web", kind: "price_match", action_item: "Change Instamart price to ₹52 in the seller portal", effect: "action_created", run_id: null, target_price: 52, done_at: null, evidence: { kind: "price_match" } },
  { id: "r-0b", product_id: "p-amul", product_name: "Amul Taaza Toned Milk 500 ml", priority: "high", action_text: "Hold price above ₹28.50 in East of Kailash", impact_text: "Protects your 8% minimum margin", status: "approved", created_at: ago(1 * DAY), decided_at: ago(0.9 * DAY), decided_via: "telegram", kind: "margin_risk", action_item: "Keep the Instamart price at ₹29", effect: "action_created", run_id: null, target_price: 29, done_at: null, evidence: { kind: "margin_risk", safe_floor: 28.5 } },
  { id: "r-0c", product_id: "p-paperboat", product_name: "Paper Boat Aamras 250 ml", priority: "low", action_text: "Re-check Paper Boat after the Zepto listing fix", impact_text: "Confirms the new listing is live", status: "done", created_at: ago(4 * DAY), decided_at: ago(3.8 * DAY), decided_via: "web", kind: "recheck", action_item: "Re-check now", effect: "run_started", run_id: "run-p-paperboat-3", target_price: null, done_at: ago(3.5 * DAY), evidence: {} },
];

const alerts: Alert[] = [
  { id: "a-1", product_id: "p-amul", product_name: "Amul Taaza Toned Milk 500 ml", kind: "oos_area", message: "Out of stock on Zepto in 4 South Delhi pincodes: Saket, Kalkaji, Greater Kailash, Gulmohar Park", evidence: { pincodes: ["110017", "110019", "110048", "110049"], platform: "zepto" }, created_at: ago(1.2 * HOUR), read: false, sent_telegram: true },
  { id: "a-2", product_id: "p-haldiram", product_name: "Haldiram Bhujia 200 g", kind: "price_gap_pct", message: "You're 9.4% above Bikaji Bhujia on Zepto in Hauz Khas (₹55 vs ₹50)", evidence: { pincode: "110016", platform: "zepto" }, created_at: ago(2.1 * HOUR), read: false, sent_telegram: true },
  { id: "a-3", product_id: "p-boat", product_name: "boAt Airdopes 141", kind: "oos_any", message: "Sold out on Flipkart in Hauz Khas, Saket and Greater Kailash", evidence: { platform: "flipkart" }, created_at: ago(5 * HOUR), read: false },
  { id: "a-4", product_id: "p-boat", product_name: "boAt Airdopes 141", kind: "price_change_pct", message: "realme Buds T110 dropped 11% on Flipkart (₹899 → ₹799)", evidence: { platform: "flipkart" }, created_at: ago(9 * HOUR), read: true },
  { id: "a-5", product_id: "p-haldiram", product_name: "Haldiram Bhujia 200 g", kind: "oos_any", message: "Out of stock on Instamart in Lajpat Nagar", evidence: { pincode: "110024", platform: "instamart" }, created_at: ago(14 * HOUR), read: true, sent_telegram: true },
  { id: "a-6", product_id: "p-paperboat", product_name: "Paper Boat Aamras 250 ml", kind: "rival_oos", message: "Maaza Mango Drink is out of stock on Zepto in Jangpura — a chance to win the shelf", evidence: { pincode: "110014", platform: "zepto" }, created_at: ago(26 * HOUR), read: true },
];

// ---- Runs ---------------------------------------------------------------------------------------

interface MockRun {
  id: string;
  product_id: string;
  trigger: string;
  startedAt: number;
  jobs: { platform: string; pincode: string; competitor_id: string | null; competitor_name: string | null }[];
  /** Live runs finish job i at startedAt + finishAt[i]; past runs are already done. */
  finishAt: number[] | null;
  live: boolean;
}

const runs: MockRun[] = [];
let runCounter = 0;

function jobsFor(seed: Seed, pincodes?: string[], platforms?: string[]) {
  const pins = pincodes?.length ? pincodes.filter((c) => seed.pincodes.includes(c)) : seed.pincodes;
  const pls = platforms?.length ? platforms.filter((p) => seed.platforms.includes(p)) : seed.platforms;
  return pls.flatMap((platform) =>
    pins.flatMap((pincode) => [
      { platform, pincode, competitor_id: null, competitor_name: null },
      ...rivalsOf(seed.product.id, platform).map((c) => ({ platform, pincode, competitor_id: c.id, competitor_name: c.name })),
    ]),
  );
}

for (const seed of seeds) {
  for (let i = 0; i < 4; i++) {
    runs.push({
      id: `run-${seed.product.id}-${i}`,
      product_id: seed.product.id,
      trigger: i === 0 ? "manual" : "scheduled",
      startedAt: lastCheck(seed.product.id) - i * 6 * HOUR - 3 * 60_000,
      jobs: jobsFor(seed),
      finishAt: null,
      live: false,
    });
  }
}

const latestRunId = (pid: string) => runs.filter((r) => r.product_id === pid).sort((a, b) => b.startedAt - a.startedAt)[0]?.id ?? null;
const resultId = (runId: string | null, platform: string, pincode: string, rival: string | null) =>
  `cr~${runId ?? "none"}~${platform}~${pincode}~${rival ?? "own"}`;

/** Job timing for a live run: up to `CONCURRENCY` agents at once, whole run ≈ 20–30 s. */
const CONCURRENCY = 6;
function scheduleJobs(count: number) {
  const rounds = Math.ceil(count / CONCURRENCY);
  const per = Math.min(3500, Math.max(1800, 26_000 / rounds));
  return Array.from({ length: count }, (_, i) => Math.floor(i / CONCURRENCY) * per + per * (0.75 + rand(String(i)) * 0.25));
}

function runStatus(run: MockRun, now = Date.now()) {
  if (!run.finishAt) return { status: "done", done: run.jobs.length };
  const done = run.finishAt.filter((t) => run.startedAt + t <= now).length;
  return { status: done >= run.jobs.length ? "done" : "running", done };
}

function runResult(run: MockRun, i: number): RunResultRef {
  const j = run.jobs[i];
  const seed = seedOf(run.product_id)!;
  const sample = run.live ? 0 : Math.max(0, runs.filter((r) => r.product_id === run.product_id && r.startedAt > run.startedAt).length);
  const o = observe(seed, j.platform, j.pincode, sample, j.competitor_id);
  const agent = AGENT_PLATFORMS.has(j.platform);
  return {
    id: resultId(run.id, j.platform, j.pincode, j.competitor_id),
    job_key: `${j.platform}:${j.pincode}:${j.competitor_id || "own"}`,
    platform: j.platform,
    pincode: j.pincode,
    competitor_id: j.competitor_id,
    status: "ok",
    price: o.price,
    in_stock: o.in_stock,
    mrp: o.mrp,
    eta_minutes: o.eta,
    area: PIN.get(j.pincode)?.area_name ?? null,
    screenshot_url: agent ? screenshotFor(j.platform, j.pincode) : null,
    checked_at: iso(run.startedAt + (run.finishAt?.[i] ?? 90_000)),
    method: agent ? "agent" : "fetch",
    pincode_specific: agent,
    exact_match: true,
    step_count: agent ? 7 : 2,
  };
}

function runDetail(run: MockRun): RunDetail {
  const { status, done } = runStatus(run);
  const finished = run.finishAt ? run.jobs.map((_, i) => i).filter((i) => run.startedAt + run.finishAt![i] <= Date.now()) : run.jobs.map((_, i) => i);
  const credits = run.jobs.filter((j, i) => finished.includes(i) && AGENT_PLATFORMS.has(j.platform)).length;
  return {
    id: run.id,
    product_id: run.product_id,
    trigger: run.trigger,
    status,
    total_jobs: run.jobs.length,
    done_jobs: done,
    failed_jobs: 0,
    credits_used: credits,
    started_at: iso(run.startedAt),
    finished_at: status === "done" ? iso(run.startedAt + (run.finishAt ? Math.max(...run.finishAt) : 3 * 60_000)) : null,
    mode: "live",
    results: finished.map((i) => runResult(run, i)),
  };
}

const runSummary = (run: MockRun): RunSummary => {
  const detail: RunDetail = runDetail(run);
  delete detail.results;
  return { ...detail, product_name: seedOf(run.product_id)?.product.name ?? null };
};

function agentSteps(platform: string, pincode: string, name: string, start: number, total: number): AgentStep[] {
  const area = PIN.get(pincode)?.area_name ?? pincode;
  const label = platformName(platform);
  const raw: [string, string, string | null][] = AGENT_PLATFORMS.has(platform)
    ? [
        ["session", "Started browser session", "Chromium · India egress"],
        ["navigate", `Opened ${label}`, null],
        ["location", `Set delivery location to ${pincode}`, `${area}, Delhi`],
        ["search", `Searched for "${name}"`, null],
        ["open", "Opened the best matching listing", name],
        ["extract", "Read price, stock and delivery time", null],
        ["screenshot", "Captured evidence screenshot", null],
        ["done", "Check complete", null],
      ]
    : [
        ["navigate", `Fetched ${label} product page`, null],
        ["extract", "Parsed price and availability", null],
        ["done", "Check complete", null],
      ];
  return raw.map(([kind, lbl, detail], i) => ({
    index: i + 1,
    kind,
    label: lbl,
    detail,
    at: iso(start + (total * (i + 1)) / raw.length),
    ms: Math.round(total / raw.length),
  }));
}

function platformName(p: string) {
  return { blinkit: "Blinkit", zepto: "Zepto", instamart: "Swiggy Instamart", amazon: "Amazon.in", flipkart: "Flipkart" }[p] ?? p;
}

function jobName(run: MockRun, i: number) {
  return run.jobs[i].competitor_name ?? seedOf(run.product_id)!.product.name;
}

/** The SSE stream a live run would emit, with absolute timestamps (ms since epoch). */
export function mockRunEvents(runId: string): { at: number; event: RunEvent }[] {
  const run = runs.find((r) => r.id === runId);
  if (!run) return [];
  const out: { at: number; event: RunEvent }[] = [
    { at: run.startedAt + 200, event: { type: "run_started", run_id: run.id, total_jobs: run.jobs.length, mode: "live", concurrency: CONCURRENCY } },
  ];
  const finishAt = run.finishAt ?? run.jobs.map((_, i) => 1000 + i * 50);
  run.jobs.forEach((job, i) => {
    const end = run.startedAt + finishAt[i];
    const slot = Math.floor(i / CONCURRENCY);
    const begin = slot === 0 ? run.startedAt + 400 : run.startedAt + finishAt[i - CONCURRENCY] + 100;
    const job_key = `${job.platform}:${job.pincode}:${job.competitor_id || "own"}`;
    out.push({ at: begin, event: { type: "job_started", run_id: run.id, job_key, job, session_id: `tf_${(rand(job_key + run.id) * 1e9).toFixed(0)}`, goal: `Find "${jobName(run, i)}" on ${platformName(job.platform)} for pincode ${job.pincode}` } });
    for (const step of agentSteps(job.platform, job.pincode, jobName(run, i), begin, end - begin - 150)) {
      out.push({ at: Date.parse(step.at), event: { type: "agent_step", run_id: run.id, job_key, step } });
    }
    const r = runResult(run, i);
    out.push({
      at: end,
      event: {
        type: "result",
        run_id: run.id,
        job_key,
        result: { ...r, rating: 4.2, ms: end - begin, credits: AGENT_PLATFORMS.has(job.platform) ? 1 : 0 },
        true_price: truePrice(r),
      },
    });
  });
  const credits = run.jobs.filter((j) => AGENT_PLATFORMS.has(j.platform)).length;
  out.push({ at: run.startedAt + Math.max(...finishAt) + 300, event: { type: "run_done", run_id: run.id, status: "done", total_jobs: run.jobs.length, done_jobs: run.jobs.length, failed_jobs: 0, credits_used: credits } });
  return out.sort((a, b) => a.at - b.at);
}

function truePrice(r: RunResultRef) {
  if (r.price == null || !AGENT_PLATFORMS.has(r.platform)) return null;
  const handling = r.platform === "zepto" ? 4 : 3;
  const delivery = r.price < 99 ? 25 : 0;
  return { item: r.price, handling_fee: handling, delivery_fee: delivery, offer: null, final: r.price + handling + delivery };
}

function checkResult(id: string): CheckResultDetail | null {
  const [, runId, platform, pincode, rival] = id.split("~");
  const run = runs.find((r) => r.id === runId);
  if (!run) return null;
  const i = run.jobs.findIndex((j) => j.platform === platform && j.pincode === pincode && (j.competitor_id ?? "own") === rival);
  if (i < 0) return null;
  const r = runResult(run, i);
  const end = Date.parse(r.checked_at!);
  const total = AGENT_PLATFORMS.has(platform) ? 48_000 + rand(id) * 60_000 : 2400;
  return {
    id,
    run_id: run.id,
    product_id: run.product_id,
    competitor_id: r.competitor_id,
    platform,
    pincode,
    in_stock: r.in_stock,
    price: r.price,
    mrp: r.mrp ?? null,
    eta_minutes: r.eta_minutes ?? null,
    rating: 4.2,
    status: "ok",
    error: null,
    screenshot_url: r.screenshot_url,
    checked_at: r.checked_at!,
    agent: {
      session_id: `tf_${(rand(id) * 1e9).toFixed(0)}`,
      goal: `Find "${jobName(run, i)}" on ${platformName(platform)} for pincode ${pincode}`,
      mode: "live",
      steps: agentSteps(platform, pincode, jobName(run, i), end - total, total),
      true_price: truePrice(r),
    },
  };
}

// ---- Chat ---------------------------------------------------------------------------------------

const HELP_TOPICS: HelpTopic[] = [
  { slug: "getting-started", title: "Getting started", body: "Add a product with its name, an optional brand, and the search query a shopper would type. Then pick the pincodes you sell in and the apps you compete on: Zepto, Swiggy Instamart, Amazon.in and Flipkart are checked live; Blinkit blocks automated browsers, so live mode skips it. Confirm the competitors you want tracked and press Re-check now. ShelfSense streams every agent step live, then fills the heatmap, weekly trends, and AI summary automatically." },
  { slug: "runs", title: "Checks and runs", body: "A run checks your product and each confirmed competitor on every selected app and pincode. Scheduled runs follow each product's frequency: Free runs weekly, Pro and Brand as often as every 3 hours. Zepto and Instamart checks are TinyFish agent sessions that set the delivery pincode; each attempt costs one credit. Amazon and Flipkart pages are read in seconds, are the same for every pincode, and cost no credits. Watch every step on the Agents page." },
  { slug: "heatmap", title: "Reading the heatmap", body: "Each pin shows the worst app at that pincode from its freshest check: out of stock when the shelf is empty, price gap when your price is 5% or more above the cheapest in-stock rival checked in the last 24 hours, not checked recently when your latest check is missing, failed, or older than 24 hours, otherwise in stock. Hot zones mark clusters of three or more out-of-stock pins within 3 km. Use the snapshot control to see the map as it was 6 hours, 24 hours, or 7 days ago." },
  { slug: "weekly", title: "Weekly report", body: "The weekly view compares the last 7 days against the previous 7: average price, out-of-stock count, rating, and a price-rank proxy. The changelog lists every detected price, stock, and rating change. Download the CSV for spreadsheets or finance." },
  { slug: "recommendations", title: "AI summaries and recommendations", body: "After each run ShelfSense writes a short summary and a handful of recommendations grounded in your check numbers. Approve one to act on it, dismiss it, or mark it done; every decision stays in history for your team." },
  { slug: "credits", title: "Credits and plans", body: "Every TinyFish agent attempt (Zepto, Instamart, Blinkit) costs one credit; Amazon and Flipkart page reads are free. Free: 3 products, 5 pincodes and 3 competitors per product, weekly checks, 100 credits a day. Pro: 25 products, 100 pincodes and 10 competitors per product, checks every 3 hours, 1,000 credits a day. Brand: unlimited products, pincodes and credits, and up to 25 competitors per product." },
];

interface MockConversation extends Conversation {
  messages: ChatMessage[];
}
const conversations: MockConversation[] = [
  {
    id: "conv-1",
    title: "Where is Amul out of stock?",
    product_id: "p-amul",
    created_at: ago(20 * HOUR),
    message_count: 2,
    messages: [
      { role: "user", content: "Where is Amul out of stock?", actions: [], evidence: [], created_at: ago(20 * HOUR) },
      { role: "assistant", content: "Amul Taaza Toned Milk 500 ml is out of stock on Zepto in 4 pincodes: Saket (110017), Kalkaji (110019), Greater Kailash (110048) and Gulmohar Park (110049). Instamart is in stock in all 12 tracked pincodes.", actions: [{ label: "Open heatmap", path: "/heatmap?product=p-amul" }], evidence: [{ metric: "oos_pins", value: 4 }], created_at: ago(20 * HOUR) },
    ],
  },
];

function chatAnswer(message: string): { answer: string; actions: Record<string, unknown>[]; evidence: Record<string, unknown>[] } {
  const m = message.toLowerCase();
  if (/(out of stock|oos|stock)/.test(m))
    return {
      answer: "Right now 8 pin-app pairs are out of stock: Amul Taaza on Zepto in Saket, Kalkaji, Greater Kailash and Gulmohar Park; Haldiram Bhujia on Instamart in Lajpat Nagar; and boAt Airdopes 141 on Flipkart in Hauz Khas, Saket and Greater Kailash. The Amul cluster is the biggest risk — it's been empty for two checks in a row.",
      actions: [{ label: "Open Amul heatmap", path: "/heatmap?product=p-amul" }],
      evidence: [{ metric: "oos_pairs", value: 8 }, { metric: "hot_zones", value: 1 }],
    };
  if (/(price|cheap|gap|rival|competitor)/.test(m))
    return {
      answer: "You're priced above the cheapest rival in 5 places. The biggest gap is Haldiram Bhujia on Zepto in Hauz Khas: ₹55 vs Bikaji at ₹50 (9.4%). Dropping to ₹49 closes it and stays above your ₹47 floor — there's a pending recommendation for exactly that.",
      actions: [{ label: "Review Haldiram", path: "/products/p-haldiram" }],
      evidence: [{ metric: "gap_pct", value: 9.4 }],
    };
  if (/(credit|plan|limit)/.test(m))
    return {
      answer: "You're on Pro: 25 products, 100 pincodes and 10 competitors per product, with 1,000 agent credits a day. You've used 186 credits today. Amazon and Flipkart checks are free; Zepto and Instamart cost one credit per check.",
      actions: [{ label: "Plan settings", path: "/settings" }],
      evidence: [],
    };
  if (/(telegram|alert|notif)/.test(m))
    return {
      answer: "Telegram is connected for Amul (group “Riya Store Ops”) and Haldiram (your personal chat). You'll get stock-outs and price gaps instantly, plus a 9:00 morning briefing. Connect the other products from their Telegram tab.",
      actions: [{ label: "Telegram setup", path: "/products/p-paperboat/telegram" }],
      evidence: [],
    };
  return {
    answer: "Across your 4 products, 82% of tracked pin-app pairs are in stock and healthy. Two things need you today: restock Amul on Zepto in South Delhi, and fix the Haldiram price gap on Zepto. Paper Boat is fully covered.",
    actions: [{ label: "Go to dashboard", path: "/dashboard" }],
    evidence: [{ metric: "healthy_pct", value: 82 }],
  };
}

// ---- Router -------------------------------------------------------------------------------------

const ok = (body?: unknown): MockResponse => ({ status: body === undefined ? 204 : 200, body });
const notFound = (what = "Not found"): MockResponse => ({ status: 404, body: { error: { code: "not_found", message: what } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bodyOf(init?: RequestInit & { json?: unknown }): Record<string, unknown> {
  if (init?.json && typeof init.json === "object") return init.json as Record<string, unknown>;
  if (typeof init?.body === "string") {
    try {
      return JSON.parse(init.body);
    } catch {}
  }
  return {};
}

function refreshUsage() {
  const pins = new Set(seeds.flatMap((s) => s.pincodes));
  me = {
    ...me,
    usage: {
      products: seeds.length,
      pincodes: pins.size,
      max_pincodes_per_product: Math.max(0, ...seeds.map((s) => s.pincodes.length)),
      max_competitors_per_product: Math.max(0, ...seeds.map((s) => rivalsOf(s.product.id).length)),
      checks_this_week: runs.reduce((a, r) => a + (Date.now() - r.startedAt < 7 * DAY ? r.jobs.length : 0), 0),
    },
  };
  return me;
}

const PLAN_LIST = [
  { plan: "free", products: 3, pincodes: 5, competitors: 3, minimum_frequency_hours: 168, daily_credit_budget: 100 },
  { plan: "pro", products: 25, pincodes: 100, competitors: 10, minimum_frequency_hours: 3, daily_credit_budget: 1000 },
  { plan: "brand", products: null, pincodes: null, competitors: 25, minimum_frequency_hours: null, daily_credit_budget: null },
];

function telegramStatus(pid: string): TelegramStatus {
  const links = telegram[pid] ?? [];
  return {
    status: links.length ? "connected" : pendingCodes.has(pid) ? "waiting" : "not_connected",
    chat_title: links[0]?.chat_title ?? null,
    enabled: links.length > 0,
    bot_running: true,
    bot_username: "ShelfSenseBot",
    links,
    simulate_available: true,
  };
}

function weekly(seed: Seed, platform: string | null): Weekly {
  const pls = platform ? [platform] : seed.platforms;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * DAY).toISOString().slice(0, 10));
  const entity = (name: string, pl: string, rival: string | null) => ({
    entity_id: rival,
    name,
    platform: pl,
    is_seller: !rival,
    prices: days.map((_, d) => avg(seed.pincodes.map((c) => observe(seed, pl, c, (6 - d) * 4, rival).price))),
    in_stock: days.map((_, d) => seed.pincodes.filter((c) => observe(seed, pl, c, (6 - d) * 4, rival).in_stock).length),
    checks: days.map(() => seed.pincodes.length * 4),
  });
  const entities = pls.flatMap((pl) => [entity(seed.product.name, pl, null), ...rivalsOf(seed.product.id, pl).map((c) => entity(c.name, pl, c.id))]);
  const win = (offset: number) => {
    const obs = pls.flatMap((pl) => seed.pincodes.flatMap((c) => [0, 1, 2, 3, 4, 5, 6].map((d) => observe(seed, pl, c, (d + offset) * 4))));
    return {
      avg_price: avg(obs.map((o) => o.price)),
      oos_count: obs.filter((o) => !o.in_stock).length,
      rating: avg(obs.map((o) => o.rating)),
      search_rank: offset ? 4 : 3,
    };
  };
  const changelog = pls.flatMap((pl, k) =>
    seed.pincodes.slice(0, 3).map((c, i) => {
      const rival = rivalsOf(seed.product.id, pl)[0] ?? null;
      const old = observe(seed, pl, c, 8, rival?.id ?? null).price;
      const kinds = ["price_drop", "price_rise", "stock_out"];
      const kind = seed.oos.has(`${pl}:${c}`) ? "stock_out" : kinds[(i + k) % 2];
      return {
        id: `chg-${seed.product.id}-${pl}-${c}`,
        competitor_id: kind === "stock_out" ? null : rival?.id ?? null,
        platform: pl,
        pincode: c,
        kind,
        old_value: kind === "stock_out" ? 1 : old,
        new_value: kind === "stock_out" ? 0 : round(old * (kind === "price_drop" ? 0.92 : 1.06)),
        detected_at: ago((i * 19 + k * 7 + 3) * HOUR),
      };
    }),
  );
  return { platform, this_week: win(0), last_week: win(7), series: { days, entities }, changelog };
}

function weeklyCsv(seed: Seed, platform: string | null) {
  const w = weekly(seed, platform);
  const rows = [["day", "entity", "platform", "avg_price", "in_stock_pins", "checks"]];
  w.series.entities.forEach((e) => w.series.days.forEach((d, i) => rows.push([d, e.name, e.platform, String(e.prices[i] ?? ""), String(e.in_stock[i]), String(e.checks[i])])));
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

const REVIEWS: Record<string, Reviews> = {
  "p-amul": {
    loves: ["Always fresh, long expiry date", "Packaging never leaks", "Delivered cold"],
    complaints: ["Often unavailable in the morning", "Price went up by ₹1 recently"],
    rival_loves: ["Mother Dairy is easier to find late night"],
    rival_complaints: ["Mother Dairy pouches sometimes arrive dented"],
    items: [],
  },
  "p-haldiram": {
    loves: ["Crunchy and fresh", "Authentic taste", "Good value 200 g pack"],
    complaints: ["Slightly more expensive than Bikaji", "Pack sometimes half air"],
    rival_loves: ["Bikaji is cheaper"],
    rival_complaints: ["Bikaji is too salty for some"],
    items: [],
  },
  "p-paperboat": {
    loves: ["Tastes like real aamras", "No artificial aftertaste", "Nice pouch design"],
    complaints: ["Small quantity for the price"],
    rival_loves: ["Maaza is sweeter and cheaper"],
    rival_complaints: ["Frooti tastes artificial"],
    items: [],
  },
  "p-boat": {
    loves: ["Great battery backup", "Punchy bass", "Comfortable fit"],
    complaints: ["Mic quality average on calls", "Case scratches easily"],
    rival_loves: ["realme Buds have better call quality"],
    rival_complaints: ["Noise Buds connection drops"],
    items: [],
  },
};

function productOr404(id: string) {
  return seedOf(id);
}

/** Answers one `/api{path}` request from the in-memory demo data. */
export async function mockRequest(path: string, init?: RequestInit & { json?: unknown }): Promise<MockResponse> {
  await sleep(120 + Math.random() * 200);
  const method = (init?.method ?? "GET").toUpperCase();
  const url = new URL(path, "http://mock");
  const q = url.searchParams;
  const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const body = bodyOf(init);
  const [a, b, c, d, e] = seg;

  // --- System ---
  if (a === "health")
    return ok({ status: "ok", database: "ok", mock_mode: false, integrations: { gemini: true, telegram: true, tinyfish: true, supabase: false }, bot_running: true, scheduler_running: true, auth_mode: "dev", tinyfish_mode: "live", billing_mode: "test" });
  if (a === "plans") return ok({ current: me.plan, plans: PLAN_LIST, platforms: PLATFORMS } satisfies Plans);
  if (a === "pincodes") return ok(PINCODES);
  if (a === "help" && b === "topics") return ok({ items: HELP_TOPICS });

  // --- Me ---
  if (a === "me" && !b) {
    if (method === "PATCH") me = { ...me, profile: { ...me.profile, ...(body as Partial<Me["profile"]>) } };
    if (method === "DELETE") return ok();
    return ok(refreshUsage());
  }
  if (a === "me" && b === "settings") {
    if (method === "PATCH" || method === "PUT") settings = { ...settings, ...(body as Partial<UserSettings>) };
    return ok(settings);
  }
  if (a === "me" && b === "plan") {
    me = { ...me, plan: String(body.plan ?? me.plan) };
    return ok({ plan: me.plan, status: "active", test_mode: true, adjusted_products: 0, paused_products: 0, over_limit: [] });
  }
  if (a === "me" && b === "export") {
    if (q.get("format") === "json") return { status: 200, body: JSON.stringify({ profile: me.profile, products: seeds.map((s) => s.product) }, null, 2), contentType: "application/json" };
    return { status: 200, body: ["id,name,brand,check_frequency", ...seeds.map((s) => `${s.product.id},"${s.product.name}",${s.product.brand},${s.product.check_frequency}`)].join("\n"), contentType: "text/csv" };
  }
  if (a === "me" && b === "alerts") {
    if (c === "read-all") {
      const marked = alerts.filter((x) => !x.read).length;
      alerts.forEach((x) => (x.read = true));
      return ok({ marked });
    }
    if (c && d === "read") {
      const al = alerts.find((x) => x.id === c);
      if (al) al.read = true;
      return ok({ id: c, read: true });
    }
    const unreadOnly = q.get("unread") === "true";
    const limit = Number(q.get("limit") ?? 50);
    const items = alerts.filter((x) => !unreadOnly || !x.read).slice(0, limit);
    return ok({ items, unread: alerts.filter((x) => !x.read).length });
  }

  // --- Dashboard / actions ---
  if (a === "dashboard") {
    const cards = seeds.map(productCard);
    const oos = cards.reduce((n, x) => n + (x.oos_pairs ?? 0), 0);
    const links = Object.values(telegram).flat().length;
    return ok({
      meters: { plan: me.plan, products: seeds.length, product_limit: 25, max_pincodes_per_product: Math.max(...seeds.map((s) => s.pincodes.length)), pincode_limit_per_product: 100, credits_today: 186, daily_credit_budget: 1000 },
      tiles: [
        { key: "products", label: "Products", value: seeds.length },
        { key: "pincodes", label: "Pincodes tracked", value: new Set(seeds.flatMap((s) => s.pincodes)).size },
        { key: "checks_this_week", label: "Checks this week", value: refreshUsage().usage.checks_this_week },
        { key: "oos_pincodes", label: "Out-of-stock pincodes", value: oos },
        { key: "oos_pincodes_last_week", label: "Out-of-stock last week", value: oos + 3 },
        { key: "approved_this_week", label: "Approved this week", value: actions.length },
      ],
      alerts: alerts.slice(0, 5),
      recommendations: recommendations.filter((r) => r.status === "pending").slice(0, 4),
      telegram: { connected: links > 0, total: links },
    } satisfies Dashboard);
  }
  if (a === "actions") {
    const pid = q.get("product_id");
    const list = actions.filter((x) => !pid || x.product_id === pid);
    return ok({ open: list.filter((x) => x.status !== "done"), done: list.filter((x) => x.status === "done") });
  }
  if (a === "recommendations" && b && c) {
    const rec = recommendations.find((r) => r.id === b) ?? actions.find((r) => r.id === b);
    if (!rec) return notFound("Recommendation not found");
    const verb = c;
    if (verb === "send-telegram") return ok({ id: b, status: rec.status ?? "pending", sent_to_chats: 1, telegram_status: "sent", message: "Sent to Riya Store Ops" });
    const status = verb === "approve" ? "approved" : verb === "dismiss" ? "dismissed" : verb === "done" ? "done" : "pending";
    rec.status = status;
    rec.decided_at = new Date().toISOString();
    rec.decided_via = "web";
    if (verb === "approve" && !actions.some((x) => x.id === rec.id)) {
      actions.unshift({ ...rec, product_name: seedOf(rec.product_id)?.product.name ?? null, kind: String(rec.evidence?.kind ?? "action"), action_item: rec.action_text, effect: "action_created", run_id: null, target_price: typeof rec.evidence?.target_price === "number" ? (rec.evidence.target_price as number) : null, done_at: null, status: "approved" });
    }
    const act = actions.find((x) => x.id === rec.id);
    if (act && verb === "done") {
      act.status = "done";
      act.done_at = new Date().toISOString();
    }
    if (act && verb === "reopen") act.status = "approved";
    return ok({ id: b, status, decided_via: "web", decided_at: rec.decided_at, effect: verb === "approve" ? "action_created" : null, action_item: verb === "approve" ? rec.action_text : null, telegram_status: verb === "approve" ? "sent" : null, sent_to_chats: verb === "approve" ? 1 : 0 });
  }

  // --- Competitors (by id) ---
  if (a === "competitors" && b) {
    const idx = competitors.findIndex((x) => x.id === b);
    if (idx < 0) return notFound("Competitor not found");
    if (method === "DELETE") {
      competitors.splice(idx, 1);
      return ok();
    }
    if (c === "confirm") competitors[idx] = { ...competitors[idx], confirmed: true };
    return ok(competitors[idx]);
  }

  // --- Runs ---
  if (a === "runs" && !b) {
    const pid = q.get("product_id");
    const limit = Number(q.get("limit") ?? 20);
    return ok(runs.filter((r) => !pid || r.product_id === pid).sort((x, y) => y.startedAt - x.startedAt).slice(0, limit).map(runSummary));
  }
  if (a === "runs" && b) {
    const run = runs.find((r) => r.id === b);
    return run ? ok(runDetail(run)) : notFound("Run not found");
  }
  if (a === "check-results" && b) {
    const res = checkResult(b);
    return res ? ok(res) : notFound("Check result not found");
  }

  // --- TinyFish ---
  if (a === "tinyfish" && b === "usage") {
    const today = runs.filter((r) => Date.now() - r.startedAt < DAY);
    return ok({ mode: "live", concurrency: CONCURRENCY, credits_today: 186 + runs.filter((r) => r.live).reduce((n, r) => n + runDetail(r).credits_used, 0), daily_budget: 1000, runs_today: today.length + 3, success_rate_7d: 0.96 });
  }
  if (a === "tinyfish" && b === "apps")
    return ok([
      { platform: "zepto", label: "Zepto", status: "live", method: "agent", pincode_specific: true, detail: "TinyFish agent sets the delivery pincode, then reads price, stock and ETA" },
      { platform: "instamart", label: "Swiggy Instamart", status: "live", method: "agent", pincode_specific: true, detail: "TinyFish agent sets the delivery pincode, then reads price, stock and ETA" },
      { platform: "amazon", label: "Amazon.in", status: "live", method: "fetch", pincode_specific: false, detail: "Product page read via Fetch API — same for every pincode, no credits" },
      { platform: "flipkart", label: "Flipkart", status: "live", method: "fetch", pincode_specific: false, detail: "Product page read via Fetch API — same for every pincode, no credits" },
      { platform: "blinkit", label: "Blinkit", status: "unavailable", method: "none", pincode_specific: true, detail: "Blinkit blocks automated browsers, so live mode skips it" },
    ] satisfies AppStatus[]);

  // --- Chat ---
  if (a === "chat" && !b && method === "POST") {
    const message = String(body.message ?? "");
    let conv = conversations.find((x) => x.id === body.conversation_id);
    if (!conv) {
      conv = { id: `conv-${conversations.length + 1}-${Date.now() % 10_000}`, title: message.slice(0, 60) || "New chat", product_id: (body.product_id as string) ?? null, created_at: new Date().toISOString(), message_count: 0, messages: [] };
      conversations.unshift(conv);
    }
    const reply = chatAnswer(message);
    const now = new Date().toISOString();
    conv.messages.push({ role: "user", content: message, actions: [], evidence: [], created_at: now }, { role: "assistant", content: reply.answer, actions: reply.actions, evidence: reply.evidence, created_at: now });
    conv.message_count = conv.messages.length;
    await sleep(500);
    return ok({ conversation_id: conv.id, ...reply, source: "gemini" });
  }
  if (a === "chat" && b === "conversations") {
    if (!c) return ok({ items: conversations.map((x): Conversation => ({ id: x.id, title: x.title, product_id: x.product_id, created_at: x.created_at, message_count: x.message_count })) });
    const idx = conversations.findIndex((x) => x.id === c);
    if (idx < 0) return notFound("Conversation not found");
    if (method === "DELETE") {
      conversations.splice(idx, 1);
      return ok();
    }
    const conv = conversations[idx];
    return ok({ id: conv.id, title: conv.title, product_id: conv.product_id, created_at: conv.created_at, messages: conv.messages });
  }

  // --- Products ---
  if (a === "products" && !b) {
    if (method === "POST") {
      const id = `p-new-${++runCounter}-${Date.now() % 100_000}`;
      const product = makeProduct(id, { name: String(body.name ?? "New product"), brand: (body.brand as string) ?? null, ...(body as Partial<Product>) }, 0);
      product.id = id;
      seeds.push({ product, pincodes: SOUTH_DELHI.slice(0, 5), platforms: ["zepto", "instamart"], base: 99, oos: new Set(), gap: new Set(), listings: {} });
      lastRunAt[id] = Date.now();
      return { status: 201, body: product };
    }
    const term = (q.get("q") ?? "").toLowerCase();
    return ok(seeds.filter((s) => !term || s.product.name.toLowerCase().includes(term) || (s.product.brand ?? "").toLowerCase().includes(term)).map(productCard));
  }

  const seed = b ? productOr404(b) : undefined;
  if (a === "products" && b && !seed) return notFound("Product not found");
  if (a === "products" && seed) {
    const pid = seed.product.id;
    if (!c) {
      if (method === "DELETE") {
        seeds.splice(seeds.indexOf(seed), 1);
        return ok();
      }
      if (method === "PATCH") seed.product = { ...seed.product, ...(body as Partial<Product>), id: pid };
      return ok(seed.product);
    }
    switch (c) {
      case "overview": {
        const runId = latestRunId(pid);
        void runId;
        return ok({
          kpis: {
            avg_price: { value: avg(seed.platforms.flatMap((pl) => seed.pincodes.map((x) => observe(seed, pl, x).price))), sparkline: spark(seed, (o) => avg(o.map((x) => x.price))) },
            cheapest_rival: { value: Math.min(...seed.platforms.flatMap((pl) => seed.pincodes.map((x) => observe(seed, pl, x).rival_price))), sparkline: spark(seed, (o) => Math.min(...o.map((x) => x.rival_price))) },
            in_stock: (() => {
              const card = productCard(seed);
              return { value: (card.total_pairs ?? 0) - (card.oos_pairs ?? 0), total: card.total_pairs ?? 0, sparkline: spark(seed, (o) => o.filter((x) => x.in_stock).length) };
            })(),
            rating: { value: avg(seed.platforms.flatMap((pl) => seed.pincodes.map((x) => observe(seed, pl, x).rating))), sparkline: spark(seed, (o) => avg(o.map((x) => x.rating))) },
          },
          summary: { summary_text: summaries[pid] ?? `${seed.product.name} was just added. Run the first check to see coverage across your pincodes.`, evidence: {}, source: "gemini", created_at: iso(lastCheck(pid) + 4 * 60_000) },
          recommendations: recsFor(pid).filter((r) => r.status === "pending"),
        } satisfies Overview);
      }
      case "competitors": {
        if (d === "summary") {
          const rows: CompetitorRow[] = seed.platforms.flatMap((pl) => {
            const own = seed.pincodes.map((x) => observe(seed, pl, x));
            const ownAvg = avg(own.map((o) => o.price)) ?? 0;
            const row = (name: string, id: string | null, obs: Obs[]): CompetitorRow => {
              const price = avg(obs.map((o) => o.price));
              return { entity_id: id, name, is_seller: !id, platform: pl, price, in_stock: obs.filter((o) => o.in_stock).length, total: obs.length, rating: avg(obs.map((o) => o.rating)), eta_minutes: Math.round(avg(obs.map((o) => o.eta)) ?? 0), price_delta_pct: id && price ? round(((price - ownAvg) / ownAvg) * 100, 1) : null, checked_at: iso(lastCheck(pid)) };
            };
            return [row(seed.product.name, null, own), ...rivalsOf(pid, pl).map((r) => row(r.name, r.id, seed.pincodes.map((x) => observe(seed, pl, x, 0, r.id))))];
          });
          return ok(rows);
        }
        if (d === "discover") {
          const brand = seed.product.brand ?? "Store";
          return ok({
            source: "gemini",
            suggestions: [
              { name: `${brand} Value Pack`, platform: seed.platforms[0], url: null, search_query: `${brand} value pack`, confirmed: false },
              { name: seed.product.name.includes("Milk") ? "Nandini Toned Milk 500 ml" : `Private label ${seed.product.name.split(" ").slice(-2).join(" ")}`, platform: seed.platforms[1] ?? seed.platforms[0], url: null, search_query: null, confirmed: false },
              { name: `${brand} Market Choice`, platform: seed.platforms[0], url: null, search_query: `${brand} market choice`, confirmed: false },
            ],
          });
        }
        if (method === "POST") {
          const comp: Competitor = { id: `c-${pid}-${Date.now() % 100_000}`, product_id: pid, name: String(body.name ?? "Competitor"), platform: String(body.platform ?? seed.platforms[0]), url: (body.url as string) ?? null, search_query: (body.search_query as string) ?? null, confirmed: body.confirmed !== false };
          competitors.push(comp);
          return { status: 201, body: comp };
        }
        return ok(competitors.filter((x) => x.product_id === pid));
      }
      case "pincodes":
        if (method === "PUT") {
          if (Array.isArray(body.pincodes)) seed.pincodes = (body.pincodes as string[]).filter((x) => PIN.has(x));
          if (Array.isArray(body.platforms) && body.platforms.length) seed.platforms = body.platforms as string[];
        }
        return ok({ platforms: seed.platforms, pincodes: seed.pincodes });
      case "listings":
        if (method === "PUT" && Array.isArray(body.listings)) for (const l of body.listings as { platform: string; url: string | null }[]) seed.listings[l.platform] = l.url;
        return ok(seed.platforms.map((pl) => ({ platform: pl, url: seed.listings[pl] ?? null })));
      case "alert-rules":
        if (d === "parse") return ok({ kind: "custom", threshold: null, rule_text: String(body.text ?? ""), rule_json: { text: body.text }, active: true } satisfies AlertRule);
        if (method === "PUT" && Array.isArray(body.rules)) alertRules[pid] = body.rules as AlertRule[];
        return ok((alertRules[pid] ??= defaultRules()));
      case "reviews":
        return ok(REVIEWS[pid] ?? { loves: [], complaints: [], items: [] });
      case "weekly":
        if (d === "report.csv") return { status: 200, body: weeklyCsv(seed, q.get("platform")), contentType: "text/csv" };
        return ok(weekly(seed, q.get("platform")));
      case "heatmap":
        if (d === "pincodes" && e) return PIN.has(e) ? ok(pinDetail(seed, e, q.get("platform"))) : notFound("Pincode not tracked");
        return ok(heatmap(seed, q.get("platform"), q.get("snapshot") ?? "now"));
      case "ai": {
        if (method === "GET") return ok({ items: recsFor(pid).filter((r) => !q.get("status") || r.status === q.get("status")) });
        await sleep(700);
        if (d === "summary") return ok({ summary_text: summaries[pid], source: "gemini" });
        if (d === "reviews") return ok({ changed: false, message: "Review insights are up to date" });
        return ok({ source: "gemini", recommendations: recsFor(pid).filter((r) => r.status === "pending"), superseded: 0, expired: 0, skipped_recent: 0, auto_approved: 0, reason: "no_change", message: "No new recommendations — the latest ones still apply" });
      }
      case "runs": {
        if (d === "estimate") {
          const jobs = jobsFor(seed, q.getAll("pincodes").flatMap((x) => x.split(",")).filter(Boolean), q.getAll("platforms").flatMap((x) => x.split(",")).filter(Boolean));
          const credits = jobs.filter((j) => AGENT_PLATFORMS.has(j.platform)).length;
          return ok({ jobs: jobs.length, credits, platforms: seed.platforms, skipped_platforms: [], remaining_credits: 1000 - 186 - credits });
        }
        const active = runs.find((r) => r.product_id === pid && runStatus(r).status === "running");
        if (active) return { status: 409, body: { error: { code: "run_in_progress", message: "A check is already running for this product" } } };
        const jobs = jobsFor(seed, body.pincodes as string[] | undefined, body.platforms as string[] | undefined);
        const run: MockRun = { id: `run-live-${++runCounter}-${Date.now() % 100_000}`, product_id: pid, trigger: "manual", startedAt: Date.now(), jobs, finishAt: scheduleJobs(jobs.length), live: true };
        runs.push(run);
        setTimeout(() => (lastRunAt[pid] = Date.now()), Math.max(...run.finishAt!));
        return { status: 202, body: { run_id: run.id, total_jobs: jobs.length, estimated_credits: jobs.filter((j) => AGENT_PLATFORMS.has(j.platform)).length } };
      }
      case "telegram": {
        if (!d) {
          if (method === "DELETE") {
            delete telegram[pid];
            return ok();
          }
          if (method === "PATCH") {
            telegram[pid] = (telegram[pid] ?? []).map((l) => ({ ...l, alert_types: (body.alert_types as string[] | null) ?? null, briefing_time: (body.briefing_time as string) ?? l.briefing_time }));
            return ok(telegramStatus(pid));
          }
        }
        if (d === "status") return ok(telegramStatus(pid));
        if (d === "link-code") {
          const code = `SS-${Math.floor(100000 + Math.random() * 899999)}`;
          pendingCodes.set(pid, code);
          return ok({ code, deep_link: `https://t.me/ShelfSenseBot?start=${code}`, command: `/start ${code}`, expires_at: iso(Date.now() + 15 * 60_000), product_id: pid });
        }
        if (d === "simulate-link") {
          pendingCodes.delete(pid);
          const group = body.chat_type === "group";
          telegram[pid] = [...(telegram[pid] ?? []), { id: `tl-${Date.now() % 100_000}`, chat_id: group ? "-100777123" : "58213907", chat_title: group ? "Riya Store Team" : "Riya Sharma", alert_types: null, briefing_time: settings.briefing_time, connected_at: new Date().toISOString() }];
          return ok(telegramStatus(pid));
        }
        if (d === "test") return ok({ sent: true, message: "Test alert sent to your Telegram chat" });
        if (d === "links" && e && method === "DELETE") {
          telegram[pid] = (telegram[pid] ?? []).filter((l) => l.id !== e);
          return ok();
        }
        return ok(telegramStatus(pid));
      }
    }
  }

  if (method !== "GET") return ok({ ok: true });
  return notFound(`No demo data for ${url.pathname}`);
}

/** Demo screenshots live in /public/mock, not on the backend. */
export const isMockAsset = (url: string) => MOCK_MODE && url.startsWith("/mock/");
