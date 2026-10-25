"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorMessage, useApi } from "@/lib/api";
import { formatDateTime, platformLabel, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import type {
  Inventory,
  InventoryAlert,
  InventoryEvent,
  InventoryLine,
  InventoryMutation,
  InventoryProduct,
  SimulateSales,
  StockStatus,
  TelegramDelivery,
} from "@/lib/types";
import { CardSkeleton, Empty, ErrorCard, StatTile, Toggle } from "@/components/ui";

const KEY = "/inventory";
const SIMULATE_EVERY_MS = 4000;
const RESTOCK_UNITS = 20;
const SELL_AMOUNTS = [5, 10, 25];

/** Inventory status: never colour alone — icon + label on every chip. */
const STOCK_META: Record<StockStatus, { label: string; icon: string; cls: string }> = {
  in_stock: { label: "In stock", icon: "✓", cls: "bg-sage text-ink" },
  low: { label: "Low", icon: "!", cls: "bg-sand text-ink" },
  out_of_stock: { label: "Out of stock", icon: "✕", cls: "bg-ink text-linen" },
};

const KIND_LABEL: Record<string, string> = {
  dark_store: "Dark store",
  fulfilment_centre: "Fulfilment centre",
  own_warehouse: "Own warehouse",
};

const REASON_LABEL: Record<string, string> = {
  sale: "Sold",
  simulated_sale: "Live order",
  restock: "Restocked",
  set: "Stock set",
  seed: "Opening stock",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

function statusOf(quantity: number, threshold: number): StockStatus {
  if (quantity <= 0) return "out_of_stock";
  if (quantity <= threshold) return "low";
  return "in_stock";
}

/** Recompute one line (and the totals around it) locally, for optimistic updates. */
function patchLine(data: Inventory, itemId: string, quantity: number, threshold?: number): Inventory {
  const products = data.products.map((p) => {
    if (!p.warehouses.some((w) => w.item_id === itemId)) return p;
    const warehouses = p.warehouses.map((w) => {
      if (w.item_id !== itemId) return w;
      const low = threshold ?? w.low_stock_threshold;
      return { ...w, quantity, low_stock_threshold: low, status: statusOf(quantity, low) };
    });
    return { ...p, warehouses, total_units: warehouses.reduce((s, w) => s + w.quantity, 0) };
  });
  const lines = products.flatMap((p) => p.warehouses);
  return {
    ...data,
    products,
    summary: {
      ...data.summary,
      units: lines.reduce((s, w) => s + w.quantity, 0),
      out_of_stock: lines.filter((w) => w.status === "out_of_stock").length,
      low_stock: lines.filter((w) => w.status === "low").length,
    },
  };
}

function telegramNote(t: TelegramDelivery): string {
  if (t.sent > 0) return `Sent to Telegram (${plural(t.sent, "chat")}).`;
  if (t.linked > 0 && !t.bot_running) return `Telegram linked (${plural(t.linked, "chat")}), but the bot isn't running here — it's in Alerts.`;
  if (t.linked > 0) return "Telegram didn't go through — it's in Alerts.";
  return "Telegram not linked — link it on the product's Telegram tab.";
}

/** Toasts + bell refresh for every alert a stock change raised. */
function useAnnounceAlerts() {
  const { mutate } = useSWRConfig();
  return useCallback(
    (alerts: InventoryAlert[] | undefined) => {
      if (!alerts?.length) return;
      for (const a of alerts) {
        if (a.kind === "inventory_out") {
          const unlinked = a.telegram.linked === 0;
          toast.alert(`🚨 Out of stock at ${a.warehouse_name} — ${a.product_name}`, {
            detail: telegramNote(a.telegram),
            action: unlinked ? { label: "Link Telegram", href: `/products/${a.product_id}/telegram` } : undefined,
          });
        } else {
          toast.info(`Low stock: ${a.product_name} — ${plural(a.quantity, "unit")} left at ${a.warehouse_name}`);
        }
      }
      // The bell, the /alerts inbox and the dashboard all cache alerts: refresh them now.
      void mutate((k) => typeof k === "string" && (k.startsWith("/me/alerts") || k === "/dashboard"));
    },
    [mutate],
  );
}

export default function InventoryPage() {
  const { data, error, mutate } = useApi<Inventory>(KEY);
  const announce = useAnnounceAlerts();
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [simulating, setSimulating] = useState(false);
  const [resetting, setResetting] = useState(false);

  const setLineBusy = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  /** Optimistic change → API → server truth (and a refetch for totals and activity). */
  const change = useCallback(
    async (line: InventoryLine, next: number, call: () => Promise<InventoryMutation>, failMsg: string) => {
      setLineBusy(line.item_id, true);
      await mutate((d) => d && patchLine(d, line.item_id, Math.max(0, next)), { revalidate: false });
      try {
        const res = await call();
        await mutate((d) => d && patchLine(d, res.item.item_id, res.item.quantity, res.item.low_stock_threshold), { revalidate: false });
        announce(res.alerts);
      } catch (e) {
        toast.error(errorMessage(e, failMsg));
      } finally {
        setLineBusy(line.item_id, false);
        void mutate();
      }
    },
    [mutate, announce],
  );

  const sell = (line: InventoryLine, units: number) =>
    change(
      line,
      line.quantity - units,
      () => api<InventoryMutation>(`/inventory/items/${encodeURIComponent(line.item_id)}/sell`, { method: "POST", json: { units } }),
      "Could not record the sale",
    );
  const restock = (line: InventoryLine, units: number) =>
    change(
      line,
      line.quantity + units,
      () => api<InventoryMutation>(`/inventory/items/${encodeURIComponent(line.item_id)}/restock`, { method: "POST", json: { units } }),
      "Could not restock",
    );
  const setQuantity = (line: InventoryLine, quantity: number) =>
    change(
      line,
      quantity,
      () => api<InventoryMutation>(`/inventory/items/${encodeURIComponent(line.item_id)}`, { method: "PUT", json: { quantity } }),
      "Could not update the stock",
    );

  // "Simulate live orders": a few sales every few seconds while on and the tab is visible.
  const inFlight = useRef(false);
  useEffect(() => {
    if (!simulating) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        const res = await api<SimulateSales>("/inventory/simulate-sales", { method: "POST" });
        announce(res.alerts);
        if (res.changes.length === 0) {
          setSimulating(false);
          toast.info("Every warehouse is empty — reset the demo stock to keep going.");
        }
        await mutate();
      } catch (e) {
        setSimulating(false);
        toast.error(errorMessage(e, "Live orders stopped"));
      } finally {
        inFlight.current = false;
      }
    };
    const start = () => {
      if (timer == null) timer = setInterval(tick, SIMULATE_EVERY_MS);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    void tick();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [simulating, announce, mutate]);

  async function reset() {
    if (resetting) return;
    setResetting(true);
    setSimulating(false);
    try {
      const r = await api<{ items: number }>("/inventory/reset", { method: "POST" });
      await mutate();
      toast(`Demo stock reset across ${plural(r.items, "warehouse line")}`);
    } catch (e) {
      toast.error(errorMessage(e, "Could not reset the demo stock"));
    } finally {
      setResetting(false);
    }
  }

  const s = data?.summary;
  return (
    <div className="flex flex-col gap-10">
      <section data-mochi="inv-head" className="flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="flex flex-col gap-2 max-w-[62ch]">
          <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px] tracking-[-1.4px]">My Inventory</h1>
          <p className="text-[16px] leading-[24px] text-ink/80">
            Stock for every product in each warehouse and dark store, like the inventory report your marketplaces send. The moment a
            warehouse hits 0 you get an alert here and on Telegram.{" "}
            <span className="font-semibold text-ink">Demo stock — not synced from your seller accounts yet.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div data-mochi="inv-simulate" className="flex items-center gap-3 rounded-[12px] border-2 border-ink bg-linen px-4 min-h-[48px]">
            {simulating && <span className="ss-live-dot shrink-0" aria-hidden />}
            <Toggle checked={simulating} onChange={setSimulating} label="Simulate live orders" disabled={!data?.products.length} />
          </div>
          <button type="button" className="btn btn-ghost" onClick={reset} disabled={resetting || !data?.products.length}>
            {resetting ? "Resetting…" : "Reset demo stock"}
          </button>
        </div>
      </section>
      <p className="sr-only" aria-live="polite">
        {simulating ? "Live orders on: stock drains every few seconds." : ""}
      </p>

      {error && !data ? (
        <ErrorCard error={error} onRetry={() => mutate()} />
      ) : !data || !s ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-[150px]" />
            ))}
          </div>
          <CardSkeleton rows={5} />
        </>
      ) : data.products.length === 0 ? (
        <Empty title="No products yet">
          Add a product and its warehouse stock shows up here.{" "}
          <Link href="/products" className="underline font-semibold">
            Go to Products
          </Link>
        </Empty>
      ) : (
        <>
          <section data-mochi="inv-tiles" aria-label="Inventory summary" className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            <StatTile eyebrow="Units in stock" count={s.units} caption={`Across ${plural(s.products, "product")}`} height={150} />
            <StatTile
              eyebrow="Out of stock"
              count={s.out_of_stock}
              caption={s.out_of_stock ? "Warehouse lines at 0" : "Nothing at 0"}
              tone={s.out_of_stock ? "ink" : "linen"}
              height={150}
            />
            <StatTile
              eyebrow="Low stock"
              count={s.low_stock}
              caption={s.low_stock ? "At or under the threshold" : "All lines healthy"}
              tone={s.low_stock ? "sand" : "linen"}
              height={150}
            />
            <StatTile eyebrow="Warehouses" count={s.warehouses} caption="Dark stores, FCs and your own" height={150} />
          </section>

          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px] items-start">
            <section data-mochi="inv-products" aria-label="Stock by product" className="flex flex-col gap-6 min-w-0">
              {data.products.map((p) => (
                <ProductStock key={p.product_id} product={p} busy={busy} onSell={sell} onRestock={restock} onSet={setQuantity} />
              ))}
            </section>
            <Activity events={data.recent_events} />
          </div>
        </>
      )}
    </div>
  );
}

function ProductStock({
  product,
  busy,
  onSell,
  onRestock,
  onSet,
}: {
  product: InventoryProduct;
  busy: Set<string>;
  onSell: (line: InventoryLine, units: number) => void;
  onRestock: (line: InventoryLine, units: number) => void;
  onSet: (line: InventoryLine, quantity: number) => void;
}) {
  const out = product.warehouses.filter((w) => w.status === "out_of_stock").length;
  const low = product.warehouses.filter((w) => w.status === "low").length;
  const headingId = `inv-${product.product_id}`;
  return (
    <article className="card p-0 overflow-hidden" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-4 sm:px-6 border-b-2 border-ink/10">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[22px] leading-[28px]">
            <Link href={`/products/${product.product_id}`} className="hover:underline underline-offset-4">
              {product.name}
            </Link>
          </h2>
          <p className="text-[14px] text-ink/75 mt-0.5">
            {product.brand ? `${product.brand} · ` : ""}
            {plural(product.warehouses.length, "warehouse")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {out > 0 && <span className="chip bg-ink text-linen">✕ {out} out</span>}
          {low > 0 && <span className="chip bg-sand text-ink">! {low} low</span>}
          <span className="text-[15px] font-semibold tabular-nums">
            {product.total_units.toLocaleString("en-IN")} <span className="font-medium text-ink/75">units total</span>
          </span>
        </div>
      </header>
      <ul className="divide-y-2 divide-ink/10">
        {product.warehouses.map((line) => (
          <StockRow key={line.item_id} line={line} busy={busy.has(line.item_id)} onSell={onSell} onRestock={onRestock} onSet={onSet} />
        ))}
      </ul>
    </article>
  );
}

function StockRow({
  line,
  busy,
  onSell,
  onRestock,
  onSet,
}: {
  line: InventoryLine;
  busy: boolean;
  onSell: (line: InventoryLine, units: number) => void;
  onRestock: (line: InventoryLine, units: number) => void;
  onSet: (line: InventoryLine, quantity: number) => void;
}) {
  const w = line.warehouse;
  const meta = STOCK_META[line.status];
  const out = line.status === "out_of_stock";
  const where = [w.city, w.pincode].filter(Boolean).join(" · ");
  const label = `${w.name}${w.kind === "dark_store" && w.pincode ? ` (${w.pincode})` : ""}`;
  return (
    <li
      data-status={line.status}
      className={`grid gap-x-5 gap-y-3 px-5 py-4 sm:px-6 grid-cols-[minmax(0,1fr)_auto] items-start transition-colors duration-200 ${
        out ? "bg-sand/35" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip bg-linen text-ink">{w.platform === "own" ? "Own" : platformLabel(w.platform)}</span>
          <span className={`chip ${meta.cls}`}>
            <span aria-hidden>{meta.icon}</span>
            {meta.label}
          </span>
        </div>
        <p className="mt-1.5 text-[16px] leading-6 font-semibold">{w.name}</p>
        <p className="text-[13px] leading-5 text-ink/75">
          {KIND_LABEL[w.kind] ?? w.kind}
          {where ? ` · ${where}` : ""} · low at {line.low_stock_threshold}
        </p>
      </div>

      <Quantity line={line} busy={busy} onSet={onSet} label={label} />

      <div className="col-span-2 grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2" role="group" aria-label={`Stock actions for ${label}`}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || out} onClick={() => onSell(line, 1)}>
          −1 sold
        </button>
        <label className="sr-only" htmlFor={`sell-${line.item_id}`}>
          Sell several units at {label}
        </label>
        <select
          id={`sell-${line.item_id}`}
          className="pill pr-8 appearance-none bg-[length:10px] bg-no-repeat bg-[right_12px_center] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%230d1b2a' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
          }}
          value=""
          disabled={busy || out}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n > 0) onSell(line, n);
          }}
        >
          <option value="">Sell…</option>
          {SELL_AMOUNTS.map((n) => (
            <option key={n} value={n}>
              Sell {n}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sage btn-sm" disabled={busy} onClick={() => onRestock(line, RESTOCK_UNITS)}>
          + Restock {RESTOCK_UNITS}
        </button>
        <button
          type="button"
          className="btn btn-ink btn-sm"
          disabled={busy || out}
          title="Demo: simulate this warehouse running out"
          onClick={() => onSet(line, 0)}
        >
          Set to 0
        </button>
      </div>
    </li>
  );
}

/** Big quantity; click to type an exact number (Enter saves, Esc cancels). */
function Quantity({ line, busy, onSet, label }: { line: InventoryLine; busy: boolean; onSet: (line: InventoryLine, q: number) => void; label: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const n = Number(value);
    if (value.trim() === "" || !Number.isInteger(n) || n < 0 || n === line.quantity) return;
    onSet(line, n);
  }

  if (editing)
    return (
      <div className="justify-self-end">
        <label htmlFor={`qty-${line.item_id}`} className="sr-only">
          Units at {label}
        </label>
        <input
          ref={input}
          id={`qty-${line.item_id}`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          className="input w-[7.5rem] text-[22px] font-semibold tabular-nums text-right py-2"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setValue(String(line.quantity));
        setEditing(true);
      }}
      className="group justify-self-end text-right rounded-[10px] px-2 py-1 -mx-2 hover:bg-ink/5 focus-visible:bg-ink/5 transition-colors disabled:cursor-wait"
      aria-label={`${line.quantity} units at ${label}. Edit quantity`}
    >
      <span
        key={line.quantity}
        className={`block font-display text-[40px] leading-[44px] tabular-nums ${line.status === "out_of_stock" ? "text-ink" : ""}`}
        style={{ animation: "inv-tick 260ms cubic-bezier(0.23, 1, 0.32, 1) both" }}
      >
        {line.quantity.toLocaleString("en-IN")}
      </span>
      <span className="block text-[12px] font-semibold text-ink/75 underline decoration-dotted underline-offset-2 group-hover:decoration-solid">
        units · edit
      </span>
    </button>
  );
}

function Activity({ events }: { events: InventoryEvent[] }) {
  return (
    <section data-mochi="inv-activity" aria-labelledby="inv-activity-title" className="card p-5 sm:p-6 xl:sticky xl:top-[96px]">
      <h2 id="inv-activity-title" className="text-[20px] leading-[26px]">
        Recent activity
      </h2>
      {events.length === 0 ? (
        <p className="mt-3 text-[15px] text-ink/75">Sales, restocks and stock changes show up here. Try “−1 sold” or switch on live orders.</p>
      ) : (
        <ol className="mt-3 divide-y-2 divide-ink/10" aria-live="off">
          {events.map((e) => {
            const down = e.delta < 0;
            return (
              <li key={e.id} className="py-3 flex items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-0.5 grid place-items-center size-7 shrink-0 rounded-full border-2 border-ink text-[13px] font-bold tabular-nums ${
                    e.quantity_after === 0 ? "bg-ink text-linen" : down ? "bg-linen" : "bg-sage"
                  }`}
                >
                  {e.quantity_after === 0 ? "✕" : down ? "−" : "+"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-5">
                    <span className="font-semibold">
                      {REASON_LABEL[e.reason] ?? e.reason} {e.delta !== 0 ? `${down ? "−" : "+"}${Math.abs(e.delta)}` : ""}
                    </span>{" "}
                    · {e.product_name}
                  </p>
                  <p className="text-[13px] leading-5 text-ink/75 truncate" title={e.warehouse_name}>
                    {e.warehouse_name}
                  </p>
                  <p className="text-[13px] leading-5 text-ink/75">
                    <span className={e.quantity_after === 0 ? "font-bold text-ink" : ""}>
                      {e.quantity_after === 0 ? "Now out of stock" : `${e.quantity_after} left`}
                    </span>
                    {" · "}
                    <time dateTime={e.created_at} title={formatDateTime(e.created_at)}>
                      {timeAgo(e.created_at)}
                    </time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
