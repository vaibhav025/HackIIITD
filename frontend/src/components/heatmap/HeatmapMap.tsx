"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Circle, MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import type { Heatmap, HeatmapPin } from "@/lib/types";
import { STATUS_META } from "../ui";
import { rupees } from "@/lib/format";
import { EASE } from "@/lib/motion";

const ICON_HTML: Record<string, string> = {
  in_stock: '<img src="/figma/heatmaps/imgContainer16.svg" alt="" width="15" height="11" />',
  out_of_stock: '<img src="/figma/heatmaps/imgContainer17.svg" alt="" width="13" height="13" />',
  price_gap: '<span style="font-size:16px;line-height:24px">₹</span>',
};

/** Pop order: north → south, west → east, with problem pins last so they land with emphasis. */
const POP_RANK: Record<string, number> = { in_stock: 0, stale: 1, not_tracked: 1, failed: 1, price_gap: 2, out_of_stock: 3 };
const POP_STEP = 35;
const POP_TOTAL = 1400;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
/** divIcon markup is raw HTML: every API-derived string must be escaped. */
const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);

function pinHtml(p: HeatmapPin, showRival: boolean, anim: string) {
  const m = STATUS_META[p.status] ?? STATUS_META.stale;
  // Apps live mode never checks (Blinkit by default) are grey like stale pins but say why.
  const unavailable = (p as HeatmapPin & { stale_reason?: string | null }).stale_reason === "unavailable";
  const inner = unavailable ? "–" : ICON_HTML[p.status] ?? escapeHtml(m.icon);
  const pincode = escapeHtml(p.pincode);
  const label = escapeHtml(unavailable ? "Not available in live mode" : m.label);
  const rival = showRival && !unavailable
    ? `<div class="absolute left-1/2 top-[42px] -translate-x-1/2 whitespace-nowrap rounded-md border-2 border-ink bg-linen px-1.5 text-[11px] font-semibold leading-[18px] text-ink shadow-[2px_2px_0_var(--ink)]">${escapeHtml(rupees(p.price))} · R ${escapeHtml(rupees(p.rival_price))}</div>`
    : "";
  // data-pin wraps everything (dimmed via opacity); data-hl wraps only the pin (scaled on highlight).
  // The pop-in stays on .ss-pin itself (shared pin-pop keyframes) — only its delay is set here.
  return `<div class="relative" data-pin="${pincode}" style="transition:opacity 200ms ease" title="${pincode} · ${escapeHtml(p.area)} — ${label}"><div data-hl style="transition:transform 220ms cubic-bezier(.22,1,.36,1)"><div class="ss-pin ${escapeHtml(p.status.replace(/[^a-z_]/g, ""))}" style="width:36px;height:36px;${anim}" role="img" aria-label="${pincode}${p.area ? ` ${escapeHtml(p.area)}` : ""}: ${label}">${inner}</div></div>${rival}</div>`;
}

interface PinEntry {
  sig: string;
  look: string;
  icon: L.DivIcon;
}

/**
 * Builds one divIcon per pin and decides how each one animates:
 * - a new sequence (first load, product/platform/snapshot/region change) pops every pin in
 *   order, ~35ms apart;
 * - afterwards only pins whose status/price changed (e.g. live re-check results) pop again,
 *   immediately; untouched pins keep their icon object, so Leaflet never swaps their DOM and
 *   nothing replays (selection and highlight are applied to the live DOM, not baked in).
 */
function usePinIcons(pins: HeatmapPin[], seqKey: string, showRival: boolean) {
  const committed = useRef<{ key: string | null; entries: Map<string, PinEntry> }>({ key: null, entries: new Map() });
  const icons = useMemo(() => {
    const prev = committed.current;
    const fresh = prev.key !== seqKey;
    const order = new Map<string, number>();
    if (fresh) {
      [...pins]
        .sort((a, b) => (POP_RANK[a.status] ?? 1) - (POP_RANK[b.status] ?? 1) || b.lat! - a.lat! || a.lng! - b.lng!)
        .forEach((p, i) => order.set(p.pincode, i));
    }
    const step = Math.min(POP_STEP, POP_TOTAL / Math.max(pins.length, 1));
    const out = new Map<string, PinEntry>();
    for (const p of pins) {
      const sig = `${p.status}|${(p as HeatmapPin & { stale_reason?: string | null }).stale_reason ?? ""}|${p.price}|${p.rival_price}`;
      const look = `${sig}|${showRival}`;
      const old = prev.entries.get(p.pincode);
      if (!fresh && old && old.look === look) {
        out.set(p.pincode, old);
        continue;
      }
      const anim = fresh
        ? `animation-delay:${Math.round((order.get(p.pincode) ?? 0) * step)}ms`
        : !old || old.sig !== sig
          ? ""
          : "animation:none"; // only the rival label toggled — no pop
      const icon = L.divIcon({ className: "", html: pinHtml(p, showRival, anim), iconSize: [36, 36], iconAnchor: [18, 18] });
      out.set(p.pincode, { sig, look, icon });
    }
    return out;
  }, [pins, seqKey, showRival]);
  useEffect(() => {
    committed.current = { key: seqKey, entries: icons };
  }, [icons, seqKey]);
  return icons;
}

function FitBounds({ pins }: { pins: HeatmapPin[] }) {
  const map = useMap();
  const key = pins.map((p) => p.pincode).join(",");
  useEffect(() => {
    const pts = pins.map((p) => [p.lat!, p.lng!] as [number, number]);
    if (!pts.length) return;
    const fit = () => {
      map.invalidateSize();
      map.fitBounds(pts, { padding: [60, 60], maxZoom: 13 });
    };
    fit();
    // The card stretches to the right column's height after first paint; refit once settled.
    const t = setTimeout(fit, 400);
    return () => clearTimeout(t);
    // Refit only when the set of pincodes changes, not on every status update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Stops clicks/scrolls on an overlay from reaching the map underneath. */
function useIsolate<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!ref.current) return;
    L.DomEvent.disableClickPropagation(ref.current);
    L.DomEvent.disableScrollPropagation(ref.current);
  });
  return ref;
}

function ZoomButtons() {
  const map = useMap();
  const ref = useIsolate<HTMLDivElement>();
  const cls =
    "grid size-10 place-items-center rounded-[10px] border-2 border-ink bg-linen text-[20px] font-bold leading-7 text-ink press press-4";
  return (
    <div ref={ref} className="absolute right-6 top-6 z-[800] flex flex-col gap-2">
      <button type="button" className={cls} aria-label="Zoom in" onClick={() => map.zoomIn()}>+</button>
      <button type="button" className={cls} aria-label="Zoom out" onClick={() => map.zoomOut()}>−</button>
    </div>
  );
}

/** Floating card anchored directly above the selected pin; follows pan/zoom. Rises in from the pin. */
function Callout({ pin, children }: { pin: HeatmapPin; children: ReactNode }) {
  const map = useMap();
  const [pt, setPt] = useState<L.Point | null>(null);
  const ref = useIsolate<HTMLDivElement>();
  useEffect(() => {
    const ll = L.latLng(pin.lat!, pin.lng!);
    const update = () => setPt(map.latLngToContainerPoint(ll));
    update();
    map.panInside(ll, { paddingTopLeft: [150, 190], paddingBottomRight: [150, 40] });
    map.on("move zoom resize viewreset", update);
    return () => {
      map.off("move zoom resize viewreset", update);
    };
  }, [map, pin.lat, pin.lng]);
  if (!pt) return null;
  return createPortal(
    <div
      ref={ref}
      className="absolute z-[750] w-[264px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-full"
      style={{ left: pt.x, top: pt.y - 30 }}
    >
      <motion.div
        className="relative rounded-[12px] border-2 border-ink bg-linen px-[14px] pb-[14px] pt-[13px] text-ink shadow-[4px_4px_0_var(--ink)]"
        style={{ transformOrigin: "50% calc(100% + 30px)" }}
        initial={{ opacity: 0, y: 10, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.26, ease: EASE } }}
        exit={{ opacity: 0, y: 6, scale: 0.96, transition: { duration: 0.16, ease: "easeIn" } }}
      >
        {children}
        <span className="absolute -bottom-[8px] left-1/2 size-3 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-ink bg-linen" />
      </motion.div>
    </div>,
    map.getContainer(),
  );
}

/** Reports which pin the pointer or keyboard focus is on (two-way highlight with the list). */
function PinHover({ onHover }: { onHover?: (pincode: string | null) => void }) {
  const map = useMap();
  const cb = useRef(onHover);
  cb.current = onHover;
  useEffect(() => {
    const el = map.getContainer();
    const code = (t: EventTarget | null) =>
      t instanceof Element ? (t.closest(".leaflet-marker-icon")?.querySelector("[data-pin]")?.getAttribute("data-pin") ?? null) : null;
    const over = (e: Event) => {
      const c = code(e.target);
      if (c) cb.current?.(c);
    };
    const out = (e: Event) => {
      const from = code(e.target);
      const to = code((e as PointerEvent | FocusEvent).relatedTarget);
      if (from && from !== to) cb.current?.(to);
    };
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerout", out);
    el.addEventListener("focusin", over);
    el.addEventListener("focusout", out);
    return () => {
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerout", out);
      el.removeEventListener("focusin", over);
      el.removeEventListener("focusout", out);
    };
  }, [map]);
  return null;
}

const HOT_ZONE_STYLE: L.PathOptions = {
  color: "#415a77",
  weight: 2,
  dashArray: "6 6",
  fillColor: "#415a77",
  fillOpacity: 0.16,
  // Shared one-time scale-in. Leaflet sets the class once when the path is created; a stable
  // options object means re-renders never touch the path, so it never replays.
  className: "ss-hotzone",
};

export default function HeatmapMap({
  pins,
  hotZones = [],
  selected,
  onSelect,
  showRival = false,
  callout,
  seqKey = "",
  highlight = null,
  onHover,
}: {
  pins: HeatmapPin[];
  hotZones?: Heatmap["hot_zones"];
  selected?: string | null;
  onSelect?: (pincode: string) => void;
  showRival?: boolean;
  /** Content of the card shown above the selected pin. */
  callout?: ReactNode;
  /** Changes when a new set of pins should pop in again (product/platform/snapshot/region). */
  seqKey?: string;
  /** Pin to emphasise (hovered/focused in the list or on the map). */
  highlight?: string | null;
  onHover?: (pincode: string | null) => void;
}) {
  const located = useMemo(() => pins.filter((p) => p.lat != null && p.lng != null), [pins]);
  const sel = located.find((p) => p.pincode === selected);
  const icons = usePinIcons(located, seqKey, showRival);
  const markers = useRef(new Map<string, L.Marker>());

  // Selection + highlight live on the marker DOM so changing them never swaps icons (no re-pop).
  useEffect(() => {
    const hl = highlight && icons.has(highlight) ? highlight : null;
    markers.current.forEach((m, code) => {
      const root = m.getElement();
      root?.querySelector(".ss-pin")?.classList.toggle("selected", code === selected);
      const wrap = root?.querySelector<HTMLElement>("[data-pin]");
      const pin = root?.querySelector<HTMLElement>("[data-hl]");
      if (wrap) wrap.style.opacity = hl && code !== hl ? "0.55" : "";
      if (pin) pin.style.transform = code === hl ? "scale(1.25) translateY(-2px)" : "";
      m.setZIndexOffset(code === hl ? 2000 : code === selected ? 1000 : 0);
    });
  }, [selected, highlight, icons]);

  return (
    <MapContainer center={[28.56, 77.21]} zoom={12} zoomSnap={0.25} zoomControl={false} style={{ height: "100%", width: "100%" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds pins={located} />
      <PinHover onHover={onHover} />
      {hotZones.map((z, i) => (
        <Circle key={i} center={[z.lat, z.lng]} radius={900 + z.count * 250} pathOptions={HOT_ZONE_STYLE} />
      ))}
      {located.map((p) => (
        <Marker
          key={p.pincode}
          ref={(m) => {
            if (m) markers.current.set(p.pincode, m);
            else markers.current.delete(p.pincode);
          }}
          position={[p.lat!, p.lng!]}
          icon={icons.get(p.pincode)!.icon}
          eventHandlers={{ click: () => onSelect?.(p.pincode) }}
        />
      ))}
      <ZoomButtons />
      <AnimatePresence>
        {sel && callout && (
          <Callout key={sel.pincode} pin={sel}>
            {callout}
          </Callout>
        )}
      </AnimatePresence>
    </MapContainer>
  );
}
