"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/client/auth";
import { Button, LinkButton } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
}

function navFor(role: "passenger" | "staff" | null): NavItem[] {
  const base: NavItem[] = [{ href: "/search", label: "Flights" }];
  if (!role) return base;
  const passenger: NavItem[] = [...base, { href: "/bookings", label: "My bookings" }, { href: "/checkin", label: "Check-in" }];
  return role === "staff" ? [...passenger, { href: "/staff", label: "Staff console" }] : passenger;
}

export function Navbar() {
  const { user, ready, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const items = navFor(user?.role ?? null);

  const isActive = (href: string) => (href === "/staff" ? pathname.startsWith("/staff") : pathname === href || pathname.startsWith(`${href}/`));

  async function handleLogout() {
    await logout();
    setOpen(false);
    router.push("/");
  }

  return (
    <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-sky-800">
          <span aria-hidden>✈</span> SkyPSS
        </Link>

        <button className="rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden" aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <nav className={`${open ? "flex" : "hidden"} absolute left-0 right-0 top-14 flex-col gap-1 border-b border-slate-200 bg-white p-3 md:static md:flex md:flex-row md:items-center md:gap-1 md:border-0 md:bg-transparent md:p-0`}>
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${isActive(item.href) ? "bg-sky-50 text-sky-800" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2 md:ml-3 md:mt-0 md:border-0 md:pt-0">
            {!ready ? null : user ? (
              <>
                <span className="px-2 text-sm text-slate-600" title={user.email}>
                  {user.name} <span className="text-xs uppercase text-slate-400">({user.role})</span>
                </span>
                <Button variant="secondary" size="sm" onClick={handleLogout}>
                  Log out
                </Button>
              </>
            ) : (
              <>
                <LinkButton href="/login" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                  Log in
                </LinkButton>
                <LinkButton href="/register" size="sm" onClick={() => setOpen(false)}>
                  Sign up
                </LinkButton>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
