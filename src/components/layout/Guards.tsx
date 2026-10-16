"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/client/auth";
import type { Role } from "@/lib/client/types";
import { LinkButton, LoadingBlock } from "@/components/ui";

export function Forbidden({ role }: { role?: Role }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="text-5xl" aria-hidden>
        🚫
      </div>
      <h1 className="mt-4 text-2xl font-semibold text-slate-900">Access restricted</h1>
      <p className="mt-2 text-sm text-slate-600">
        {role === "staff" ? "This area is for airline staff only." : "You do not have permission to view this page."} Your account does not have the required role.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <LinkButton href="/">Go to home</LinkButton>
        <LinkButton href="/bookings" variant="secondary">
          My bookings
        </LinkButton>
      </div>
    </div>
  );
}

/** Client-side guard: redirects anonymous users to /login?next=..., and shows a 403 page for the wrong role. */
export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !user) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [ready, user, router]);

  if (!ready || !user) return <LoadingBlock label="Checking your session…" />;
  if (role && user.role !== role) return <Forbidden role={role} />;
  return <>{children}</>;
}
