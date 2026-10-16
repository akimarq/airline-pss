"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Async, Button, Card, EmptyState, ErrorAlert, Input, LinkButton, PageHeader, Pagination, Select, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Flight, Page } from "@/lib/client/types";

export default function StaffFlightsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ flightNumber: "", origin: "", destination: "", status: "" });
  const state = useApi<Page<Flight>>("/api/flights", { query: { ...filters, page, limit: 15 } });
  const action = useAction();

  const setFilter = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  };

  async function cancelFlight(f: Flight) {
    if (!window.confirm(`Cancel flight ${f.flightNumber}? This is blocked while active bookings exist.`)) return;
    if (await action.run(() => apiFetch(`/api/flights/${f.id}`, { method: "DELETE" }))) state.reload();
  }

  // Invalid partial IATA codes would fail validation; only send full codes.
  const codeOk = (v: string) => v === "" || v.length === 3;
  const filterInvalid = !codeOk(filters.origin) || !codeOk(filters.destination);

  return (
    <>
      <PageHeader title="Flights" subtitle="Schedules, cancellations and inventory" actions={<LinkButton href="/staff/flights/new">New flight</LinkButton>} />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Input label="Flight number" placeholder="PS1" value={filters.flightNumber} onChange={setFilter("flightNumber")} />
          <Input label="Origin" maxLength={3} value={filters.origin} onChange={setFilter("origin")} className="uppercase" hint="3-letter code" />
          <Input label="Destination" maxLength={3} value={filters.destination} onChange={setFilter("destination")} className="uppercase" hint="3-letter code" />
          <Select label="Status" value={filters.status} onChange={setFilter("status")}>
            <option value="">All</option>
            {["SCHEDULED", "BOARDING", "CLOSED", "DEPARTED", "CANCELLED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
      </Card>
      <ErrorAlert error={action.error} className="mb-4" />
      {filterInvalid ? (
        <Alert tone="warning">Enter complete 3-letter airport codes to filter by route.</Alert>
      ) : (
        <Async state={state}>
          {(res) =>
            res.data.length === 0 ? (
              <EmptyState title="No flights found" action={<LinkButton href="/staff/flights/new">Create a flight</LinkButton>} />
            ) : (
              <Card padded={false}>
                <Table columns={["Flight", "Route", "Departure", "Arrival", "Status", "Gate", ""]}>
                  {res.data.map((f) => (
                    <Tr key={f.id}>
                      <Td className="font-semibold">{f.flightNumber}</Td>
                      <Td>
                        {f.origin} → {f.destination}
                      </Td>
                      <Td>{fmtDateTime(f.departure)}</Td>
                      <Td>{fmtDateTime(f.arrival)}</Td>
                      <Td>
                        <StatusBadge status={f.status} />
                      </Td>
                      <Td>{f.gate ?? "–"}</Td>
                      <Td className="space-x-3 whitespace-nowrap text-right">
                        <Link href={`/staff/flights/${f.id}`} className="font-medium text-sky-700 hover:underline">
                          Edit
                        </Link>
                        <Link href={`/staff/inventory/${f.id}`} className="font-medium text-sky-700 hover:underline">
                          Inventory
                        </Link>
                        {(f.status === "SCHEDULED" || f.status === "BOARDING") && (
                          <Button size="sm" variant="ghost" className="text-red-600" onClick={() => cancelFlight(f)} disabled={action.busy}>
                            Cancel
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Table>
                <div className="px-4 pb-4">
                  <Pagination page={res.page} totalPages={res.totalPages} onChange={setPage} />
                </div>
              </Card>
            )
          }
        </Async>
      )}
    </>
  );
}
