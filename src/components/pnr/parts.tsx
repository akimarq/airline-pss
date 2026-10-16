"use client";

import { useEffect, useRef } from "react";
import { Badge, Card, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { CABIN_NAMES, PASSENGER_TYPE_LABELS, fmtCountdown, fmtDateTime, fmtMoney, fmtTime } from "@/lib/client/format";
import { useNow } from "@/lib/client/hooks";
import type { Pnr } from "@/lib/client/types";

/** mm:ss until the hold expires; calls `onExpire` once when it hits zero. */
export function HoldCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const now = useNow(1000);
  const remaining = new Date(expiresAt).getTime() - now;
  const fired = useRef(false);

  useEffect(() => {
    if (remaining <= 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [remaining, onExpire]);

  if (remaining <= 0) return <Badge tone="red">Hold expired</Badge>;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-lg font-semibold ${remaining < 120_000 ? "text-red-600" : "text-amber-700"}`} aria-live="polite">
      ⏱ {fmtCountdown(remaining)}
    </span>
  );
}

export function ItineraryCard({ pnr }: { pnr: Pnr }) {
  return (
    <Card title="Itinerary" padded={false}>
      <Table columns={["Flight", "Route", "Departs", "Arrives", "Cabin / class", "Fare", "Status"]}>
        {pnr.segments.map((s, i) => (
          <Tr key={i}>
            <Td className="font-medium">{s.flight?.flightNumber ?? "–"}</Td>
            <Td>{s.flight ? `${s.flight.origin} → ${s.flight.destination}` : "–"}</Td>
            <Td>{fmtDateTime(s.flight?.departure)}</Td>
            <Td>{fmtTime(s.flight?.arrival)}</Td>
            <Td>
              {CABIN_NAMES[s.cabin]} · {s.bookingClass}
            </Td>
            <Td>{fmtMoney(s.fareAmount, pnr.currency)}</Td>
            <Td>{s.flight ? <StatusBadge status={s.flight.status} /> : "–"}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}

export function PassengersCard({ pnr }: { pnr: Pnr }) {
  return (
    <Card title="Passengers" padded={false}>
      <Table columns={["Name", "Type", "Date of birth"]}>
        {pnr.passengers.map((p) => (
          <Tr key={p.id}>
            <Td className="font-medium">
              {p.lastName.toUpperCase()}/{p.firstName.toUpperCase()}
            </Td>
            <Td>{PASSENGER_TYPE_LABELS[p.type]}</Td>
            <Td>{p.dateOfBirth ? p.dateOfBirth.slice(0, 10) : "–"}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}
