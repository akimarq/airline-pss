"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { FlightSelect } from "@/components/flights/FlightPicker";
import { Alert, Async, Badge, Button, Card, Checkbox, EmptyState, ErrorAlert, Input, LoadingBlock, PageHeader, Select, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Baggage, BaggageStatus, Manifest, Pnr } from "@/lib/client/types";

/** Allowed transitions (mirrors the API): CHECKED -> SCREENED -> LOADED; OFFLOADED from any non-final state. */
const NEXT: Record<BaggageStatus, { to: "SCREENED" | "LOADED" | "OFFLOADED"; label: string; danger?: boolean }[]> = {
  CHECKED: [{ to: "SCREENED", label: "Screen" }, { to: "OFFLOADED", label: "Offload", danger: true }],
  SCREENED: [{ to: "LOADED", label: "Load" }, { to: "OFFLOADED", label: "Offload", danger: true }],
  LOADED: [{ to: "OFFLOADED", label: "Offload", danger: true }],
  OFFLOADED: [],
};

function TagForm({ flightId, onTagged }: { flightId: string; onTagged: () => void }) {
  const [locator, setLocator] = useState("");
  const [passengerId, setPassengerId] = useState("");
  const [weight, setWeight] = useState("");
  const [acceptExcess, setAcceptExcess] = useState(false);
  const [last, setLast] = useState<Baggage | null>(null);
  const valid = locator.length === 6;
  const pnr = useApi<{ pnr: Pnr }>(valid ? `/api/pnrs/${locator}` : null);
  const { run, busy, error } = useAction();
  const passengers = pnr.data?.pnr.passengers ?? [];
  const pid = passengerId || (passengers.length === 1 ? passengers[0].id : "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await run(() =>
      apiFetch<{ baggage: Baggage }>("/api/baggage", {
        method: "POST",
        body: { pnrLocator: locator, passengerId: pid, flightId, weightKg: Number(weight), ...(acceptExcess ? { acceptExcess: true } : {}) },
      }),
    );
    if (res) {
      setLast(res.baggage);
      setWeight("");
      onTagged();
    }
  }

  return (
    <Card title="Tag a bag">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Input label="PNR locator" maxLength={6} value={locator} onChange={(e) => { setLocator(e.target.value.toUpperCase()); setPassengerId(""); }} className="font-mono uppercase tracking-widest" required />
          <Select label="Passenger" value={pid} onChange={(e) => setPassengerId(e.target.value)} required disabled={!valid || pnr.loading} error={pnr.error?.message}>
            <option value="">{!valid ? "Enter locator first" : pnr.loading ? "Loading…" : "Select passenger"}</option>
            {passengers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.lastName.toUpperCase()}/{p.firstName.toUpperCase()}
              </option>
            ))}
          </Select>
          <Input label="Weight (kg)" type="number" min={0.1} step="0.1" max={100} value={weight} onChange={(e) => setWeight(e.target.value)} required />
          <div className="flex items-end pb-2">
            <Checkbox label="Accept excess" checked={acceptExcess} onChange={(e) => setAcceptExcess(e.target.checked)} />
          </div>
        </div>
        <p className="text-xs text-slate-500">The passenger must already be checked in on the selected flight.</p>
        <ErrorAlert error={error} />
        {error?.code === "BAGGAGE_OVER_ALLOWANCE" && <Alert tone="info">Tick “Accept excess” to take the bag with an excess-baggage flag.</Alert>}
        {last && (
          <Alert tone="success" title={`Bag tagged: ${last.tagNumber}`}>
            {last.weightKg} kg {last.excess && `· excess ${last.excessKg} kg`}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={!pid || !weight}>
          Tag bag
        </Button>
      </form>
    </Card>
  );
}

function Bags({ flightId }: { flightId: string }) {
  const bags = useApi<{ baggage: Baggage[]; total: number }>("/api/baggage", { query: { flightId, limit: 200 } });
  const manifest = useApi<Manifest>(`/api/flights/${flightId}/boarding`);
  const action = useAction();

  const names = new Map(manifest.data?.passengers.map((p) => [`${p.pnrLocator}:${p.passengerId}`, p.passengerName]) ?? []);

  async function setStatus(b: Baggage, status: string) {
    if (await action.run(() => apiFetch(`/api/baggage/${b.tagNumber}`, { method: "PATCH", body: { status } }))) bags.reload();
  }

  return (
    <div className="space-y-6">
      <TagForm flightId={flightId} onTagged={bags.reload} />
      <ErrorAlert error={action.error} />
      <Async state={bags}>
        {({ baggage, total }) =>
          baggage.length === 0 ? (
            <EmptyState title="No bags on this flight yet">Tag a bag above for a checked-in passenger.</EmptyState>
          ) : (
            <Card title={`Bags on this flight (${total})`} padded={false}>
              <Table columns={["Tag", "PNR", "Passenger", "Weight", "Status", "Updated", "Update status"]}>
                {baggage.map((b) => (
                  <Tr key={b._id}>
                    <Td className="font-mono">{b.tagNumber}</Td>
                    <Td className="font-mono">{b.pnrLocator}</Td>
                    <Td>{names.get(`${b.pnrLocator}:${b.passengerId}`) ?? <span className="text-slate-400">–</span>}</Td>
                    <Td>
                      {b.weightKg} kg {b.excess && <Badge tone="amber">excess {b.excessKg} kg</Badge>}
                    </Td>
                    <Td>
                      <StatusBadge status={b.status} />
                    </Td>
                    <Td>{fmtDateTime(b.history[b.history.length - 1]?.at)}</Td>
                    <Td className="space-x-2 whitespace-nowrap">
                      {NEXT[b.status].length === 0 ? (
                        <span className="text-xs text-slate-400">final</span>
                      ) : (
                        NEXT[b.status].map((n) => (
                          <Button key={n.to} size="sm" variant={n.danger ? "ghost" : "secondary"} className={n.danger ? "text-red-600" : ""} disabled={action.busy} onClick={() => setStatus(b, n.to)}>
                            {n.label}
                          </Button>
                        ))
                      )}
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          )
        }
      </Async>
    </div>
  );
}

function Inner() {
  const [flightId, setFlightId] = useState(useSearchParams().get("flightId") ?? "");
  return (
    <div className="space-y-6">
      <Card>
        <FlightSelect value={flightId} onChange={setFlightId} wrapperClassName="max-w-2xl" />
      </Card>
      {flightId ? <Bags key={flightId} flightId={flightId} /> : <EmptyState title="Select a flight">Choose a flight to tag bags and see its baggage list.</EmptyState>}
    </div>
  );
}

export default function StaffBaggagePage() {
  return (
    <>
      <PageHeader title="Baggage" subtitle="Tag bags for checked-in passengers and move them through screening and loading" />
      <Suspense fallback={<LoadingBlock />}>
        <Inner />
      </Suspense>
    </>
  );
}
