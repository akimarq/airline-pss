"use client";

import Link from "next/link";
import { useState } from "react";
import { Async, Card, EmptyState, Input, Select, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { fmtDateTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { Flight, Page } from "@/lib/client/types";

const DAY = 86_400_000;

/** Flights from yesterday onwards (stable query so the fetch does not repeat on every render). */
export function useRecentFlights() {
  const [from] = useState(() => new Date(Date.now() - DAY).toISOString());
  return useApi<Page<Flight>>("/api/flights", { query: { departureFrom: from, limit: 100 } });
}

/** A searchable table of flights with a link to a per-flight staff screen. */
export function FlightPicker({ hrefFor, actionLabel }: { hrefFor: (f: Flight) => string; actionLabel: string }) {
  const state = useRecentFlights();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Search flight / airport" placeholder="PS101, MNL…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["SCHEDULED", "BOARDING", "CLOSED", "DEPARTED", "CANCELLED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
      </Card>
      <Async state={state}>
        {(res) => {
          const needle = q.trim().toUpperCase();
          const rows = res.data.filter((f) => (!status || f.status === status) && (!needle || `${f.flightNumber} ${f.origin} ${f.destination}`.includes(needle)));
          if (rows.length === 0) return <EmptyState title="No flights match">Create flights under Flights, or change the filters.</EmptyState>;
          return (
            <Card padded={false}>
              <Table columns={["Flight", "Route", "Departure", "Status", "Gate", ""]}>
                {rows.map((f) => (
                  <Tr key={f.id}>
                    <Td className="font-semibold">{f.flightNumber}</Td>
                    <Td>
                      {f.origin} → {f.destination}
                    </Td>
                    <Td>{fmtDateTime(f.departure)}</Td>
                    <Td>
                      <StatusBadge status={f.status} />
                    </Td>
                    <Td>{f.gate ?? "–"}</Td>
                    <Td className="text-right">
                      <Link href={hrefFor(f)} className="font-medium text-sky-700 hover:underline">
                        {actionLabel}
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          );
        }}
      </Async>
    </div>
  );
}

/** Dropdown of recent/upcoming flights. */
export function FlightSelect({ value, onChange, label = "Flight", includeEmpty = true, wrapperClassName }: { value: string; onChange: (id: string) => void; label?: string; includeEmpty?: boolean; wrapperClassName?: string }) {
  const state = useRecentFlights();
  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} wrapperClassName={wrapperClassName} disabled={state.loading} error={state.error?.message}>
      {includeEmpty && <option value="">{state.loading ? "Loading flights…" : "Select a flight"}</option>}
      {state.data?.data.map((f) => (
        <option key={f.id} value={f.id}>
          {f.flightNumber} · {f.origin}→{f.destination} · {fmtDateTime(f.departure)} · {f.status}
        </option>
      ))}
    </Select>
  );
}
