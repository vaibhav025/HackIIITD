"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { api, API_URL, errorMessage, isNetworkError, useApi } from "@/lib/api";
import { AUTH_ENABLED, authMismatch, redirectToLogin, useAuth } from "@/lib/auth";
import { useFocusTrap, useScrollLock } from "@/lib/a11y";
import type { Alert, Health, Me, Product, ProductCard } from "@/lib/types";
import { setDisplayTimeZone, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { buildProductTrie, highlight } from "@/lib/trie";
import ActiveIndicator, { IndicatorGroup } from "./motion/ActiveIndicator";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "nav-dashboard" },
  { href: "/products", label: "Products", icon: "nav-products" },
  { href: "/heatmap", label: "Heatmaps", icon: "nav-heatmaps" },
  { href: "/agents", label: "Agents", icon: "agents" },
  { href: "/alerts", label: "Alerts", icon: "alerts" },
  { href: "/help", label: "Help Centre", icon: "nav-help" },
  { href: "/settings", label: "Settings", icon: "nav-settings" },
];

/** Sand line icon matching the Figma nav set (16px, 1.33 stroke): a browser window with a cursor. */
function AgentsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.33" y="2" width="13.33" height="10" rx="1.6" stroke="#D4C4A8" strokeWidth="1.33" />
      <path d="M1.33 4.9h13.33" stroke="#D4C4A8" strokeWidth="1.33" />
      <path d="M8.2 7.2l4.6 1.9-2 .7-.8 2-1.8-4.6Z" fill="#D4C4A8" stroke="#D4C4A8" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

/** Sand bell for the Alerts nav item (the shell's bell.svg is ink, for the linen top bar). */
function AlertsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path d="M6.85 14a1.33 1.33 0 0 0 2.3 0" stroke="#D4C4A8" strokeWidth="1.33" strokeLinecap="round" />
      <path
        d="M2.17 10.22a.67.67 0 0 0 .5 1.11h10.66a.67.67 0 0 0 .5-1.11C12.94 9.3 12 8.33 12 5.33a4 4 0 1 0-8 0c0 3-.94 3.97-1.83 4.89Z"
        stroke="#D4C4A8"
        strokeWidth="1.33"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* eslint-disable @next/next/no-img-element */
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  if (name === "agents") return <AgentsIcon size={size} />;
  if (name === "alerts") return <AlertsIcon size={size} />;
  return <img src={`/figma/shell/${name}.svg`} alt="" width={size} height={size} className="shrink-0" />;
}

export function Logo({ dark = true }: { dark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-3" aria-label="ShelfSense home">
      <span className="grid place-items-center size-10 rounded-[12px] border-2 border-ink bg-sand shadow-[3px_3px_0_var(--ink)]">
        <Icon name="logo" size={22} />
      </span>
      <span className="flex flex-col">
        <span className={`font-display text-[24px] leading-[24px] tracking-[-0.6px] ${dark ? "text-linen" : "text-ink"}`}>ShelfSense</span>
        <span className={`text-[10px] leading-[10px] font-bold tracking-[2.2px] uppercase pt-[2px] ${dark ? "text-sand" : "text-slate"}`}>
          Intelligence
        </span>
      </span>
    </Link>
  );
}

export const initials = (name?: string) =>
  (name ?? "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "·";

/**
 * The nav item the user just clicked, until the route actually changes. Listening on window
 * (capture phase) lets the active pill start sliding while the next route is still loading.
 */
export function usePendingHref(scope: React.RefObject<HTMLElement | null>, attr: string) {
  const pathname = usePathname();
  const [pending, setPending] = useState<{ href: string; from: string } | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.(`[${attr}]`);
      if (!a || !scope.current?.contains(a)) return;
      setPending({ href: a.getAttribute(attr) ?? "", from: location.pathname });
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [scope, attr]);
  return pending && pending.from === pathname ? pending.href : null;
}

function Sidebar({ me, meFailed, onNavigate, onClose }: { me?: Me; meFailed?: boolean; onNavigate?: () => void; onClose?: () => void }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const pending = usePendingHref(navRef, "data-nav-href");
  const { mode, user, signOut } = useAuth();
  const active = (href: string) => (pending ? pending === href : pathname.startsWith(href));
  return (
    <aside className="bg-ink border-r-2 border-ink w-[260px] h-full flex flex-col justify-between overflow-y-auto">
      <div className="flex flex-col gap-4">
        <div className="border-b-2 border-slate/30 px-6 pt-6 pb-[26px] flex items-center justify-between gap-2">
          <Logo />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close menu"
              data-close
              className="grid place-items-center size-9 rounded-[10px] border-2 border-linen text-linen text-[18px] leading-none"
            >
              ✕
            </button>
          )}
        </div>
        {/* The sand pill (bg, border, 4px shadow) is one shared indicator that slides between items. */}
        <IndicatorGroup>
          <nav ref={navRef} aria-label="Main" className="flex flex-col gap-2 p-4">
            {NAV.map((n) => {
              const on = active(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  data-nav-href={n.href}
                  aria-current={on ? "page" : undefined}
                  onClick={onNavigate}
                  className={
                    on
                      ? "relative flex items-center gap-3 px-[18px] py-[14px] rounded-full border-2 border-transparent"
                      : "relative flex items-center gap-3 px-[18px] py-[14px] rounded-[14px] border-2 border-transparent hover:bg-deep transition-colors"
                  }
                >
                  {on && <ActiveIndicator id="sidebar-nav" className="-inset-[2px]! rounded-full bg-sand border-2 border-ink shadow-[4px_4px_0_var(--ink)]" />}
                  <span className={`relative z-[1] grid place-items-center size-7 rounded-[8px] ${on ? "bg-ink" : "bg-deep border border-slate/40"}`}>
                    <Icon name={n.icon} />
                  </span>
                  <span className={`relative z-[1] text-[16px] leading-6 ${on ? "font-semibold text-ink" : "font-medium text-linen"}`}>{n.label}</span>
                </Link>
              );
            })}
          </nav>
        </IndicatorGroup>
      </div>
      <div className="border-t-2 border-slate/30 px-4 pt-[18px] pb-4 flex flex-col gap-2">
        <Link href="/settings" onClick={onNavigate} className="flex items-center gap-3 p-2 rounded-[14px] hover:bg-deep transition-colors">
          <span className="grid place-items-center size-10 rounded-full bg-slate border-2 border-linen shadow-[3px_3px_0_var(--ink)] text-linen font-bold text-[15px]">
            {initials(me?.profile.name)}
          </span>
          <span className="flex flex-col gap-[2px] min-w-0">
            <span className="text-linen font-semibold text-[16px] leading-[22px] truncate">{me?.profile.name ?? (meFailed ? "Account unavailable" : "…")}</span>
            <span className="self-start bg-sand border border-ink rounded-[6px] px-[9px] py-[3px] text-ink font-bold text-[14px] leading-[21px] capitalize">
              {me?.plan ?? (meFailed ? "—" : "…")}
            </span>
          </span>
        </Link>
        {mode === "supabase" && user && (
          <button
            type="button"
            onClick={() => signOut().catch((e) => toast.error(errorMessage(e, "Could not sign out")))}
            className="text-left px-2 py-1.5 rounded-[10px] text-[14px] font-semibold text-sand hover:bg-deep transition-colors"
          >
            Sign out <span className="sr-only">of {user.email}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

/** Breadcrumb for the top bar, derived from the route. */
function useCrumbs(): string[] {
  const pathname = usePathname();
  const productId = pathname.match(/^\/products\/([^/]+)/)?.[1];
  const { data: product } = useApi<Product>(productId ? `/products/${productId}` : null);
  if (pathname.startsWith("/dashboard")) return ["Dashboard"];
  if (pathname === "/products") return ["Catalog", "Products"];
  if (productId) {
    const tail = pathname.split("/")[3];
    const last = tail ? tail[0].toUpperCase() + tail.slice(1) : "Overview";
    return ["Products", product?.name ?? "…", last];
  }
  if (pathname.startsWith("/heatmap")) return ["Products", "Heatmap"];
  if (pathname.startsWith("/agents")) return ["TinyFish", "Agents"];
  if (pathname.startsWith("/alerts")) return ["Alerts"];
  if (pathname.startsWith("/help")) return ["Help Centre"];
  if (pathname.startsWith("/settings")) return ["Settings"];
  return [];
}

function Bell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { data, error, isLoading, mutate } = useApi<{ items: Alert[]; unread: number }>("/me/alerts?limit=8", { refreshInterval: 60_000 });
  const { mutate: mutateKeys } = useSWRConfig();
  // Keep the /alerts inbox (if open) in step with the bell.
  const refreshAlerts = () => mutateKeys((k) => typeof k === "string" && k.startsWith("/me/alerts"));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // Non-modal popover: Esc closes and focus returns to the bell; Tab may leave it.
  useFocusTrap(panelRef, open, { onEscape: () => setOpen(false), trap: false });

  const markRead = (a: Alert) => {
    if (a.read) return;
    mutate(
      (d) => d && { ...d, unread: Math.max(0, d.unread - 1), items: d.items.map((x) => (x.id === a.id ? { ...x, read: true } : x)) },
      { revalidate: false },
    );
    api(`/me/alerts/${encodeURIComponent(a.id)}/read`, { method: "POST" })
      .catch((e) => toast.error(errorMessage(e, "Could not mark the alert read")))
      .finally(() => refreshAlerts());
  };

  const markAll = () =>
    api("/me/alerts/read-all", { method: "POST" })
      .then(() => refreshAlerts())
      .catch((e) => toast.error(errorMessage(e, "Could not mark alerts read")));

  const unread = data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="relative grid place-items-center size-10 rounded-[12px] bg-linen border-2 border-ink press press-3"
        aria-label={error && !data ? "Alerts (couldn't load)" : unread ? `Alerts, ${unread} unread` : "Alerts"}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {!!unread && <span aria-hidden className="absolute -top-1 -right-1 size-3 rounded-full bg-sand border-2 border-ink" />}
        {error && !data && (
          <span aria-hidden className="absolute -top-1.5 -right-1.5 grid place-items-center size-4 rounded-full bg-ink text-linen text-[10px] font-bold">
            !
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label="Recent alerts"
          className="absolute right-0 top-12 w-[min(20rem,calc(100vw-2rem))] card p-4 z-[1100]"
          style={{ animation: "rise 200ms ease both" }}
        >
          <div className="flex justify-between items-center mb-2">
            <p className="font-semibold">Alerts</p>
            {!!unread && (
              <button type="button" className="text-sm font-semibold underline" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {error && !data ? (
            <div role="alert" className="py-2 text-sm">
              <p className="font-semibold">Couldn&apos;t load alerts.</p>
              <p className="text-ink/75 mt-1">{isNetworkError(error) ? "The ShelfSense server is unreachable." : errorMessage(error)}</p>
              <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => mutate()}>
                Try again
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-ink/15 max-h-80 overflow-y-auto">
              {!data && isLoading ? (
                <li className="py-2 text-sm text-ink/75" role="status">
                  Loading alerts…
                </li>
              ) : data?.items.length ? (
              data.items.map((a) => (
                <li key={a.id} className="py-2">
                  <Link
                    href={`/products/${a.product_id}`}
                    onClick={() => {
                      markRead(a);
                      setOpen(false);
                    }}
                    className="flex gap-2 items-start"
                  >
                    <span
                      aria-hidden
                      className={`mt-[7px] size-2 shrink-0 rounded-full border border-ink ${a.read ? "bg-transparent border-ink/30" : "bg-sand"}`}
                    />
                    <span className="min-w-0">
                      <span className={`block text-[15px] ${a.read ? "font-medium" : "font-semibold"}`}>
                        {!a.read && <span className="sr-only">Unread: </span>}
                        {a.message}
                      </span>
                      <span className="block text-[13px] text-ink/75">
                        {timeAgo(a.created_at)}
                        {a.product_name ? ` · ${a.product_name}` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              ))
              ) : (
                <li className="py-2 text-sm text-ink/75">No alerts yet.</li>
              )}
            </ul>
          )}
          <Link
            href="/alerts"
            onClick={() => setOpen(false)}
            className="mt-3 pt-3 border-t-2 border-ink/15 block text-center text-sm font-semibold underline underline-offset-2"
          >
            View all alerts
          </Link>
        </div>
      )}
    </div>
  );
}

function searchTarget(term: string) {
  return /^\d{6}$/.test(term) ? `/heatmap?pincode=${term}` : `/products?q=${encodeURIComponent(term)}`;
}

const SUGGESTION_LIMIT = 6;

function SearchForm({ id, autoFocus, onDone, className }: { id: string; autoFocus?: boolean; onDone?: () => void; className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = `${id}-suggestions`;
  // Same SWR key as the products page and TopBar, so this shares their cached response.
  const { data: products } = useApi<ProductCard[]>("/products");
  const trie = useMemo(() => buildProductTrie(products ?? []), [products]);
  const term = q.trim();
  const suggestions = useMemo(() => {
    if (!term || !products) return [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return trie.search(term, { limit: SUGGESTION_LIMIT }).flatMap((pid) => byId.get(pid) ?? []);
  }, [trie, products, term]);
  const expanded = open && suggestions.length > 0;
  const activeId = expanded && active >= 0 ? `${id}-option-${active}` : undefined;

  function pick(p: ProductCard) {
    setOpen(false);
    setActive(-1);
    setQ("");
    router.push(`/products/${p.id}`);
    onDone?.();
  }

  return (
    <form
      role="search"
      className={`relative ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (expanded && active >= 0 && suggestions[active]) return pick(suggestions[active]);
        if (!term) return;
        setOpen(false);
        router.push(searchTarget(term));
        onDone?.();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Search products or pincodes
      </label>
      <span className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
        <Icon name="search" />
      </span>
      <input
        id={id}
        type="search"
        enterKeyHint="search"
        autoFocus={autoFocus}
        className="input pl-[42px] py-[11px]"
        placeholder="Search products or pincodes"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeId}
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!suggestions.length) return;
            e.preventDefault();
            const n = suggestions.length;
            if (!expanded) {
              setOpen(true);
              setActive(e.key === "ArrowDown" ? 0 : n - 1);
            } else {
              setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
            }
          } else if (e.key === "Escape" && expanded) {
            e.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {expanded && (
        <ul id={listId} role="listbox" aria-label="Matching products" className="absolute left-0 right-0 top-[calc(100%+6px)] card p-1 z-[1100] max-h-80 overflow-y-auto">
          {suggestions.map((p, i) => (
            <li
              key={p.id}
              id={`${id}-option-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep focus in the input so the list doesn't close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
              className={`px-3 py-2 rounded-[8px] cursor-pointer text-sm ${i === active ? "bg-sand/50" : ""}`}
            >
              <span className="block truncate font-semibold">
                {highlight(p.name, term).map((s, j) => (s.match ? <mark key={j} className="bg-transparent text-inherit underline underline-offset-2 decoration-2">{s.text}</mark> : s.text))}
              </span>
              {p.brand && <span className="block truncate text-ink/75 text-xs">{p.brand}</span>}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function MobileSearch() {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useFocusTrap(sheet, open, { onEscape: () => setOpen(false), initialFocus: "input" });
  return (
    <>
      <button
        type="button"
        className="md:hidden grid place-items-center size-10 rounded-[12px] bg-linen border-2 border-ink press press-3"
        aria-label="Search"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="search" />
      </button>
      {open && (
        <div className="md:hidden fixed inset-0 z-[2000] bg-ink/50" onClick={() => setOpen(false)}>
          <div
            ref={sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            className="bg-linen border-b-2 border-ink px-4 pt-4 pb-5 flex items-center gap-3"
            style={{ animation: "rise 200ms ease both" }}
            onClick={(e) => e.stopPropagation()}
          >
            <SearchForm id="mobile-search" className="flex-1" onDone={() => setOpen(false)} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function TopBar({ me, onMenu, menuOpen, menuButton }: { me?: Me; onMenu: () => void; menuOpen: boolean; menuButton: React.RefObject<HTMLButtonElement | null> }) {
  const crumbs = useCrumbs();
  const { data: products, error: productsError } = useApi<ProductCard[]>("/products");
  const connected = products?.filter((p) => p.telegram_connected).length ?? 0;
  const total = products?.length ?? 0;
  return (
    <header className="sticky top-0 z-[1000] bg-linen border-b-2 border-ink h-[72px] px-4 lg:px-10 flex items-center justify-between gap-3 sm:gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <button
          ref={menuButton}
          type="button"
          className="lg:hidden grid place-items-center size-10 shrink-0 rounded-[12px] bg-linen border-2 border-ink press press-3"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <span aria-hidden>☰</span>
        </button>
        {!AUTH_ENABLED && (
          <Link
            href="/login"
            title="Demo mode: no login, everyone shares the demo account"
            className="shrink-0 bg-ink text-linen border-2 border-ink rounded-[8px] px-2 py-0.5 text-[11px] font-bold tracking-[0.7px] uppercase"
          >
            Demo<span className="sr-only"> mode — about sign-in</span>
          </Link>
        )}
        <nav aria-label="Breadcrumb" className="min-w-0">
          <p className="text-[16px] leading-6 truncate">
            {crumbs.map((c, i) => (
              <span key={i} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                {i > 0 && <span aria-hidden className="text-ink/60 mx-2">/</span>}
                <span className={i === crumbs.length - 1 ? "font-semibold" : "font-medium"}>{c}</span>
              </span>
            ))}
          </p>
        </nav>
      </div>
      <SearchForm id="topbar-search" className="w-[420px] min-w-[200px] shrink hidden md:block" />
      <div className="flex items-center gap-3 sm:gap-4 shrink-0">
        <MobileSearch />
        <Link
          href={products?.[0] ? `/products/${products.find((p) => !p.telegram_connected)?.id ?? products[0].id}/telegram` : "/settings#telegram"}
          className="hidden sm:flex shrink-0 whitespace-nowrap items-center gap-2 h-10 px-[14px] rounded-[12px] bg-linen border-2 border-ink press press-3"
          aria-label={products ? `Telegram: ${connected} of ${total} products connected` : "Telegram settings"}
        >
          <span aria-hidden className={`size-[10px] rounded-full border border-ink ${connected ? "bg-sage" : "bg-linen"}`} />
          <span className="font-bold text-[15px] leading-[22.5px]">
            Telegram {products ? `${connected}/${total}` : productsError ? "—" : "…"}
          </span>
        </Link>
        <Bell />
        <Link
          href="/settings"
          className="hidden sm:grid place-items-center size-10 rounded-full bg-slate border-2 border-ink press press-3 text-linen font-bold text-[14px]"
          title={me?.profile.name}
          aria-label={`Account settings${me?.profile.name ? ` for ${me.profile.name}` : ""}`}
        >
          {initials(me?.profile.name)}
        </Link>
      </div>
    </header>
  );
}

function MobileDrawer({ open, onClose, me, meFailed }: { open: boolean; onClose: () => void; me?: Me; meFailed?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, open, { onEscape: onClose, initialFocus: "[data-close]" });
  useScrollLock(open);
  if (!open) return null;
  return (
    <div className="lg:hidden fixed inset-0 z-[2000] bg-ink/50" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="h-full w-[260px] max-w-[85vw]"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "rise 200ms ease both" }}
      >
        <Sidebar me={me} meFailed={meFailed} onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  );
}

/**
 * Server unreachable (or erroring). Without this a dead backend just looks like an empty
 * account ("…", "No alerts yet", Telegram 0/0).
 */
function ConnectionBanner({ healthError, retrying, onRetry }: { healthError: unknown; retrying: boolean; onRetry: () => void }) {
  if (!healthError) return null;
  const network = isNetworkError(healthError);
  return (
    <div role="alert" className="bg-ink text-linen border-b-2 border-ink px-4 py-2.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[14px] font-semibold text-center">
      <span>
        {network
          ? `Can't reach the ShelfSense server at ${API_URL}. Data on this page may be missing or out of date.`
          : `The ShelfSense server is having trouble: ${errorMessage(healthError)}.`}
      </span>
      <button type="button" className="btn btn-sm bg-sand text-ink" disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** Frontend and backend disagree on whether sign-in is on: explain the fix. */
function AuthMismatchBanner({ health }: { health?: Health }) {
  const message = authMismatch(health?.auth_mode);
  if (!message) return null;
  return (
    <div role="alert" className="bg-sand border-b-2 border-ink text-[13px] text-center py-2 px-4 font-semibold">
      Sign-in is misconfigured. {message}
    </div>
  );
}

/** Strip under the top bar when integrations are simulated, stated plainly. */
function ModeBanner({ health }: { health?: Health }) {
  if (!health?.mock_mode && health?.tinyfish_mode !== "simulated") return null;
  return (
    <div className="bg-sand border-b-2 border-ink text-[13px] text-center py-1.5 px-4 font-semibold">
      {health.mock_mode
        ? "Demo mode · checks, AI and Telegram are simulated until API keys are added"
        : "TinyFish agents are simulated until a TinyFish API key is added"}
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { mode, ready, session } = useAuth();
  const blocked = mode === "supabase" && ready && !session;
  useEffect(() => {
    if (blocked) redirectToLogin();
  }, [blocked]);
  if (mode === "supabase" && (!ready || !session)) {
    return (
      <div className="min-h-screen grid place-items-center bg-linen" role="status" aria-live="polite">
        <div className="flex items-center gap-3 text-[15px] font-semibold">
          <span className="ss-spin" aria-hidden />
          {blocked ? "Redirecting to sign in…" : "Checking your session…"}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { data: me, error: meError } = useApi<Me>("/me");
  const { data: health, error: healthError, isValidating: healthValidating, mutate: refetchHealth } = useApi<Health>("/health", {
    // Poll so an outage shows up (and the banner clears once the server is back).
    refreshInterval: 30_000,
  });
  const { mutate: revalidate } = useSWRConfig();
  const retry = () => {
    // Re-fetch everything on screen, not just /health.
    void refetchHealth();
    void revalidate(() => true);
  };
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  useEffect(() => setMenu(false), [pathname]);
  // Every date in the app renders in the account's timezone (Settings → Timezone).
  useEffect(() => setDisplayTimeZone(me?.profile.timezone), [me?.profile.timezone]);

  return (
    <div className="min-h-screen flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[3001] btn btn-ink btn-sm"
      >
        Skip to content
      </a>
      <div className="hidden lg:block sticky top-0 h-screen shrink-0 z-[1001]">
        <Sidebar me={me} meFailed={!!meError} />
      </div>
      <MobileDrawer open={menu} onClose={() => setMenu(false)} me={me} meFailed={!!meError} />
      <div className="flex-1 min-w-0 flex flex-col bg-linen">
        <TopBar me={me} onMenu={() => setMenu(true)} menuOpen={menu} menuButton={menuButton} />
        <ConnectionBanner healthError={healthError} retrying={healthValidating} onRetry={retry} />
        <AuthMismatchBanner health={health} />
        <ModeBanner health={health} />
        <main id="main" tabIndex={-1} className="flex-1 w-full max-w-[1180px] px-4 sm:px-6 lg:px-10 pt-10 pb-16 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <Shell>{children}</Shell>
    </AuthGate>
  );
}
