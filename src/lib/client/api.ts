/**
 * Typed fetch wrapper for the PSS REST API.
 * - Same-origin, cookie auth (the httpOnly `pss_token` cookie is sent automatically).
 * - Parses the standard error shape `{ error: { code, message, details } }` into `ApiError`.
 * - Redirects to /login on 401 (unless `redirectOn401: false`).
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field -> message map for VALIDATION_ERROR responses (zod issues or mongoose paths). */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code !== "VALIDATION_ERROR" || !Array.isArray(this.details)) return out;
    for (const issue of this.details as { path?: unknown; message?: unknown }[]) {
      const path = Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? "");
      if (path && typeof issue.message === "string" && !(path in out)) out[path] = issue.message;
    }
    return out;
  }

  /** Extra human-readable lines to show below the message (validation issues, load warnings...). */
  get detailLines(): string[] {
    if (this.code === "VALIDATION_ERROR") {
      return Object.entries(this.fieldErrors).map(([field, msg]) => (field ? `${field}: ${msg}` : msg));
    }
    const d = this.details as { warnings?: unknown } | undefined;
    if (d && Array.isArray(d.warnings)) return d.warnings.filter((w): w is string => typeof w === "string");
    return [];
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, "CLIENT_ERROR", e instanceof Error ? e.message : "Something went wrong");
}

type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  /** Redirect to the login page on 401 (default true). */
  redirectOn401?: boolean;
  signal?: AbortSignal;
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login" || pathname === "/register") return;
  // A hard navigation is intentional: it discards stale client state (auth context, cached data).
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = `/login?next=${encodeURIComponent(pathname + search)}`;
}

export async function apiFetch<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again.");
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && opts.redirectOn401 !== false) redirectToLogin();
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.statusText || "Request failed"), err?.details);
  }
  return json as T;
}
