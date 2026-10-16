"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import { BoardingPassCard } from "@/components/checkin/BoardingPassCard";
import { RequireAuth } from "@/components/layout/Guards";
import { Alert, Async, Button, Card, ErrorAlert, PageHeader, StatusBadge, Table, Td, Tr, Badge } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth";
import { fmtDateTime } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Baggage, BoardingPass, CheckIn } from "@/lib/client/types";

function BaggageStatus({ pass }: { pass: BoardingPass }) {
  const pnr = pass.pnrLocator;
  const checkIns = useApi<{ checkIns: CheckIn[] }>("/api/checkin", { query: { pnr } });
  const bags = useApi<{ baggage: Baggage[] }>("/api/baggage", { query: { pnr, limit: 100 } });

  return (
    <Card title="Checked baggage" padded={false}>
      <Async state={checkIns}>
        {({ checkIns: cis }) => (
          <Async state={bags}>
            {({ baggage }) => {
              const me = cis.find((c) => c._id === pass.checkInId);
              const mine = baggage.filter((b) => b.flightId === pass.flightId && (!me || b.passengerId === me.passengerId));
              if (mine.length === 0) return <p className="p-5 text-sm text-slate-500">No bags have been tagged for this flight. Bags are tagged at the airport bag drop.</p>;
              return (
                <Table columns={["Tag", "Weight", "Status", "Last update"]}>
                  {mine.map((b) => (
                    <Tr key={b._id}>
                      <Td className="font-mono">{b.tagNumber}</Td>
                      <Td>
                        {b.weightKg} kg {b.excess && <Badge tone="amber">excess {b.excessKg} kg</Badge>}
                      </Td>
                      <Td>
                        <StatusBadge status={b.status} />
                      </Td>
                      <Td>{fmtDateTime(b.history[b.history.length - 1]?.at)}</Td>
                    </Tr>
                  ))}
                </Table>
              );
            }}
          </Async>
        )}
      </Async>
    </Card>
  );
}

function PassView({ checkInId }: { checkInId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const state = useApi<{ boardingPass: BoardingPass }>(`/api/boarding-passes/${checkInId}`);
  const cancel = useAction();

  async function undo() {
    if (!window.confirm("Cancel your check-in? You will lose this seat and boarding pass.")) return;
    if (await cancel.run(() => apiFetch(`/api/checkin/${checkInId}/cancel`, { method: "POST" }))) router.push("/checkin");
  }

  return (
    <Async state={state}>
      {({ boardingPass: pass }) => (
        <div className="mx-auto max-w-3xl space-y-6">
          <BoardingPassCard pass={pass} />
          <div className="no-print flex flex-wrap items-center gap-2">
            <Button onClick={() => window.print()}>Print boarding pass</Button>
            {pass.checkInStatus === "CHECKED_IN" && (
              <Button variant="danger" onClick={undo} loading={cancel.busy}>
                Cancel check-in
              </Button>
            )}
            {pass.checkInStatus === "BOARDED" && <Badge tone="green">Boarded</Badge>}
            <Link href={user?.role === "staff" ? `/staff/pnr/${pass.pnrLocator}` : `/bookings/${pass.pnrLocator}`} className="ml-auto text-sm font-medium text-sky-700 hover:underline">
              View booking {pass.pnrLocator}
            </Link>
          </div>
          <ErrorAlert error={cancel.error} />
          <Alert tone="info" className="no-print">
            Show this QR code at the gate at the boarding time shown on your pass.
          </Alert>
          <div className="no-print">
            <BaggageStatus pass={pass} />
          </div>
        </div>
      )}
    </Async>
  );
}

export default function BoardingPassPage({ params }: { params: Promise<{ checkInId: string }> }) {
  const { checkInId } = use(params);
  return (
    <RequireAuth>
      <PageHeader title="Boarding pass" />
      <PassView checkInId={checkInId} />
    </RequireAuth>
  );
}
