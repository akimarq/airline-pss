"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/staff", label: "Dashboard" },
  { href: "/staff/flights", label: "Flights" },
  { href: "/staff/fares", label: "Fares" },
  { href: "/staff/inventory", label: "Inventory" },
  { href: "/staff/pnr", label: "PNR" },
  { href: "/staff/checkin", label: "Check-in" },
  { href: "/staff/baggage", label: "Baggage" },
  { href: "/staff/load", label: "Load control" },
  { href: "/staff/boarding", label: "Gate" },
];

export function StaffNav() {
  const pathname = usePathname();
  return (
    <nav className="no-print mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 pb-2" aria-label="Staff sections">
      {LINKS.map((l) => {
        const active = l.href === "/staff" ? pathname === "/staff" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
