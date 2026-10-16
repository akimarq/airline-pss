"use client";

import Link from "next/link";
import { use, useState, type FormEvent } from "react";
import { Alert, Async, Badge, Button, Card, EmptyState, ErrorAlert, Input, KeyValue, LinkButton, PageHeader, Stat, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtDateTime, fmtTime, isObjectId } from "@/lib/client/format";
import { useAction, useApi, useInterval } from "@/lib/client/hooks";
import type { CloseSummary, Flight, Manifest, ScanResult } from "@/lib/client/types";

interface ScanLogEntry {
  ok: boolean;
  text: string;
  at: number;
}

function Detail({ flightId }: { flightId: string }) {
  const flightState = useApi<{ flight: Flight }>(`/api/flights/${flightId}`);
  const manifestState = useApi<Manifest>(`/api/flights/${flightId}/boarding`);
  const [gate, setGate] = useState("");
  const [code, setCode] = useState("");
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const [summary, setSummary] = useState<CloseSummary | null>(null);
  const open = useAction();
  const scan = useAction();
  const close = useAction();
  const depart = useAction();

  const status = manifestState.data?.flight.status ?? flightState.data?.flight.status;
  // Live manifest while boarding is in progress.
  useInterval(manifestState.reload, 5000, status === "BOARDING");

  const base = `/api/flights/${flightId}/boarding`;
  const refresh = () => {
    flightState.reload();
    manifestState.reload();
  };

  async function openBoarding() {
    if (await open.run(() => apiFetch(`${base}/open`, { method: "POST", body: gate.trim() ? { gate: gate.trim() } : {} }))) refresh();
  }

  async function doScan(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    const body = isObjectId(value) ? { checkInId: value } : { barcode: value };
    const res = await scan.run(() => apiFetch<ScanResult>(`${base}/scan`, { method: "POST", body }));
    if (res) {
      setLog((l) => [{ ok: true, text: `✔ ${res.passengerName} · seat ${res.seat} · seq ${res.boardingSequence} · ${res.pnrLocator}`, at: Date.now() }, ...l].slice(0, 6));
      setCode("");
      manifestState.reload();
    }
  }

  // Record failed scans in the log too.
  const scanError = scan.error;

  async function closeBoarding() {
    if (!window.confirm("Close boarding? Passengers not yet boarded become no-shows and their seats are released.")) return;
    const res = await close.run(() => apiFetch<{ summary: CloseSummary }>(`${base}/close`, { method: "POST" }));
    if (res) {
      setSummary(res.summary);
      refresh();
    }
  }

  async function departFlight() {
    if (!window.confirm("Mark this flight as departed? Boarded passengers' tickets become USED.")) return;
    if (await depart.run(() => apiFetch(`${base}/depart`, { method: "POST" }))) refresh();
  }

  const f = flightState.data?.flight;

  return (
    <>
      <PageHeader
        title={f ? `Gate · ${f.flightNumber}` : "Gate boarding"}
        subtitle={f ? `${f.origin} → ${f.destination} · departs ${fmtDateTime(f.departure)}${f.gate ? ` · gate ${f.gate}` : ""}` : undefined}
        actions={
          <>
            {status && <StatusBadge status={status} />}
            <LinkButton href="/staff/boarding" variant="secondary">
              All flights
            </LinkButton>
            <Button variant="secondary" onClick={refresh}>
              Refresh
            </Button>
          </>
        }
      />

      <Async state={manifestState}>
        {(m) => {
          const flightStatus = m.flight.status;
          const loadSheetMissing = open.error?.code === "LOAD_SHEET_NOT_FINAL" || close.error?.code === "LOAD_SHEET_NOT_FINAL";
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
                <Stat label="Ticketed" value={m.counts.ticketed} />
                <Stat label="Checked in" value={m.counts.checkedIn} />
                <Stat label="Boarded" value={m.counts.boarded} />
                <Stat label="Waiting" value={m.counts.notYetBoarded} />
                <Stat label="Not checked in" value={m.counts.notCheckedIn} />
                <Stat label="No-shows" value={m.counts.noShow} />
              </div>

              {loadSheetMissing && (
                <Alert tone="warning" title="A FINAL load sheet is required">
                  <Link href={`/staff/load/${flightId}`} className="font-medium underline">
                    Go to load control
                  </Link>{" "}
                  to finalize it.
                </Alert>
              )}

              {flightStatus === "SCHEDULED" && (
                <Card title="Open boarding">
                  <div className="flex flex-wrap items-end gap-3">
                    <Input label="Gate (optional)" maxLength={10} value={gate} onChange={(e) => setGate(e.target.value.toUpperCase())} wrapperClassName="w-40" placeholder={m.flight.gate ?? "A1"} />
                    <Button onClick={openBoarding} loading={open.busy}>
                      Open boarding
                    </Button>
                  </div>
                  <ErrorAlert error={open.error} className="mt-3" />
                  <p className="mt-2 text-xs text-slate-500">Requires a finalized load sheet.</p>
                </Card>
              )}

              {flightStatus === "BOARDING" && (
                <Card
                  title="Scan boarding pass"
                  actions={
                    <Button variant="danger" onClick={closeBoarding} loading={close.busy}>
                      Close boarding
                    </Button>
                  }
                >
                  <form onSubmit={doScan} className="flex flex-wrap items-end gap-3">
                    <Input
                      wrapperClassName="flex-1 min-w-64"
                      label="Barcode or check-in id"
                      placeholder="Paste the barcode text or a 24-character check-in id"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoFocus
                      className="font-mono"
                    />
                    <Button type="submit" loading={scan.busy} disabled={!code.trim()}>
                      Scan
                    </Button>
                  </form>
                  <ErrorAlert error={scanError} className="mt-3" />
                  {log.length > 0 && (
                    <ul className="mt-3 space-y-1 text-sm text-emerald-700">
                      {log.map((l) => (
                        <li key={l.at}>{l.text}</li>
                      ))}
                    </ul>
                  )}
                  <ErrorAlert error={close.error} className="mt-3" />
                </Card>
              )}

              {flightStatus === "CLOSED" && (
                <Card title="Boarding closed" actions={<Button variant="success" onClick={departFlight} loading={depart.busy}>Depart flight</Button>}>
                  <p className="text-sm text-slate-600">Boarding is closed. Departing marks boarded passengers&apos; tickets as used.</p>
                  <ErrorAlert error={depart.error} className="mt-3" />
                </Card>
              )}

              {flightStatus === "DEPARTED" && <Alert tone="success">This flight has departed.</Alert>}
              {flightStatus === "CANCELLED" && <Alert tone="warning">This flight is cancelled.</Alert>}

              {summary && (
                <Card title="Boarding close summary">
                  <KeyValue
                    items={[
                      ["Boarded", summary.boarded],
                      ["No-shows (total)", summary.noShows.total],
                      ["  checked in, not boarded", summary.noShows.checkedInNotBoarded],
                      ["  never checked in", summary.noShows.notCheckedIn],
                      ["Bags offloaded", summary.baggageOffloaded],
                      ["Closed at", fmtDateTime(summary.closedAt)],
                    ]}
                  />
                  {summary.seatsReleased.length > 0 && (
                    <p className="mt-3 text-sm text-slate-600">
                      Seats released to inventory: {summary.seatsReleased.map((s) => `${s.seats}× ${s.bucketClass}`).join(", ")}
                    </p>
                  )}
                  {summary.inventoryReleaseFailures.length > 0 && (
                    <Alert tone="warning" className="mt-3" title="Some seats could not be released">
                      {summary.inventoryReleaseFailures.map((x) => `${x.seats}× ${x.bucketClass}: ${x.error}`).join("; ")}
                    </Alert>
                  )}
                </Card>
              )}

              <Card title={`Manifest (${m.passengers.length})`} padded={false} actions={flightStatus === "BOARDING" ? <Badge tone="blue">live · refreshes every 5s</Badge> : undefined}>
                {m.passengers.length === 0 ? (
                  <div className="p-5">
                    <EmptyState title="No passengers checked in yet" />
                  </div>
                ) : (
                  <Table columns={["Seq", "Passenger", "PNR", "Type", "Seat", "Channel", "Status", "Boarded"]}>
                    {m.passengers.map((p) => (
                      <Tr key={p.checkInId}>
                        <Td>{p.boardingSequence}</Td>
                        <Td className="font-medium">{p.passengerName}</Td>
                        <Td className="font-mono">{p.pnrLocator}</Td>
                        <Td>{p.type}</Td>
                        <Td className="font-mono">{p.seat.startsWith("INF") ? "Lap" : p.seat}</Td>
                        <Td>{p.channel}</Td>
                        <Td>
                          <StatusBadge status={p.status} />
                        </Td>
                        <Td>{p.boardedAt ? fmtTime(p.boardedAt) : "–"}</Td>
                      </Tr>
                    ))}
                  </Table>
                )}
              </Card>

              {m.noShowCandidates.length > 0 && (flightStatus === "BOARDING" || flightStatus === "SCHEDULED") && (
                <Card title={`Would be released as no-shows (${m.noShowCandidates.length})`} padded={false}>
                  <Table columns={["Passenger", "PNR", "Reason"]}>
                    {m.noShowCandidates.map((c, i) => (
                      <Tr key={i}>
                        <Td>{c.passengerName}</Td>
                        <Td className="font-mono">{c.pnrLocator}</Td>
                        <Td>{c.kind === "NOT_CHECKED_IN" ? "Not checked in" : "Checked in, not boarded"}</Td>
                      </Tr>
                    ))}
                  </Table>
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </>
  );
}

export default function BoardingDetailPage({ params }: { params: Promise<{ flightId: string }> }) {
  const { flightId } = use(params);
  return <Detail flightId={flightId} />;
}
