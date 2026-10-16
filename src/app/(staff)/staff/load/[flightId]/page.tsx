"use client";

import { use, useState, type FormEvent } from "react";
import { Alert, Async, Button, Card, ErrorAlert, Input, KeyValue, LinkButton, PageHeader, ProgressBar, Stat, StatusBadge, Table, Td, Tr, Badge } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Flight, LoadView } from "@/lib/client/types";

const kg = (n: number) => `${Math.round(n).toLocaleString("en-US")} kg`;

function LimitRow({ label, value, max }: { label: string; value: number; max: number }) {
  const over = value > max;
  return (
    <Tr>
      <Td className="font-medium">{label}</Td>
      <Td className={over ? "font-semibold text-red-600" : ""}>{kg(value)}</Td>
      <Td>{kg(max)}</Td>
      <Td className="w-40">
        <ProgressBar value={value} max={max} />
      </Td>
      <Td>{over ? <Badge tone="red">Over limit</Badge> : value >= max * 0.95 ? <Badge tone="amber">Near limit</Badge> : <Badge tone="green">OK</Badge>}</Td>
    </Tr>
  );
}

function Inputs({ flightId, view, onChanged }: { flightId: string; view: LoadView; onChanged: () => void }) {
  const [cargo, setCargo] = useState(String(view.load.cargoWeightKg));
  const [fuel, setFuel] = useState(String(view.load.fuelWeightKg));
  const save = useAction();
  const finalize = useAction();
  const reopen = useAction();
  const isFinal = view.loadSheetStatus === "FINAL";
  const base = `/api/flights/${flightId}/load`;

  async function saveDraft(e: FormEvent) {
    e.preventDefault();
    if (await save.run(() => apiFetch(base, { method: "POST", body: { cargoWeightKg: Number(cargo), fuelWeightKg: Number(fuel) } }))) onChanged();
  }
  async function doFinalize() {
    finalize.clear();
    if (await finalize.run(() => apiFetch(`${base}/finalize`, { method: "POST" }))) onChanged();
  }
  async function doReopen() {
    if (await reopen.run(() => apiFetch(`${base}/reopen`, { method: "POST" }))) onChanged();
  }
  const fe = save.error?.fieldErrors ?? {};

  return (
    <Card title="Cargo & fuel">
      <form onSubmit={saveDraft} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Cargo weight (kg)" type="number" min={0} step="any" value={cargo} onChange={(e) => setCargo(e.target.value)} disabled={isFinal} required error={fe.cargoWeightKg} />
          <Input label="Fuel weight (kg)" type="number" min={0} step="any" value={fuel} onChange={(e) => setFuel(e.target.value)} disabled={isFinal} required error={fe.fuelWeightKg} />
        </div>
        <ErrorAlert error={save.error} />
        <ErrorAlert error={finalize.error} />
        <ErrorAlert error={reopen.error} />
        <div className="flex flex-wrap gap-2">
          {!isFinal && (
            <Button type="submit" variant="secondary" loading={save.busy}>
              Save draft
            </Button>
          )}
          {!isFinal && (
            <Button type="button" variant="success" onClick={doFinalize} loading={finalize.busy} disabled={view.loadSheetStatus === null}>
              Finalize load sheet
            </Button>
          )}
          {isFinal && (
            <Button type="button" variant="danger" onClick={doReopen} loading={reopen.busy}>
              Reopen (back to draft)
            </Button>
          )}
        </div>
        {view.loadSheetStatus === null && <p className="text-xs text-slate-500">Save a draft first; a draft is required before finalizing.</p>}
      </form>
    </Card>
  );
}

function Detail({ flightId }: { flightId: string }) {
  const state = useApi<LoadView>(`/api/flights/${flightId}/load`);
  const flight = useApi<{ flight: Flight }>(`/api/flights/${flightId}`);
  const f = flight.data?.flight;

  return (
    <>
      <PageHeader
        title={f ? `Load control · ${f.flightNumber}` : "Load control"}
        subtitle={f ? `${f.origin} → ${f.destination} · ${fmtDateTime(f.departure)}` : undefined}
        actions={
          <>
            {f && <StatusBadge status={f.status} />}
            <LinkButton href="/staff/load" variant="secondary">
              All flights
            </LinkButton>
            <Button variant="secondary" onClick={state.reload}>
              Refresh
            </Button>
          </>
        }
      />
      <Async state={state}>
        {(view) => {
          const l = view.load;
          return (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-500">Load sheet:</span>
                {view.loadSheetStatus ? <StatusBadge status={view.loadSheetStatus} /> : <Badge>NOT STARTED</Badge>}
                {view.loadSheet?.finalizedAt && <span className="text-xs text-slate-500">finalized {fmtDateTime(view.loadSheet.finalizedAt)}</span>}
                {l.withinLimits ? <Badge tone="green">Within limits</Badge> : <Badge tone="red">Limits exceeded</Badge>}
              </div>
              {view.outOfDate && (
                <Alert tone="warning" title="Finalized sheet is out of date">
                  Check-ins or baggage changed after finalization. Reopen and finalize again to refresh the totals.
                </Alert>
              )}
              {l.warnings.length > 0 && (
                <Alert tone={l.withinLimits ? "warning" : "error"} title="Warnings">
                  <ul className="list-inside list-disc">
                    {l.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Passengers (excl. infants)" value={l.passengerCount} hint={`${l.adults} adults · ${l.children} children · ${l.infants} infants`} />
                <Stat label="Bags" value={l.baggageCount} hint={kg(l.baggageWeightKg)} />
                <Stat label="Zero-fuel weight" value={kg(l.zeroFuelWeightKg)} />
                <Stat label="Takeoff weight" value={kg(l.takeoffWeightKg)} />
              </div>

              <Card title="Weights vs aircraft limits" padded={false}>
                <Table columns={["Item", "Actual", "Maximum", "", "Status"]}>
                  <LimitRow label="Zero-fuel weight" value={l.zeroFuelWeightKg} max={l.limits.maxZeroFuelWeightKg} />
                  <LimitRow label="Takeoff weight" value={l.takeoffWeightKg} max={l.limits.maxTakeoffWeightKg} />
                  <LimitRow label="Payload" value={l.payloadKg} max={l.limits.maxPayloadKg} />
                  <LimitRow label="Cargo" value={l.cargoWeightKg} max={l.limits.maxCargoWeightKg} />
                </Table>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Inputs key={`${view.loadSheetStatus}:${l.cargoWeightKg}:${l.fuelWeightKg}`} flightId={flightId} view={view} onChanged={state.reload} />
                <Card title="Breakdown">
                  <KeyValue
                    items={[
                      ["Operating empty weight", kg(l.limits.operatingEmptyWeightKg)],
                      ["Passenger weight", kg(l.passengerWeightKg)],
                      ["Baggage weight", kg(l.baggageWeightKg)],
                      ["Cargo weight", kg(l.cargoWeightKg)],
                      ["Payload", kg(l.payloadKg)],
                      ["Fuel weight", kg(l.fuelWeightKg)],
                    ]}
                  />
                  <p className="mt-3 text-xs text-slate-500">Passenger, baggage and weight figures are computed live from check-ins and tagged bags.</p>
                </Card>
              </div>
            </div>
          );
        }}
      </Async>
    </>
  );
}

export default function LoadDetailPage({ params }: { params: Promise<{ flightId: string }> }) {
  const { flightId } = use(params);
  return <Detail flightId={flightId} />;
}
