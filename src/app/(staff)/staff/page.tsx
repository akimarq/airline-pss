"use client";

import Link from "next/link";
import { useState } from "react";
import { Async, Card, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { fmtTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { Flight, Page } from "@/lib/client/types";

const QUICK_LINKS = [
  { href: "/staff/flights", title: "Flights", text: "Schedules, aircraft and inventory creation" },
  { href: "/staff/fares", title: "Fares", text: "Create, edit and deactivate fares" },
  { href: "/staff/inventory", title: "Inventory", text: "Buckets, load factor and revenue rules" },
  { href: "/staff/pnr", title: "PNR desk", text: "Look up, ticket, void and cancel bookings" },
  { href: "/staff/checkin", title: "Check-in desk", text: "Airport check-in and boarding passes" },
  { href: "/staff/baggage", title: "Baggage", text: "Tag bags and track their status" },
  { href: "/staff/load", title: "Load control", text: "Weight & balance and load sheets" },
  { href: "/staff/boarding", title: "Gate boarding", text: "Open, scan, close and depart" },
];

export default function StaffDashboard() {
  const [range] = useState(() => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return { departureFrom: start.toISOString(), departureTo: new Date(start.getTime() + 86_400_000 - 1).toISOString() };
  });
  const state = useApi<Page<Flight>>("/api/flights", { query: { ...range, limit: 100 } });

  return (
    <div className="space-y-8">
      <PageHeader title="Staff dashboard" subtitle="Today's operations (UTC day)" />

      <Async state={state}>
        {({ data: flights }) => {
          const count = (s: string) => flights.filter((f) => f.status === s).length;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Flights today" value={flights.length} />
                <Stat label="Scheduled" value={count("SCHEDULED")} />
                <Stat label="Boarding / closed" value={count("BOARDING") + count("CLOSED")} />
                <Stat label="Departed" value={count("DEPARTED")} />
                <Stat label="Cancelled" value={count("CANCELLED")} />
              </div>
              {flights.length === 0 ? (
                <EmptyState title="No flights scheduled today">Add flights under Flights.</EmptyState>
              ) : (
                <Card title="Flights today" padded={false}>
                  <Table columns={["Flight", "Route", "Dep", "Arr", "Status", "Gate", "Open"]}>
                    {flights.map((f) => (
                      <Tr key={f.id}>
                        <Td className="font-semibold">{f.flightNumber}</Td>
                        <Td>
                          {f.origin} → {f.destination}
                        </Td>
                        <Td>{fmtTime(f.departure)}</Td>
                        <Td>{fmtTime(f.arrival)}</Td>
                        <Td>
                          <StatusBadge status={f.status} />
                        </Td>
                        <Td>{f.gate ?? "–"}</Td>
                        <Td className="space-x-3 whitespace-nowrap text-sm">
                          <Link className="text-sky-700 hover:underline" href={`/staff/inventory/${f.id}`}>Inventory</Link>
                          <Link className="text-sky-700 hover:underline" href={`/staff/load/${f.id}`}>Load</Link>
                          <Link className="text-sky-700 hover:underline" href={`/staff/boarding/${f.id}`}>Gate</Link>
                          <Link className="text-sky-700 hover:underline" href={`/staff/baggage?flightId=${f.id}`}>Bags</Link>
                        </Td>
                      </Tr>
                    ))}
                  </Table>
                </Card>
              )}
            </div>
          );
        }}
      </Async>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Quick links</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-sky-500 hover:shadow">
              <div className="font-semibold text-slate-900">{l.title}</div>
              <div className="mt-1 text-sm text-slate-500">{l.text}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
