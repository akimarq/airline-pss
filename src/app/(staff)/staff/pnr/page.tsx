"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Async, Button, Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { fmtDateTime, fmtMoney } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { Page, Pnr } from "@/lib/client/types";

export default function StaffPnrPage() {
  const router = useRouter();
  const [locator, setLocator] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: "", email: "" });
  const state = useApi<Page<Pnr>>("/api/pnrs", { query: { ...filters, page, limit: 15 } });

  function lookup(e: FormEvent) {
    e.preventDefault();
    if (locator.trim()) router.push(`/staff/pnr/${locator.trim().toUpperCase()}`);
  }

  return (
    <>
      <PageHeader title="PNR desk" subtitle="Look up a booking by record locator to view, ticket, void or cancel" />
      <Card className="mb-6">
        <form onSubmit={lookup} className="flex flex-wrap items-end gap-3">
          <Input wrapperClassName="w-full sm:w-64" label="Record locator" placeholder="ABC234" maxLength={6} value={locator} onChange={(e) => setLocator(e.target.value.toUpperCase())} className="font-mono uppercase tracking-widest" />
          <Button type="submit" disabled={locator.trim().length !== 6}>
            Open PNR
          </Button>
        </form>
      </Card>

      <Card title="Recent bookings" className="mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Status" value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })); }}>
            <option value="">All</option>
            {["HELD", "CONFIRMED", "TICKETED", "CANCELLED", "EXPIRED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Input label="Contact email" type="search" value={filters.email} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, email: e.target.value })); }} />
        </div>
      </Card>
      <Async state={state}>
        {(res) =>
          res.data.length === 0 ? (
            <EmptyState title="No bookings match" />
          ) : (
            <Card padded={false}>
              <Table columns={["Locator", "Flights", "Passengers", "Contact", "Created", "Total", "Status", ""]}>
                {res.data.map((p) => (
                  <Tr key={p.id}>
                    <Td className="font-mono font-semibold">{p.recordLocator}</Td>
                    <Td>{p.segments.map((s) => s.flight?.flightNumber ?? "?").join(", ")}</Td>
                    <Td>{p.passengers.map((x) => `${x.lastName}/${x.firstName}`).join("; ")}</Td>
                    <Td>{p.contact.email}</Td>
                    <Td>{fmtDateTime(p.createdAt)}</Td>
                    <Td>{fmtMoney(p.totalAmount, p.currency)}</Td>
                    <Td>
                      <StatusBadge status={p.status} />
                    </Td>
                    <Td className="text-right">
                      <Link href={`/staff/pnr/${p.recordLocator}`} className="font-medium text-sky-700 hover:underline">
                        Open
                      </Link>
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
    </>
  );
}
