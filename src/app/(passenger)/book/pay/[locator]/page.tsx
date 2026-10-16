"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/layout/Guards";
import { HoldCountdown, ItineraryCard, PassengersCard } from "@/components/pnr/parts";
import { Alert, Async, Button, Card, ErrorAlert, LinkButton, PageHeader, Select, StatusBadge } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtMoney } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Pnr, Ticket } from "@/lib/client/types";

function PayInner({ locator }: { locator: string }) {
  const router = useRouter();
  const state = useApi<{ pnr: Pnr; tickets: Ticket[] }>(`/api/pnrs/${locator}`);
  const pay = useAction();
  const cancel = useAction();
  const [method, setMethod] = useState("Credit card");
  const [simulate, setSimulate] = useState<"success" | "fail">("success");

  const status = state.data?.pnr.status;
  useEffect(() => {
    if (status === "TICKETED") router.replace(`/bookings/${locator}?confirmed=1`);
  }, [status, locator, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await pay.run(() => apiFetch(`/api/pnrs/${locator}/tickets`, { method: "POST", body: { payment: { method, simulate } } }));
    if (res) router.push(`/bookings/${locator}?confirmed=1`);
    else state.reload(); // a declined payment leaves the PNR HELD; an expired one flips to EXPIRED
  }

  async function cancelBooking() {
    if (!window.confirm("Release these seats and cancel the booking?")) return;
    const res = await cancel.run(() => apiFetch(`/api/pnrs/${locator}/cancel`, { method: "POST" }));
    if (res) router.push("/bookings");
  }

  return (
    <Async state={state}>
      {({ pnr }) => {
        if (pnr.status !== "HELD") {
          return (
            <div className="space-y-3">
              <Alert tone={pnr.status === "TICKETED" ? "success" : "warning"} title={`Booking ${pnr.recordLocator} is ${pnr.status}`}>
                {pnr.status === "EXPIRED" ? "The 15-minute seat hold ran out. Please search again to rebook." : "No payment is needed for this booking."}
              </Alert>
              <LinkButton href={`/bookings/${pnr.recordLocator}`} variant="secondary">
                View booking
              </LinkButton>
            </div>
          );
        }
        return (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Alert tone="info" title="Your seats are on hold">
                Booking reference <span className="font-mono font-semibold">{pnr.recordLocator}</span>. Complete payment before the hold runs out.
              </Alert>
              <ItineraryCard pnr={pnr} />
              <PassengersCard pnr={pnr} />
            </div>
            <aside className="lg:sticky lg:top-20 lg:self-start">
              <Card title="Payment (simulated)">
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-sm text-slate-500">Time left to pay</span>
                  {pnr.holdExpiresAt && <HoldCountdown expiresAt={pnr.holdExpiresAt} onExpire={state.reload} />}
                </div>
                <form onSubmit={submit} className="space-y-4">
                  <Select label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option>Credit card</option>
                    <option>Debit card</option>
                    <option>Digital wallet</option>
                  </Select>
                  <fieldset>
                    <legend className="mb-1 text-sm font-medium text-slate-700">Simulated outcome</legend>
                    <div className="space-y-1 text-sm">
                      {(["success", "fail"] as const).map((o) => (
                        <label key={o} className="flex items-center gap-2">
                          <input type="radio" name="simulate" checked={simulate === o} onChange={() => setSimulate(o)} className="text-sky-700" />
                          {o === "success" ? "Payment succeeds" : "Payment is declined"}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-semibold">
                    <span>Total</span>
                    <span>{fmtMoney(pnr.totalAmount, pnr.currency)}</span>
                  </div>
                  <ErrorAlert error={pay.error} />
                  <ErrorAlert error={cancel.error} />
                  <Button type="submit" loading={pay.busy} variant={simulate === "success" ? "primary" : "danger"} className="w-full">
                    Pay {fmtMoney(pnr.totalAmount, pnr.currency)}
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={cancelBooking} loading={cancel.busy}>
                    Cancel booking
                  </Button>
                </form>
                <p className="mt-3 text-center text-xs text-slate-500">
                  Status: <StatusBadge status={pnr.status} /> · <Link href="/bookings" className="underline">My bookings</Link>
                </p>
              </Card>
            </aside>
          </div>
        );
      }}
    </Async>
  );
}

export default function PayPage({ params }: { params: Promise<{ locator: string }> }) {
  const { locator } = use(params);
  return (
    <RequireAuth>
      <PageHeader title="Payment" subtitle="Step 2 of 2 · confirm and pay to issue your tickets" />
      <PayInner locator={locator.toUpperCase()} />
    </RequireAuth>
  );
}
