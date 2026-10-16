"use client";

import Link from "next/link";
import { useState } from "react";
import { RequireAuth } from "@/components/layout/Guards";
import { Async, EmptyState, LinkButton, PageHeader, Pagination, StatusBadge, Table, Td, Tr, Card } from "@/components/ui";
import { fmtDateTime, fmtMoney } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { Page, Pnr } from "@/lib/client/types";

function BookingsList() {
  const [page, setPage] = useState(1);
  const state = useApi<Page<Pnr>>("/api/pnrs", { query: { page, limit: 10 } });

  return (
    <Async state={state}>
      {(res) =>
        res.data.length === 0 ? (
          <EmptyState title="No bookings yet" action={<LinkButton href="/">Search flights</LinkButton>}>
            When you book a trip it will show up here.
          </EmptyState>
        ) : (
          <Card padded={false}>
            <Table columns={["Locator", "Flights", "Departs", "Passengers", "Total", "Status", ""]}>
              {res.data.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-mono font-semibold">{p.recordLocator}</Td>
                  <Td>{p.segments.map((s) => (s.flight ? `${s.flight.flightNumber} ${s.flight.origin}→${s.flight.destination}` : "–")).join(", ")}</Td>
                  <Td>{fmtDateTime(p.segments[0]?.flight?.departure)}</Td>
                  <Td>{p.passengers.length}</Td>
                  <Td>{fmtMoney(p.totalAmount, p.currency)}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td className="text-right">
                    <Link href={`/bookings/${p.recordLocator}`} className="font-medium text-sky-700 hover:underline">
                      View
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
  );
}

export default function BookingsPage() {
  return (
    <RequireAuth>
      <PageHeader title="My bookings" subtitle="Manage, pay for, cancel and check in to your trips" actions={<LinkButton href="/">New search</LinkButton>} />
      <BookingsList />
    </RequireAuth>
  );
}
