// Mirrors backend/app/schemas. Keep in sync when the API changes.

export type PinStatus = "in_stock" | "out_of_stock" | "price_gap" | "stale" | "not_tracked" | "failed";
export type Priority = "high" | "medium" | "low";

export type AuthMode = "dev" | "supabase";
export type TinyFishMode = "live" | "simulated";

export interface Health {
  status: string;
  database: string;
  mock_mode: boolean;
  integrations: Record<string, boolean>;
  bot_running: boolean;
  scheduler_running: boolean;
  auth_mode?: AuthMode;
  tinyfish_mode?: TinyFishMode;
  /** "live" (production): plans change through billing and POST /me/plan is refused. */
  billing_mode?: "test" | "live";
}

/** Body every API error returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; fields?: ApiErrorField[] };
}
export interface ApiErrorField { loc: string; msg: string }

export interface Me {
  profile: {
    id: string;
    name: string;
    email: string;
    business_name: string | null;
    business_type: string;
    language: string;
    timezone: string;
    default_city: string | null;
    created_at: string;
  };
  plan: string;
  usage: {
    products: number;
    /** Distinct pincodes across every product. */
    pincodes: number;
    /** Busiest product: plan pincode/competitor limits are per product. */
    max_pincodes_per_product?: number;
    max_competitors_per_product?: number;
    checks_this_week: number;
  };
}

export interface PlanLimits {
  plan: string;
  products: number | null;
  pincodes: number | null;
  competitors?: number;
  minimum_frequency_hours: number | null;
  daily_credit_budget: number | null;
}
export interface Plans { current: string; plans: PlanLimits[]; platforms: string[] }

export interface Pincode { code: string; area_name: string; city: string; lat: number; lng: number }

/** Plan usage measured like the limits are enforced (pincodes per product, credits per day). */
export interface PlanMeters {
  plan: string;
  products: number;
  product_limit: number | null;
  max_pincodes_per_product: number;
  pincode_limit_per_product: number | null;
  credits_today: number;
  daily_credit_budget: number | null;
}

export interface Dashboard {
  meters?: PlanMeters | null;
  tiles: { key: string; label: string; value: number }[];
  alerts: Alert[];
  recommendations: (Recommendation & { product_name: string | null })[];
  telegram: { connected: boolean; total: number };
}

export type PriceSensitivity = "essential" | "regular" | "premium";

export interface Product {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  search_query: string;
  image_url: string | null;
  cost_price: number | null;
  min_margin_pct: number;
  max_change_pct: number;
  floor_price: number | null;
  /** Platform commission on the selling price (%); raises the break-even price. */
  commission_pct: number | null;
  /** Maximum retail price: recommendations never go above it. */
  mrp: number | null;
  /** How big a gap to the cheapest rival must be before a price suggestion (4 / 7 / 10%). */
  price_sensitivity: PriceSensitivity;
  /** Snap suggested prices to ₹49 / ₹99-style price points. */
  round_to_price_point: boolean;
  check_frequency: string;
  volatile_boost: boolean;
  approval_required: boolean;
  paused: boolean;
  created_at: string;
}

export type ProductState = "ok" | "attention" | "paused" | "never_checked";

export interface ProductCard extends Product {
  /** Capped (≤ 12) for display; use the *_pairs counts for totals. */
  status_strip: { platform: string; pincode: string; status: string }[];
  price_position_vs_avg_rival: number | null;
  last_checked: string | null;
  telegram_connected: boolean;
  total_pairs?: number;
  ok_pairs?: number;
  oos_pairs?: number;
  gap_pairs?: number;
  stale_pairs?: number;
  state?: ProductState;
}

export interface Competitor {
  id: string;
  product_id: string;
  name: string;
  platform: string;
  url: string | null;
  search_query: string | null;
  confirmed: boolean;
}

export interface HeatmapPin {
  pincode: string;
  area: string | null;
  lat: number | null;
  lng: number | null;
  status: PinStatus;
  price: number | null;
  rival_price: number | null;
  mrp: number | null;
  eta: number | null;
  checked_at: string | null;
  platform: string;
}

export interface Heatmap {
  pins: HeatmapPin[];
  summary: { in_stock: number; out_of_stock: number; price_gap: number; stale: number; total: number };
  hot_zones: { lat: number; lng: number; count: number; pincodes: string[] }[];
  platform: string | null;
  snapshot: string;
}

export interface PinDetail {
  pincode: string;
  area: string;
  city: string;
  lat: number;
  lng: number;
  platforms: {
    platform: string;
    status: string;
    seller: {
      in_stock: boolean | null;
      price: number | null;
      mrp: number | null;
      eta: number | null;
      rating: number | null;
      status: string;
      checked_at: string | null;
      run_id: string | null;
      screenshot_url: string | null;
      /** CheckResult id, for `GET /check-results/{id}` (agent replay). */
      result_id?: string | null;
    };
    rivals: {
      competitor_id: string;
      name: string;
      in_stock: boolean | null;
      price: number | null;
      mrp: number | null;
      eta: number | null;
      rating: number | null;
      status: string;
      checked_at: string | null;
      result_id?: string | null;
      run_id?: string | null;
    }[];
  }[];
}

export interface Summary { summary_text: string; evidence: Record<string, unknown>; source: string; created_at: string }

export interface Recommendation {
  id: string;
  product_id: string;
  priority: Priority | string;
  action_text: string;
  impact_text: string;
  evidence?: Record<string, unknown>;
  status?: string;
  decided_via?: string | null;
  created_at: string;
  decided_at?: string | null;
}

/** Response of approve / dismiss / done / reopen / send-telegram on a recommendation. */
export interface DecisionResult {
  id: string;
  status: string;
  decided_via?: string | null;
  decided_at?: string | null;
  sent_to_chats?: number;
  /** Approve only: what the approval set in motion. */
  effect?: "run_started" | "action_created" | null;
  run_id?: string | null;
  action_item?: string | null;
  telegram_status?: "sent" | "failed" | "bot_offline" | "no_linked_chats" | null;
  message?: string | null;
}

/** `POST /products/{id}/ai/recommendations`: what the refresh actually did. */
export interface GenerateResult {
  source: string;
  recommendations: Recommendation[];
  superseded: number;
  expired: number;
  skipped_recent: number;
  auto_approved: number;
  reason: "no_check_data" | "limit_reached" | "no_change" | null;
  /** Why no price suggestion was made, e.g. "Price gap 3.1% is below your 7% threshold". */
  price_note?: string | null;
  message: string;
}

/** An approved (open) or done recommendation on the seller's action list (`GET /actions`). */
export interface ActionItem extends Recommendation {
  product_name: string | null;
  kind: string;
  action_item: string;
  effect: string | null;
  run_id: string | null;
  target_price: number | null;
  done_at: string | null;
}
export interface ActionList { open: ActionItem[]; done: ActionItem[] }

export interface Spark { value: number | null; sparkline: (number | null)[] }
export interface Overview {
  kpis: {
    avg_price: Spark;
    cheapest_rival: Spark;
    in_stock: { value: number; total: number; sparkline: (number | null)[] };
    rating: Spark;
  };
  summary: Summary | null;
  recommendations: Recommendation[];
}

export interface CompetitorRow {
  entity_id: string | null;
  name: string;
  is_seller: boolean;
  platform: string;
  price: number | null;
  in_stock: number;
  total: number;
  rating: number | null;
  eta_minutes: number | null;
  price_delta_pct: number | null;
  checked_at: string | null;
}

export interface WeeklyWindow { avg_price: number | null; oos_count: number; rating: number | null; search_rank: number | null }
export interface Weekly {
  platform: string | null;
  this_week: WeeklyWindow;
  last_week: WeeklyWindow;
  series: {
    days: string[];
    entities: {
      entity_id: string | null;
      name: string;
      platform: string;
      is_seller: boolean;
      prices: (number | null)[];
      in_stock: number[];
      checks: number[];
    }[];
  };
  changelog: {
    id: string;
    competitor_id: string | null;
    platform: string;
    pincode: string;
    kind: string;
    old_value: number | null;
    new_value: number | null;
    detected_at: string;
  }[];
}

export interface Reviews {
  /** The seller's own strengths and weak spots. */
  loves: string[];
  complaints: string[];
  /** Only from competitor review data; empty when none was collected. */
  rival_loves?: string[];
  rival_complaints?: string[];
  items: { entity_id: string | null; name: string; loves: string[]; complaints: string[]; updated_at: string }[];
}

export interface Alert {
  id: string;
  product_id: string;
  product_name: string | null;
  kind: string;
  message: string;
  evidence: Record<string, unknown>;
  created_at: string;
  read: boolean;
  sent_telegram?: boolean;
}

export interface AlertRule {
  kind: string;
  threshold: number | null;
  rule_text: string | null;
  rule_json: Record<string, unknown>;
  active: boolean;
}

export interface TelegramStatus {
  status: "not_connected" | "waiting" | "connected";
  chat_title: string | null;
  enabled: boolean;
  bot_running: boolean;
  bot_username: string | null;
  links: {
    id: string;
    chat_id: string;
    chat_title: string | null;
    alert_types: string[] | null;
    briefing_time: string | null;
    connected_at: string;
  }[];
  simulate_available?: boolean;
}

export interface LinkCode {
  code: string;
  /** `https://t.me/<bot>?start=<code>`, or null when the bot username is unknown. */
  deep_link: string | null;
  /** `/start <code>` to paste into the chat manually. */
  command?: string;
  expires_at: string;
  product_id: string;
}

export interface UserSettings {
  briefing_time: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  default_thresholds: Record<string, unknown>;
  channels: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | string;
  content: string;
  actions: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  created_at: string;
}
export interface Conversation { id: string; title: string; product_id: string | null; created_at: string; message_count: number }
export interface ConversationDetail { id: string; title: string; product_id: string | null; created_at: string; messages: ChatMessage[] }
export interface HelpTopic { slug: string; title: string; body: string }

export type RunStatus = "queued" | "running" | "done" | "partial" | "failed" | "cancelled" | string;

export interface Run {
  id: string;
  product_id: string;
  trigger: string;
  status: RunStatus;
  total_jobs: number;
  done_jobs: number;
  failed_jobs: number;
  credits_used: number;
  started_at: string | null;
  finished_at: string | null;
}

/** One row of `GET /runs/{id}` → `results`. */
export interface RunResultRef {
  id: string;
  job_key: string;
  platform: string;
  pincode: string;
  competitor_id: string | null;
  status: string;
  price: number | null;
  in_stock: boolean | null;
  screenshot_url: string | null;
  mrp?: number | null;
  eta_minutes?: number | null;
  area?: string | null;
  error?: string | null;
  checked_at?: string;
  method?: "agent" | "fetch" | "browser" | "cached" | "simulated";
  pincode_specific?: boolean;
  source_url?: string | null;
  delivery_text?: string | null;
  notes?: string[];
  step_count?: number;
  exact_match?: boolean;
}

/** `GET /runs/{id}`. */
export interface RunDetail extends Run {
  mode?: TinyFishMode;
  results?: RunResultRef[];
}

/** `GET /runs` list row. */
export interface RunSummary extends Run {
  product_name: string | null;
  mode?: TinyFishMode;
}

// ---- TinyFish agent ------------------------------------------------------

export type AgentStepKind =
  | "session"
  | "navigate"
  | "location"
  | "search"
  | "open"
  | "extract"
  | "checkout"
  | "screenshot"
  | "done"
  | "error";

export interface AgentStep {
  index: number;
  kind: AgentStepKind | string;
  label: string;
  detail: string | null;
  at: string;
  ms: number;
}

export interface TruePrice {
  item: number | null;
  handling_fee: number | null;
  delivery_fee: number | null;
  offer: number | null;
  final: number | null;
}

export interface AgentTrace {
  session_id?: string | null;
  goal?: string | null;
  mode?: TinyFishMode;
  steps?: AgentStep[];
  true_price?: TruePrice | null;
}

/** `GET /check-results/{id}`. */
export interface CheckResultDetail {
  id: string;
  run_id: string | null;
  product_id: string;
  competitor_id: string | null;
  platform: string;
  pincode: string;
  in_stock: boolean | null;
  price: number | null;
  mrp: number | null;
  eta_minutes: number | null;
  rating: number | null;
  status: string;
  error: string | null;
  screenshot_url: string | null;
  checked_at: string;
  agent: AgentTrace | null;
}

/** `GET /tinyfish/apps`: how each app is checked right now. */
export interface AppStatus {
  platform: string;
  label: string;
  status: "live" | "cached" | "unavailable" | "simulated";
  method: "agent" | "fetch" | "simulated" | "none";
  pincode_specific: boolean;
  detail: string;
}

/** `GET /tinyfish/usage`. */
export interface TinyFishUsage {
  mode: TinyFishMode;
  concurrency: number;
  credits_today: number;
  /** null = unlimited */
  daily_budget: number | null;
  runs_today: number;
  success_rate_7d: number | null;
}

export interface AgentJob {
  platform: string;
  pincode: string;
  competitor_id: string | null;
  competitor_name?: string | null;
}

/** Payload nested under a `result` event (job fields + check outcome). */
export interface RunEventResult extends Partial<AgentJob> {
  id?: string;
  job_key?: string;
  in_stock?: boolean | null;
  price?: number | null;
  mrp?: number | null;
  eta_minutes?: number | null;
  rating?: number | null;
  status?: string;
  screenshot_url?: string | null;
  checked_at?: string;
  ms?: number;
  credits?: number;
  true_price?: TruePrice | null;
}

/** Server-sent events on `/runs/{id}/stream`. */
export type RunEvent =
  | { type: "run_started"; run_id: string; total_jobs: number; mode?: TinyFishMode; concurrency?: number }
  | { type: "job_started"; run_id: string; job_key: string; job: AgentJob; session_id?: string | null; goal?: string | null }
  | { type: "agent_step"; run_id: string; job_key: string; step: AgentStep }
  | {
      type: "result";
      run_id: string;
      job_key?: string;
      true_price?: TruePrice | null;
      result?: RunEventResult;
    }
  | { type: "job_failed"; run_id: string; job_key?: string; job?: AgentJob; error?: string; ms?: number }
  | {
      type: "run_done";
      run_id: string;
      status: RunStatus;
      total_jobs: number;
      done_jobs: number;
      failed_jobs: number;
      credits_used?: number;
    };

/** POST /me/plan (test mode only). */
export interface PlanChange {
  plan: string;
  status: string;
  test_mode: boolean;
  adjusted_products: number;
  paused_products: number;
  /** Products tracking more pincodes/competitors than the new plan allows (nothing is deleted). */
  over_limit?: {
    product_id: string;
    name: string;
    pincodes: number;
    pincode_limit: number | null;
    competitors: number;
    competitor_limit: number;
  }[];
}
