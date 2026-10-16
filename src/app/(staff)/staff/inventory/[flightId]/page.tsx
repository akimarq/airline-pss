"use client";

import { use, useState, type FormEvent } from "react";
import { Alert, Async, Badge, Button, Card, EmptyState, ErrorAlert, Input, LinkButton, PageHeader, ProgressBar, Stat, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { CABIN_NAMES, fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Bucket, Flight, Inventory, InventoryCabin, LoadFactorRule, RuleChange, TimeToDepartureRule } from "@/lib/client/types";

function BucketRow({ flightId, bucket, cabinCapacity, onChanged }: { flightId: string; bucket: Bucket; cabinCapacity: number; onChanged: () => void }) {
  const [authorized, setAuthorized] = useState(String(bucket.authorized));
  const { run, busy, error } = useAction();
  const url = `/api/inventory/${flightId}/buckets/${bucket.class}`;
  const patch = async (body: Record<string, unknown>) => {
    if (await run(() => apiFetch(url, { method: "PATCH", body }))) onChanged();
  };
  const dirty = Number(authorized) !== bucket.authorized;

  return (
    <>
      <Tr>
        <Td className="font-mono text-base font-semibold">{bucket.class}</Td>
        <Td>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={cabinCapacity}
              value={authorized}
              onChange={(e) => setAuthorized(e.target.value)}
              aria-label={`Authorization for class ${bucket.class}`}
              className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            {dirty && (
              <Button size="sm" onClick={() => patch({ authorized: Number(authorized) })} loading={busy}>
                Save
              </Button>
            )}
          </div>
        </Td>
        <Td>{bucket.sold}</Td>
        <Td>{bucket.held}</Td>
        <Td className="font-medium">{bucket.available}</Td>
        <Td>{bucket.open ? <Badge tone="green">Open</Badge> : <Badge tone="red">Closed</Badge>}</Td>
        <Td>{bucket.source ? <Badge tone={bucket.source === "manual" ? "amber" : "blue"}>{bucket.source}</Badge> : <span className="text-slate-400">–</span>}</Td>
        <Td className="space-x-2 whitespace-nowrap text-right">
          <Button size="sm" variant={bucket.open ? "secondary" : "success"} onClick={() => patch({ open: !bucket.open })} disabled={busy}>
            {bucket.open ? "Close" : "Open"}
          </Button>
          {bucket.source === "manual" && (
            <Button size="sm" variant="ghost" onClick={() => patch({ releaseToRules: true })} disabled={busy} title="Let the rules engine control this bucket again">
              Release to rules
            </Button>
          )}
        </Td>
      </Tr>
      {error && (
        <tr>
          <td colSpan={8} className="px-3 pb-2">
            <ErrorAlert error={error} />
          </td>
        </tr>
      )}
    </>
  );
}

function CabinCard({ flightId, cabin, onChanged }: { flightId: string; cabin: InventoryCabin; onChanged: () => void }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          {CABIN_NAMES[cabin.cabin]} <span className="font-normal text-slate-500">capacity {cabin.capacity}</span>
        </span>
      }
      actions={
        <span className="text-sm text-slate-600">
          Load factor <b>{cabin.loadFactorPct}%</b> · sold {cabin.sold} · held {cabin.held}
        </span>
      }
      padded={false}
    >
      <div className="px-5 pt-4">
        <ProgressBar value={cabin.loadFactorPct} />
      </div>
      <Table columns={["Class", "Authorized", "Sold", "Held", "Open seats", "State", "Source", ""]} className="mt-3">
        {cabin.buckets.map((b) => (
          <BucketRow key={`${b.class}:${b.authorized}:${b.open}:${b.source}`} flightId={flightId} bucket={b} cabinCapacity={cabin.capacity} onChanged={onChanged} />
        ))}
      </Table>
    </Card>
  );
}

const parseClasses = (s: string) => s.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);

function RulesEditor({ flightId, inv, onSaved }: { flightId: string; inv: Inventory; onSaved: () => void }) {
  const [lf, setLf] = useState(() => inv.loadFactorRules.map((r) => ({ threshold: String(r.thresholdPct), classes: r.closeClasses.join(", ") })));
  const [ttd, setTtd] = useState(() => inv.timeToDepartureRules.map((r) => ({ days: String(r.daysBeforeDeparture), classes: r.closeClasses.join(", ") })));
  const { run, busy, error } = useAction();
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const loadFactorRules: LoadFactorRule[] = lf.map((r) => ({ thresholdPct: Number(r.threshold), closeClasses: parseClasses(r.classes) }));
    const timeToDepartureRules: TimeToDepartureRule[] = ttd.map((r) => ({ daysBeforeDeparture: Number(r.days), closeClasses: parseClasses(r.classes) }));
    const res = await run(() => apiFetch(`/api/inventory/${flightId}/rules`, { method: "PUT", body: { loadFactorRules, timeToDepartureRules } }));
    if (res) {
      setSaved(true);
      onSaved();
    }
  }

  const touch = () => setSaved(false);

  return (
    <Card title="Revenue rules">
      <form onSubmit={save} className="space-y-6">
        <section>
          <h3 className="text-sm font-semibold text-slate-700">Load-factor rules</h3>
          <p className="mb-2 text-xs text-slate-500">Close the listed classes while the cabin load factor (sold + held) is at or above the threshold.</p>
          <div className="space-y-2">
            {lf.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Input label={i === 0 ? "Threshold %" : undefined} type="number" min={0} max={100} wrapperClassName="w-28" value={r.threshold} onChange={(e) => { touch(); setLf((l) => l.map((x, j) => (j === i ? { ...x, threshold: e.target.value } : x))); }} required />
                <Input label={i === 0 ? "Close classes (comma separated)" : undefined} wrapperClassName="w-64" placeholder="Q, K" value={r.classes} onChange={(e) => { touch(); setLf((l) => l.map((x, j) => (j === i ? { ...x, classes: e.target.value } : x))); }} required />
                <Button variant="ghost" size="sm" onClick={() => { touch(); setLf((l) => l.filter((_, j) => j !== i)); }}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => { touch(); setLf((l) => [...l, { threshold: "80", classes: "" }]); }}>
              + Add load-factor rule
            </Button>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-slate-700">Time-to-departure rules</h3>
          <p className="mb-2 text-xs text-slate-500">Close the listed classes once departure is within the given number of days.</p>
          <div className="space-y-2">
            {ttd.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Input label={i === 0 ? "Days before departure" : undefined} type="number" min={0} wrapperClassName="w-28" value={r.days} onChange={(e) => { touch(); setTtd((l) => l.map((x, j) => (j === i ? { ...x, days: e.target.value } : x))); }} required />
                <Input label={i === 0 ? "Close classes (comma separated)" : undefined} wrapperClassName="w-64" placeholder="Q, K" value={r.classes} onChange={(e) => { touch(); setTtd((l) => l.map((x, j) => (j === i ? { ...x, classes: e.target.value } : x))); }} required />
                <Button variant="ghost" size="sm" onClick={() => { touch(); setTtd((l) => l.filter((_, j) => j !== i)); }}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => { touch(); setTtd((l) => [...l, { days: "7", classes: "" }]); }}>
              + Add time-to-departure rule
            </Button>
          </div>
        </section>

        <ErrorAlert error={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy}>
            Save rules
          </Button>
          {saved && <span className="text-sm text-emerald-700">Rules saved and re-applied.</span>}
        </div>
      </form>
    </Card>
  );
}

function Detail({ flightId }: { flightId: string }) {
  const state = useApi<{ inventory: Inventory }>(`/api/inventory/${flightId}`);
  const flight = useApi<{ flight: Flight }>(`/api/flights/${flightId}`);
  const reprice = useAction();
  const create = useAction();
  const [changes, setChanges] = useState<RuleChange[] | null>(null);

  async function doReprice() {
    const res = await reprice.run(() => apiFetch<{ changes: RuleChange[] }>(`/api/inventory/${flightId}/reprice`, { method: "POST" }));
    if (res) {
      setChanges(res.changes);
      state.reload();
    }
  }
  async function createInventory() {
    if (await create.run(() => apiFetch(`/api/inventory/${flightId}`, { method: "POST", body: {} }))) state.reload();
  }

  const f = flight.data?.flight;
  const header = (actions?: React.ReactNode) => (
    <PageHeader
      title={f ? `Inventory · ${f.flightNumber}` : "Inventory"}
      subtitle={f ? `${f.origin} → ${f.destination} · ${fmtDateTime(f.departure)}` : undefined}
      actions={
        <>
          {f && <StatusBadge status={f.status} />}
          <LinkButton href="/staff/inventory" variant="secondary">
            All flights
          </LinkButton>
          {actions}
        </>
      }
    />
  );

  if (state.error?.status === 404) {
    return (
      <>
        {header()}
        <EmptyState title="No inventory for this flight" action={<Button onClick={createInventory} loading={create.busy}>Create inventory from aircraft layout</Button>}>
          Flights cannot be sold until inventory exists.
        </EmptyState>
        <ErrorAlert error={create.error} className="mt-3" />
      </>
    );
  }

  return (
    <>
      {header(
        <Button onClick={doReprice} loading={reprice.busy}>
          Reprice
        </Button>,
      )}
      <ErrorAlert error={reprice.error} className="mb-4" />
      {changes && (
        <Alert tone={changes.length ? "info" : "success"} title={changes.length ? `Rules engine made ${changes.length} change(s)` : "Reprice complete: no changes needed"} className="mb-4">
          {changes.length > 0 && (
            <ul className="list-inside list-disc">
              {changes.map((c, i) => (
                <li key={i}>
                  {c.class} ({CABIN_NAMES[c.cabin]}) {c.action.toLowerCase()} – {c.reason}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <Async state={state}>
        {({ inventory: inv }) => (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Capacity" value={inv.capacity} />
              <Stat label="Sold" value={inv.sold} />
              <Stat label="Held" value={inv.held} />
              <Stat label="Load factor" value={`${inv.loadFactorPct}%`} hint={<ProgressBar value={inv.loadFactorPct} />} />
            </div>
            {inv.cabins.map((c) => (
              <CabinCard key={c.cabin} flightId={flightId} cabin={c} onChanged={state.reload} />
            ))}
            <RulesEditor key={JSON.stringify([inv.loadFactorRules, inv.timeToDepartureRules])} flightId={flightId} inv={inv} onSaved={state.reload} />
            <Card title="Active seat holds" padded={false}>
              {inv.holds.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">No seats are currently held.</p>
              ) : (
                <Table columns={["PNR", "Cabin", "Class", "Seats", "Expires"]}>
                  {inv.holds.map((h, i) => (
                    <Tr key={i}>
                      <Td className="font-mono">{h.pnrLocator}</Td>
                      <Td>{CABIN_NAMES[h.cabin]}</Td>
                      <Td>{h.bucketClass}</Td>
                      <Td>{h.seats}</Td>
                      <Td>{fmtDateTime(h.expiresAt)}</Td>
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}

export default function InventoryDetailPage({ params }: { params: Promise<{ flightId: string }> }) {
  const { flightId } = use(params);
  return <Detail flightId={flightId} />;
}
