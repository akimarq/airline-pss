"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { SeatMap } from "@/components/flights/SeatMap";
import { Alert, Async, Button, Card, Checkbox, EmptyState, ErrorAlert, Input, Spinner, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { CABIN_NAMES, fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { BoardingPass, CheckIn, Page, Pnr, Ticket } from "@/lib/client/types";
import { BoardingPassCard } from "./BoardingPassCard";

interface Props {
  /** "passenger" checks in ONLINE; "staff" checks in via the AIRPORT channel and can override a closed window. */
  mode: "passenger" | "staff";
  initialLocator?: string;
}

export function CheckInPanel({ mode, initialLocator = "" }: Props) {
  const staff = mode === "staff";
  const [input, setInput] = useState(initialLocator.toUpperCase());
  const [locator, setLocator] = useState(initialLocator.toUpperCase());

  function lookup(e: FormEvent) {
    e.preventDefault();
    setLocator(input.trim().toUpperCase());
  }

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={lookup} className="flex flex-wrap items-end gap-3">
          <Input
            wrapperClassName="w-full sm:w-64"
            label="Booking reference (record locator)"
            placeholder="ABC234"
            maxLength={6}
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            className="font-mono uppercase tracking-widest"
          />
          <Button type="submit" disabled={input.trim().length !== 6}>
            Find booking
          </Button>
        </form>
      </Card>

      {locator ? <Booking key={locator} locator={locator} staff={staff} /> : !staff ? <MyTicketed onPick={(l) => { setInput(l); setLocator(l); }} /> : <EmptyState title="Look up a PNR">Enter a 6-character record locator to check passengers in.</EmptyState>}
    </div>
  );
}

function MyTicketed({ onPick }: { onPick: (locator: string) => void }) {
  const state = useApi<Page<Pnr>>("/api/pnrs", { query: { status: "TICKETED", limit: 20 } });
  return (
    <Async state={state}>
      {(res) =>
        res.data.length === 0 ? (
          <EmptyState title="No ticketed bookings">Check-in is available once a booking is paid and ticketed.</EmptyState>
        ) : (
          <Card title="Your ticketed bookings" padded={false}>
            <Table columns={["Locator", "Flights", "Departs", ""]}>
              {res.data.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-mono font-semibold">{p.recordLocator}</Td>
                  <Td>{p.segments.map((s) => `${s.flight?.flightNumber ?? "?"} ${s.flight?.origin ?? ""}→${s.flight?.destination ?? ""}`).join(", ")}</Td>
                  <Td>{fmtDateTime(p.segments[0]?.flight?.departure)}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => onPick(p.recordLocator)}>
                      Check in
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Table>
          </Card>
        )
      }
    </Async>
  );
}

function Booking({ locator, staff }: { locator: string; staff: boolean }) {
  const pnrState = useApi<{ pnr: Pnr; tickets: Ticket[] }>(`/api/pnrs/${locator}`);
  const ciState = useApi<{ checkIns: CheckIn[] }>("/api/checkin", { query: { pnr: locator } });
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [seat, setSeat] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [seatRefresh, setSeatRefresh] = useState(0);
  const [result, setResult] = useState<{ checkIn: CheckIn; boardingPass: BoardingPass } | null>(null);
  const action = useAction();

  async function checkIn(ticket: Ticket, chosenSeat: string | null) {
    const res = await action.run(() =>
      apiFetch<{ checkIn: CheckIn; boardingPass: BoardingPass }>("/api/checkin", {
        method: "POST",
        body: {
          pnrLocator: locator,
          ticketId: ticket.id,
          ...(chosenSeat ? { seat: chosenSeat } : {}),
          channel: staff ? "AIRPORT" : "ONLINE",
          ...(staff && override ? { override: true } : {}),
        },
      }),
    );
    if (res) {
      setResult(res);
      setTicketId(null);
      setSeat(null);
      ciState.reload();
    } else {
      setSeatRefresh((n) => n + 1);
      setSeat(null);
    }
  }

  async function cancelCheckIn(ci: CheckIn) {
    if (!window.confirm("Cancel this check-in? The seat and boarding pass are released.")) return;
    if (await action.run(() => apiFetch(`/api/checkin/${ci._id}/cancel`, { method: "POST" }))) {
      setResult(null);
      ciState.reload();
    }
  }

  return (
    <Async state={pnrState}>
      {({ pnr, tickets }) => (
        <Async state={ciState}>
          {({ checkIns }) => {
            const rows = tickets.filter((t) => t.status !== "VOID");
            const selected = rows.find((t) => t.id === ticketId) ?? null;
            const selPax = selected ? pnr.passengers.find((p) => p.id === selected.passengerId) : null;
            const selSeg = selected ? pnr.segments[selected.segmentIndex] : null;

            return (
              <div className="space-y-6">
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-mono tracking-widest">{pnr.recordLocator}</span> <StatusBadge status={pnr.status} />
                    </span>
                  }
                  actions={
                    <Link href={staff ? `/staff/pnr/${pnr.recordLocator}` : `/bookings/${pnr.recordLocator}`} className="text-sm text-sky-700 hover:underline">
                      View booking
                    </Link>
                  }
                >
                  {pnr.status !== "TICKETED" ? (
                    <Alert tone="warning">
                      This booking is {pnr.status}. Only ticketed bookings can be checked in{pnr.status === "HELD" ? " — complete payment first." : "."}
                    </Alert>
                  ) : rows.length === 0 ? (
                    <p className="text-sm text-slate-500">No valid tickets on this booking.</p>
                  ) : (
                    <Table columns={["Passenger", "Flight", "Departs", "Cabin", "Check-in", "Seat", ""]}>
                      {rows.map((t) => {
                        const pax = pnr.passengers.find((p) => p.id === t.passengerId);
                        const seg = pnr.segments[t.segmentIndex];
                        const ci = checkIns.find((c) => c.ticketId === t.id);
                        return (
                          <Tr key={t.id} className={t.id === ticketId ? "bg-sky-50" : ""}>
                            <Td className="font-medium">
                              {t.passengerName}
                              {pax?.type === "INFANT" && <span className="ml-1 text-xs text-slate-500">(infant)</span>}
                            </Td>
                            <Td>
                              {seg?.flight?.flightNumber} {seg?.flight?.origin}→{seg?.flight?.destination}
                            </Td>
                            <Td>{fmtDateTime(seg?.flight?.departure)}</Td>
                            <Td>{seg ? `${CABIN_NAMES[seg.cabin]} (${seg.bookingClass})` : "–"}</Td>
                            <Td>{ci ? <StatusBadge status={ci.status} /> : t.status === "ISSUED" ? <span className="text-slate-400">Not checked in</span> : <StatusBadge status={t.status} />}</Td>
                            <Td className="font-mono">{ci ? (ci.seat.startsWith("INF") ? "Lap" : ci.seat) : "–"}</Td>
                            <Td className="space-x-2 text-right whitespace-nowrap">
                              {ci ? (
                                <>
                                  <Link href={`/boarding-pass/${ci._id}`} className="text-sm font-medium text-sky-700 hover:underline">
                                    Boarding pass
                                  </Link>
                                  {ci.status === "CHECKED_IN" && (
                                    <Button size="sm" variant="ghost" onClick={() => cancelCheckIn(ci)} disabled={action.busy}>
                                      Undo
                                    </Button>
                                  )}
                                </>
                              ) : t.status === "ISSUED" ? (
                                <Button size="sm" variant={t.id === ticketId ? "primary" : "secondary"} onClick={() => { setTicketId(t.id === ticketId ? null : t.id); setSeat(null); action.clear(); }}>
                                  {t.id === ticketId ? "Selected" : "Select"}
                                </Button>
                              ) : null}
                            </Td>
                          </Tr>
                        );
                      })}
                    </Table>
                  )}
                </Card>

                {result && (
                  <div className="space-y-3">
                    <Alert tone="success" title={`Checked in – seat ${result.boardingPass.seat.startsWith("INF") ? "(lap infant)" : result.boardingPass.seat}`}>
                      <Link href={`/boarding-pass/${result.checkIn._id}`} className="font-medium underline">
                        Open boarding pass page
                      </Link>
                    </Alert>
                    {staff && <BoardingPassCard pass={result.boardingPass} />}
                  </div>
                )}

                {selected && selSeg && (
                  <Card
                    title={`Choose a seat for ${selected.passengerName}`}
                    actions={
                      <>
                        <Button variant="secondary" size="sm" onClick={() => checkIn(selected, null)} loading={action.busy}>
                          Auto-assign &amp; check in
                        </Button>
                        <Button size="sm" disabled={!seat || selPax?.type === "INFANT"} onClick={() => checkIn(selected, seat)} loading={action.busy}>
                          {seat ? `Check in with seat ${seat}` : "Pick a seat"}
                        </Button>
                      </>
                    }
                  >
                    {staff && <Checkbox className="mb-3" label="Late check-in override (after the window closed)" checked={override} onChange={(e) => setOverride(e.target.checked)} />}
                    <ErrorAlert error={action.error} className="mb-3" />
                    {action.error?.code === "CHECKIN_CLOSED" && staff && !override && <Alert tone="info" className="mb-3">Tick the override option above to check in late at the desk.</Alert>}
                    {selPax?.type === "INFANT" ? (
                      <Alert tone="info">Lap infants do not get a seat. Use “Auto-assign &amp; check in”.</Alert>
                    ) : (
                      <SeatMap flightId={selSeg.flightId} cabin={selSeg.cabin} selected={seat} onSelect={setSeat} refreshKey={seatRefresh} />
                    )}
                  </Card>
                )}
                {!selected && action.error && <ErrorAlert error={action.error} />}
                {action.busy && !selected && <Spinner />}
              </div>
            );
          }}
        </Async>
      )}
    </Async>
  );
}
