"use client";

import Link from "next/link";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorMessage, useApi } from "@/lib/api";
import { ALERT_KIND_LABEL, formatDateTime, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { Alert } from "@/lib/types";
import { CardSkeleton, Empty, ErrorCard } from "@/components/ui";

type AlertList = { items: Alert[]; unread: number };

/** The backend returns at most 200 alerts per request (newest first). */
const LIMIT = 200;

/** Alerts inbox: everything the bell shows, plus history, an unread filter and bulk mark-read. */
export default function AlertsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const key = `/me/alerts?limit=${LIMIT}${unreadOnly ? "&unread=true" : ""}`;
  const { data, error, mutate } = useApi<AlertList>(key);
  const { mutate: mutateAll } = useSWRConfig();
  const [busy, setBusy] = useState<string | null>(null);

  // The bell in the top bar caches its own alert list: refresh every alert list after a change.
  const refreshAll = () => mutateAll((k) => typeof k === "string" && k.startsWith("/me/alerts"));

  async function markRead(a: Alert) {
    if (a.read || busy) return;
    setBusy(a.id);
    try {
      await api(`/me/alerts/${encodeURIComponent(a.id)}/read`, { method: "POST" });
      await refreshAll();
    } catch (e) {
      toast.error(errorMessage(e, "Could not mark the alert read"));
    } finally {
      setBusy(null);
    }
  }

  async function markAll() {
    if (busy) return;
    setBusy("all");
    try {
      const r = await api<{ marked: number }>("/me/alerts/read-all", { method: "POST" });
      await refreshAll();
      toast(r?.marked ? `Marked ${r.marked} alert${r.marked === 1 ? "" : "s"} read` : "No unread alerts");
    } catch (e) {
      toast.error(errorMessage(e, "Could not mark alerts read"));
    } finally {
      setBusy(null);
    }
  }

  const unread = data?.unread ?? 0;
  return (
    <div className="flex flex-col gap-8">
      <section data-mochi="alerts-head" className="flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="flex flex-col gap-2">
          <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px] tracking-[-1.4px]">Alerts</h1>
          <p className="text-[16px] leading-[22px]">
            {data ? (unread ? `${unread} unread alert${unread === 1 ? "" : "s"}.` : "You're all caught up.") : error ? "Couldn't load alerts." : "Loading alerts…"}
          </p>
        </div>
        <button type="button" className="btn btn-primary" disabled={!unread || busy !== null} onClick={markAll}>
          {busy === "all" ? "Marking…" : "Mark all read"}
        </button>
      </section>

      <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filter alerts">
        {[
          { on: !unreadOnly, label: "All", count: null, value: false },
          { on: unreadOnly, label: "Unread", count: data ? unread : null, value: true },
        ].map((f) => (
          <button
            key={f.label}
            type="button"
            aria-pressed={f.on}
            onClick={() => setUnreadOnly(f.value)}
            className={`inline-flex items-center gap-2 px-[22px] py-[10px] rounded-[12px] border-2 border-ink text-[14px] leading-[21px] font-semibold ${
              f.on ? "bg-slate text-linen shadow-[4px_4px_0_var(--ink)]" : "bg-linen text-ink hover:bg-sand/40"
            }`}
          >
            {f.label}
            {f.count != null && <span className={f.on ? "text-linen/90" : "text-ink/75"}>{f.count}</span>}
          </button>
        ))}
      </div>

      {error && !data ? (
        <ErrorCard error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <CardSkeleton rows={6} />
      ) : data.items.length === 0 ? (
        <Empty title={unreadOnly ? "No unread alerts" : "No alerts yet"}>
          {unreadOnly ? (
            <button type="button" className="underline font-semibold" onClick={() => setUnreadOnly(false)}>
              Show all alerts
            </button>
          ) : (
            "Alerts appear here when a check finds a product out of stock, a price move or a rival change."
          )}
        </Empty>
      ) : (
        <ul data-mochi="alerts-inbox" className="card divide-y-2 divide-ink/10 p-0 overflow-hidden">
          {data.items.map((a) => (
            <li key={a.id} className={`flex flex-wrap items-start gap-4 px-5 py-4 sm:px-6 ${a.read ? "" : "bg-sand/25"}`}>
              <span
                aria-hidden
                className={`mt-[7px] size-2.5 shrink-0 rounded-full border border-ink ${a.read ? "bg-transparent border-ink/30" : "bg-sand"}`}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-[16px] leading-6 ${a.read ? "font-medium" : "font-semibold"}`}>
                  {!a.read && <span className="sr-only">Unread: </span>}
                  {a.message}
                </p>
                <p className="mt-1 text-[13px] text-ink/75">
                  <span className="font-semibold">{ALERT_KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, " ")}</span>
                  {" · "}
                  <time dateTime={a.created_at} title={formatDateTime(a.created_at)}>
                    {timeAgo(a.created_at)}
                  </time>
                  {a.sent_telegram ? " · sent to Telegram" : ""}
                </p>
              </div>
              {/* On phones the actions wrap under the message, indented to its text edge. */}
              <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full max-sm:w-full max-sm:pl-[26px]">
                <Link
                  href={`/products/${a.product_id}`}
                  onClick={() => void markRead(a)}
                  title={a.product_name ?? undefined}
                  className="btn btn-ghost btn-sm min-w-0 max-w-full sm:max-w-[260px]"
                >
                  <span className="truncate">{a.product_name ?? "Open product"}</span>
                </Link>
                {!a.read && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => markRead(a)}>
                    {busy === a.id ? "Marking…" : "Mark read"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && data.items.length >= LIMIT && (
        <p className="text-[14px] text-ink/75">Showing the newest {LIMIT} alerts. Export your account in Settings for the full history.</p>
      )}
    </div>
  );
}
