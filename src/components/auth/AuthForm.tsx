"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, ErrorAlert, Input } from "@/components/ui";
import { useAuth } from "@/lib/client/auth";
import { useAction } from "@/lib/client/hooks";
import type { User } from "@/lib/client/types";

function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { user, ready, login, register } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const { run, busy, error } = useAction();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const isLogin = mode === "login";

  const destination = (u: User) => next ?? (u.role === "staff" ? "/staff" : "/");

  // Already signed in: go on to where the user was heading.
  useEffect(() => {
    if (ready && user) router.replace(destination(user));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = await run(() => (isLogin ? login(form.email, form.password) : register(form)));
    if (u) router.replace(destination(u));
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const fieldErrors = error?.fieldErrors ?? {};

  return (
    <div className="mx-auto max-w-md pt-6">
      <Card>
        <h1 className="text-xl font-semibold text-slate-900">{isLogin ? "Welcome back" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-slate-500">{isLogin ? "Log in to manage your trips." : "Sign up to book flights and check in online."}</p>
        <form onSubmit={submit} className="mt-5 space-y-4">
          {!isLogin && <Input label="Full name" value={form.name} onChange={set("name")} required autoComplete="name" error={fieldErrors.name} />}
          <Input label="Email" type="email" value={form.email} onChange={set("email")} required autoComplete="email" error={fieldErrors.email} />
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={set("password")}
            required
            minLength={isLogin ? undefined : 8}
            autoComplete={isLogin ? "current-password" : "new-password"}
            hint={isLogin ? undefined : "At least 8 characters"}
            error={fieldErrors.password}
          />
          {error && Object.keys(fieldErrors).length === 0 && <ErrorAlert error={error} />}
          <Button type="submit" loading={busy} className="w-full">
            {isLogin ? "Log in" : "Create account"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          {isLogin ? "New here? " : "Already have an account? "}
          <Link href={isLogin ? "/register" : "/login"} className="font-medium text-sky-700 hover:underline">
            {isLogin ? "Create an account" : "Log in"}
          </Link>
        </p>
      </Card>
    </div>
  );
}
