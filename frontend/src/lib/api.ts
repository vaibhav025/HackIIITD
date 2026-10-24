import { useEffect, useState } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { AUTH_ENABLED, getAccessToken, redirectToLogin, rejectSession } from "./auth";
import type { ApiErrorBody, ApiErrorField } from "./types";

/**
 * Backend base URL. NEXT_PUBLIC_API_URL wins; otherwise the backend is assumed on port 8000 of
 * whatever host served this page, so a demo opened from another device on the LAN
 * (http://192.168.1.20:3000) talks to http://192.168.1.20:8000 instead of its own localhost.
 */
function defaultApiUrl(): string {
  if (typeof window === "undefined") return "http://localhost:8000";
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:8000`;
}

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || defaultApiUrl()).replace(/\/$/, "");

export type RequestOptions = RequestInit & {
  json?: unknown;
  /** Don't sign out / redirect on 401 — the caller handles it (login page session check). */
  noAuthRedirect?: boolean;
};

/**
 * Any failed API call. `status` is the HTTP status (0 for network failures — see `isNetworkError`),
 * `code` the backend error code (e.g. `validation_error`, `credit_budget_exceeded`).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: ApiErrorField[];

  constructor(status: number, message: string, code = "error", fields: ApiErrorField[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  get isNetwork() {
    return this.status === 0;
  }
}

/** True when the request never reached the server (offline, CORS, backend down). */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof ApiError) return e.isNetwork;
  return e instanceof TypeError;
}

/** Human message for any thrown value — use in toasts and error cards. */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** Validation errors carry per-field messages; show the first alongside the summary. */
function composeMessage(status: number, body: Partial<ApiErrorBody> | null): ApiError {
  const err = body?.error;
  const fields = Array.isArray(err?.fields) ? err.fields : [];
  const code = err?.code ?? (status === 401 ? "unauthorized" : "error");
  let message = err?.message || `Request failed (${status})`;
  if (code === "validation_error" && fields[0]?.msg) {
    const first = fields[0];
    const field = first.loc ? first.loc.split(".").pop() : "";
    message = `${message}: ${field ? `${field.replace(/_/g, " ")} — ` : ""}${first.msg}`;
  }
  return new ApiError(status, message, code, fields);
}

async function request(path: string, init?: RequestOptions): Promise<Response> {
  const { json, noAuthRedirect, ...rest } = init ?? {};
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, `Can't reach the ShelfSense server at ${API_URL}. Check that the backend is running and try again.`, "network_error");
  }
  if (!res.ok) {
    let body: Partial<ApiErrorBody> | null = null;
    try {
      body = await res.json();
    } catch {}
    const error = composeMessage(res.status, body);
    if (res.status === 401 && AUTH_ENABLED && !noAuthRedirect) {
      // No token: send them to sign in. A token the backend rejects would bounce
      // /login <-> /dashboard forever, so drop the session and explain on /login instead.
      if (token) void rejectSession(error.message);
      else redirectToLogin();
    }
    throw error;
  }
  return res;
}

export async function api<T = unknown>(path: string, init?: RequestOptions): Promise<T> {
  const res = await request(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Downloads an authenticated API file (CSV/JSON exports). Plain `<a href>` links can't carry the
 * bearer token, so fetch the blob and hand it to the browser.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await request(path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SWR hook keyed by API path; pass null to skip. */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, (p: string) => api<T>(p), {
    revalidateOnFocus: false,
    // Auth and validation failures won't fix themselves; don't hammer the server.
    shouldRetryOnError: (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500,
    ...config,
  });
}

/** Screenshots are served by the backend under /media (or an owner-checked endpoint); remote URLs pass through. */
export function mediaUrl(url: string | null | undefined) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return null;
  return `${API_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * `<img src>` for a backend screenshot. Public `/media` URLs are used as-is; owner-checked
 * `/api/...` URLs need the bearer token in signed-in mode, so they're fetched as a blob.
 */
export function useMediaSrc(url: string | null | undefined): string | null {
  const direct = mediaUrl(url);
  const needsAuth = AUTH_ENABLED && !!direct && direct.startsWith(`${API_URL}/api/`);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!needsAuth || !direct) return;
    let revoked = false;
    let objectUrl: string | null = null;
    request(direct.slice(`${API_URL}/api`.length))
      .then((res) => res.blob())
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      // Hand back the bare URL: its unauthenticated load fails, so the <img> reports "unavailable"
      // instead of spinning forever.
      .catch(() => {
        if (!revoked) setBlobUrl(direct);
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobUrl(null);
    };
  }, [direct, needsAuth]);

  return needsAuth ? blobUrl : direct;
}

/**
 * SSE URL for a run. EventSource can't send headers, so the access token rides as `access_token`
 * (stream endpoints only) and `last_event_id` resumes after a reconnect.
 */
export async function streamUrl(runId: string, opts?: { lastEventId?: string | null }) {
  const params = new URLSearchParams();
  const token = await getAccessToken();
  if (token) params.set("access_token", token);
  if (opts?.lastEventId) params.set("last_event_id", opts.lastEventId);
  const qs = params.toString();
  return `${API_URL}/api/runs/${encodeURIComponent(runId)}/stream${qs ? `?${qs}` : ""}`;
}
