"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "./api";
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  /** False until the initial `/api/auth/me` call has finished. */
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: { name: string; email: string; password: string }) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: User | null; ready: boolean }>({ user: null, ready: false });

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: User }>("/api/auth/me", { redirectOn401: false })
      .then((r) => !cancelled && setState({ user: r.user, ready: true }))
      .catch(() => !cancelled && setState({ user: null, ready: true }));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await apiFetch<{ user: User }>("/api/auth/login", { method: "POST", body: { email, password }, redirectOn401: false });
    setState({ user: r.user, ready: true });
    return r.user;
  }, []);

  const register = useCallback(
    async (input: { name: string; email: string; password: string }) => {
      await apiFetch("/api/auth/register", { method: "POST", body: input, redirectOn401: false });
      return login(input.email, input.password);
    },
    [login],
  );

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST", redirectOn401: false }).catch(() => undefined);
    setState({ user: null, ready: true });
  }, []);

  const value = useMemo(() => ({ ...state, login, register, logout }), [state, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
