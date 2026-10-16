"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch, toApiError, type Query } from "./api";

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | null;
  /** True until the first response for the current `path` arrives (reloads keep the old data visible). */
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  path: string;
  data?: T;
  error?: ApiError;
}

/** GET `path` (pass `null` to skip). Re-fetches when `path` changes or `reload()` is called. */
export function useApi<T>(path: string | null, opts: { query?: Query; redirectOn401?: boolean } = {}): ApiState<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [tick, setTick] = useState(0);
  const queryKey = opts.query ? JSON.stringify(opts.query) : "";
  const redirectOn401 = opts.redirectOn401;

  const fullKey = path === null ? null : `${path}|${queryKey}`;

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    const query = queryKey ? (JSON.parse(queryKey) as Query) : undefined;
    apiFetch<T>(path, { query, redirectOn401, signal: controller.signal })
      .then((data) => setSettled({ path: `${path}|${queryKey}`, data }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setSettled({ path: `${path}|${queryKey}`, error: toApiError(e) });
      });
    return () => controller.abort();
  }, [path, queryKey, redirectOn401, tick]);

  const current = settled && settled.path === fullKey ? settled : null;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: fullKey !== null && current === null,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };
}

/** Wraps an async action with busy/error state. `run` resolves to `undefined` when the action failed. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async function <T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(toApiError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { run, busy, error, setError, clear };
}

/** Current time, refreshed every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Call `fn` every `ms` while `enabled`. */
export function useInterval(fn: () => void, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms, enabled]);
}

export { ApiError };
