"use client";

import { Alert, Async, Button, Card, ErrorAlert, KeyValue, LinkButton, StatusBadge, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fmtDateTime, fmtMoney } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Pnr, Ticket } from "@/lib/client/types";
import { HoldCountdown, ItineraryCard, PassengersCard } from "./parts";

/** PNR view shared by the passenger booking page and the staff PNR desk (`staff` adds issue / void / history). */
export function PnrDetail({ locator, staff = false, confirmed = false }: { locator: string; staff?: boolean; confirmed?: boolean }) {
  const state = useApi<{ pnr: Pnr; tickets: Ticket[] }>(`/api/pnrs/${locator}`);
  const action = useAction();
  const reload = state.reload;

  async function cancelPnr() {
    if (!window.confirm("Cancel this booking? Held seats are released and any tickets are voided.")) return;
    if (await action.run(() => apiFetch(`/api/pnrs/${locator}/cancel`, { method: "POST" }))) reload();
  }

  async function issue() {
    if (!window.confirm("Issue tickets for this PNR without payment (staff desk)?")) return;
    if (await action.run(() => apiFetch(`/api/pnrs/${locator}/tickets`, { method: "POST", body: {} }))) reload();
  }

  async function voidTicket(t: Ticket) {
    if (!window.confirm(`Void ticket ${t.ticketNumber}? Its seat is released.`)) return;
    if (await action.run(() => apiFetch(`/api/tickets/${t.ticketNumber}/void`, { method: "POST", body: { reason: "Voided at staff desk" } }))) reload();
  }

  return (
    <Async state={state}>
      {({ pnr, tickets }) => {
        const checkinHref = `${staff ? "/staff/checkin" : "/checkin"}?locator=${pnr.recordLocator}`;
        return (
          <div className="space-y-6">
            {confirmed && pnr.status === "TICKETED" && (
              <Alert tone="success" title="Booking confirmed 🎉">
                Your tickets have been issued. Keep your record locator <span className="font-mono font-semibold">{pnr.recordLocator}</span> handy for check-in.
              </Alert>
            )}
            {pnr.status === "HELD" && pnr.holdExpiresAt && (
              <Alert tone="warning" title="Payment pending">
                <div className="flex flex-wrap items-center gap-3">
                  Seats are held for <HoldCountdown expiresAt={pnr.holdExpiresAt} onExpire={reload} />
                </div>
              </Alert>
            )}

            <Card
              title={
                <span className="flex items-center gap-3">
                  Record locator <span className="rounded bg-slate-900 px-2 py-0.5 font-mono text-base tracking-widest text-white">{pnr.recordLocator}</span>
                  <StatusBadge status={pnr.status} />
                </span>
              }
              actions={
                <>
                  {pnr.status === "HELD" && !staff && <LinkButton href={`/book/pay/${pnr.recordLocator}`}>Pay now</LinkButton>}
                  {pnr.status === "HELD" && staff && (
                    <Button variant="success" onClick={issue} loading={action.busy}>
                      Issue tickets (no payment)
                    </Button>
                  )}
                  {pnr.status === "TICKETED" && (
                    <LinkButton href={checkinHref} variant="secondary">
                      {staff ? "Open check-in desk" : "Check in"}
                    </LinkButton>
                  )}
                  {(pnr.status === "HELD" || pnr.status === "TICKETED") && (
                    <Button variant="danger" onClick={cancelPnr} loading={action.busy}>
                      Cancel booking
                    </Button>
                  )}
                </>
              }
            >
              <KeyValue
                items={[
                  ["Total", fmtMoney(pnr.totalAmount, pnr.currency)],
                  ["Created", fmtDateTime(pnr.createdAt)],
                  ["Contact email", pnr.contact.email],
                  ["Contact phone", pnr.contact.phone ?? "–"],
                ]}
              />
              <ErrorAlert error={action.error} className="mt-4" />
            </Card>

            <ItineraryCard pnr={pnr} />
            <PassengersCard pnr={pnr} />

            <Card title="Tickets" padded={false}>
              {tickets.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">No tickets yet. Tickets are issued once payment succeeds.</p>
              ) : (
                <Table columns={["Ticket number", "Passenger", "Flight", "Class", "Fare", "Status", ""]}>
                  {tickets.map((t) => (
                    <Tr key={t.id}>
                      <Td className="font-mono">{t.ticketNumber}</Td>
                      <Td>{t.passengerName}</Td>
                      <Td>{pnr.segments[t.segmentIndex]?.flight?.flightNumber ?? "–"}</Td>
                      <Td>{t.bookingClass}</Td>
                      <Td>{fmtMoney(t.fareAmount, t.currency)}</Td>
                      <Td>
                        <StatusBadge status={t.status} />
                      </Td>
                      <Td className="text-right">
                        {staff && t.status === "ISSUED" && (
                          <Button size="sm" variant="danger" onClick={() => voidTicket(t)} disabled={action.busy}>
                            Void
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>

            {staff && (
              <Card title="History" padded={false}>
                <Table columns={["When", "Actor", "Action"]}>
                  {[...pnr.history].reverse().map((h, i) => (
                    <Tr key={i}>
                      <Td className="whitespace-nowrap">{fmtDateTime(h.at)}</Td>
                      <Td className="font-mono text-xs">{h.actor ?? "–"}</Td>
                      <Td>{h.action}</Td>
                    </Tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        );
      }}
    </Async>
  );
}
