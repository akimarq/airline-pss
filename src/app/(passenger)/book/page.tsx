"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/layout/Guards";
import { Alert, Async, Badge, Button, Card, ErrorAlert, Input, LinkButton, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";
import { CABIN_NAMES, PASSENGER_TYPE_LABELS, fmtDate, fmtDuration, fmtMoney, fmtTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Flight, OfferedFare, PassengerType, Pnr } from "@/lib/client/types";

interface PaxForm {
  firstName: string;
  lastName: string;
  type: PassengerType;
  dateOfBirth: string;
}

function BookingForm({ flight, fare, count }: { flight: Flight; fare: OfferedFare; count: number }) {
  const { user } = useAuth();
  const router = useRouter();
  const { run, busy, error } = useAction();
  const [pax, setPax] = useState<PaxForm[]>(() => Array.from({ length: count }, () => ({ firstName: "", lastName: "", type: "ADULT", dateOfBirth: "" })));
  const [contact, setContact] = useState({ email: user?.email ?? "", phone: "" });
  const fe = error?.fieldErrors ?? {};

  const seats = pax.filter((p) => p.type !== "INFANT").length;
  const total = fare.price * seats;

  const setP = (i: number, patch: Partial<PaxForm>) => setPax((list) => list.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await run(() =>
      apiFetch<{ pnr: Pnr }>("/api/pnrs", {
        method: "POST",
        body: {
          passengers: pax.map((p) => ({
            firstName: p.firstName,
            lastName: p.lastName,
            type: p.type,
            ...(p.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}),
          })),
          segments: [{ flightId: flight.id, bookingClass: fare.bookingClass, fareId: fare.fareId }],
          contact: { email: contact.email, ...(contact.phone ? { phone: contact.phone } : {}) },
        },
      }),
    );
    if (res) router.push(`/book/pay/${res.pnr.recordLocator}`);
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {pax.map((p, i) => (
          <Card key={i} title={`Passenger ${i + 1}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="First name" value={p.firstName} onChange={(e) => setP(i, { firstName: e.target.value })} required error={fe[`passengers.${i}.firstName`]} />
              <Input label="Last name" value={p.lastName} onChange={(e) => setP(i, { lastName: e.target.value })} required error={fe[`passengers.${i}.lastName`]} />
              <Select label="Passenger type" value={p.type} onChange={(e) => setP(i, { type: e.target.value as PassengerType })}>
                {(Object.keys(PASSENGER_TYPE_LABELS) as PassengerType[]).map((t) => (
                  <option key={t} value={t}>
                    {PASSENGER_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
              <Input label="Date of birth (optional)" type="date" value={p.dateOfBirth} onChange={(e) => setP(i, { dateOfBirth: e.target.value })} error={fe[`passengers.${i}.dateOfBirth`]} />
            </div>
          </Card>
        ))}
        <Card title="Contact details">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Email" type="email" value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} required error={fe["contact.email"]} />
            <Input label="Phone (optional)" type="tel" value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} error={fe["contact.phone"]} />
          </div>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card title="Your flight">
          <div className="text-sm">
            <div className="font-semibold text-slate-900">
              {flight.flightNumber} · {flight.origin} → {flight.destination}
            </div>
            <div className="mt-1 text-slate-600">
              {fmtDate(flight.departure)}
              <br />
              {fmtTime(flight.departure)} – {fmtTime(flight.arrival)} ({fmtDuration(Math.round((+new Date(flight.arrival) - +new Date(flight.departure)) / 60000))})
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              <Badge tone="blue">
                {CABIN_NAMES[fare.cabin]} · {fare.bookingClass}
              </Badge>
              <Badge>{fare.rules.checkedBaggageKg} kg bag</Badge>
              <Badge tone={fare.rules.refundable ? "green" : "gray"}>{fare.rules.refundable ? "Refundable" : "Non-refundable"}</Badge>
            </div>
          </div>
          <div className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>
                {fmtMoney(fare.price, fare.currency)} × {seats} seat{seats === 1 ? "" : "s"}
              </span>
              <span>{fmtMoney(total, fare.currency)}</span>
            </div>
            {pax.some((p) => p.type === "INFANT") && <div className="text-xs text-slate-500">Lap infants travel free and need no seat.</div>}
            <div className="flex justify-between text-base font-semibold text-slate-900">
              <span>Total</span>
              <span>{fmtMoney(total, fare.currency)}</span>
            </div>
          </div>
        </Card>
        {error && Object.keys(fe).length === 0 && <ErrorAlert error={error} />}
        {error && Object.keys(fe).length > 0 && <Alert tone="error">Please fix the highlighted fields.</Alert>}
        <Button type="submit" loading={busy} className="w-full">
          Hold seats &amp; continue to payment
        </Button>
        <p className="text-center text-xs text-slate-500">Seats are held for 15 minutes.</p>
      </aside>
    </form>
  );
}

function BookInner() {
  const sp = useSearchParams();
  const flightId = sp.get("flightId");
  const fareId = sp.get("fareId");
  const count = Math.min(9, Math.max(1, Number(sp.get("passengers")) || 1));

  const flight = useApi<{ flight: Flight }>(flightId ? `/api/flights/${flightId}` : null);
  const fares = useApi<{ fares: OfferedFare[] }>(flightId ? `/api/flights/${flightId}/fares` : null, { query: { passengers: count } });

  if (!flightId || !fareId) {
    return (
      <Alert tone="warning" title="No fare selected">
        Start by <Link href="/search" className="underline">searching for a flight</Link>.
      </Alert>
    );
  }

  return (
    <Async state={flight}>
      {({ flight: f }) => (
        <Async state={fares}>
          {({ fares: list }) => {
            const fare = list.find((x) => x.fareId === fareId);
            return fare ? (
              <BookingForm flight={f} fare={fare} count={count} />
            ) : (
              <div className="space-y-3">
                <Alert tone="warning" title="That fare is no longer available">
                  The fare was sold out or closed for {count} passenger{count === 1 ? "" : "s"}. Please pick another one.
                </Alert>
                <LinkButton href={`/search?from=${f.origin}&to=${f.destination}&date=${f.departure.slice(0, 10)}&passengers=${count}`} variant="secondary">
                  Back to results
                </LinkButton>
              </div>
            );
          }}
        </Async>
      )}
    </Async>
  );
}

export default function BookPage() {
  return (
    <RequireAuth>
      <PageHeader title="Passenger details" subtitle="Step 1 of 2 · enter names exactly as on the travel document" />
      <Suspense fallback={<LoadingBlock />}>
        <BookInner />
      </Suspense>
    </RequireAuth>
  );
}
