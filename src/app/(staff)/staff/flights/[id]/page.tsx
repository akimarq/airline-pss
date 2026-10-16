"use client";

import { use } from "react";
import { FlightForm } from "@/components/flights/FlightForm";
import { Alert, Async, Button, Card, ErrorAlert, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Flight, Inventory } from "@/lib/client/types";

function InventoryCard({ flightId }: { flightId: string }) {
  const state = useApi<{ inventory: Inventory }>(`/api/inventory/${flightId}`);
  const create = useAction();

  async function createInventory() {
    if (await create.run(() => apiFetch(`/api/inventory/${flightId}`, { method: "POST", body: {} }))) state.reload();
  }

  const missing = state.error?.status === 404;
  return (
    <Card title="Inventory">
      {state.loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : missing ? (
        <div className="space-y-3">
          <Alert tone="warning">This flight has no inventory, so it cannot be sold. Create buckets from the aircraft layout.</Alert>
          <ErrorAlert error={create.error} />
          <Button onClick={createInventory} loading={create.busy}>
            Create inventory
          </Button>
        </div>
      ) : state.error ? (
        <ErrorAlert error={state.error} />
      ) : (
        state.data && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              Capacity {state.data.inventory.capacity} · sold {state.data.inventory.sold} · held {state.data.inventory.held} · load factor <b>{state.data.inventory.loadFactorPct}%</b>
            </span>
            <LinkButton href={`/staff/inventory/${flightId}`} variant="secondary">
              Manage inventory
            </LinkButton>
          </div>
        )
      )}
    </Card>
  );
}

function Detail({ id }: { id: string }) {
  const state = useApi<{ flight: Flight }>(`/api/flights/${id}`);
  const action = useAction();

  async function cancelFlight() {
    if (!window.confirm("Cancel this flight? This is blocked while active bookings exist.")) return;
    if (await action.run(() => apiFetch(`/api/flights/${id}`, { method: "DELETE" }))) state.reload();
  }
  async function reinstate() {
    if (await action.run(() => apiFetch(`/api/flights/${id}`, { method: "PATCH", body: { status: "SCHEDULED" } }))) state.reload();
  }

  return (
    <Async state={state}>
      {({ flight }) => (
        <div className="space-y-6">
          <PageHeader
            title={
              <span className="flex items-center gap-3">
                {flight.flightNumber} <StatusBadge status={flight.status} />
              </span>
            }
            subtitle={`${flight.origin} → ${flight.destination}`}
            actions={
              <>
                <LinkButton href="/staff/flights" variant="secondary">
                  Back
                </LinkButton>
                {flight.status === "CANCELLED" ? (
                  <Button variant="success" onClick={reinstate} loading={action.busy}>
                    Reinstate
                  </Button>
                ) : (
                  flight.status !== "DEPARTED" && (
                    <Button variant="danger" onClick={cancelFlight} loading={action.busy}>
                      Cancel flight
                    </Button>
                  )
                )}
              </>
            }
          />
          <ErrorAlert error={action.error} />
          {flight.status !== "SCHEDULED" && flight.status !== "CANCELLED" && <Alert tone="info">Flight is {flight.status}: only the gate can be changed.</Alert>}
          <FlightForm key={flight.id} flight={flight} onSaved={state.reload} />
          <InventoryCard flightId={flight.id} />
        </div>
      )}
    </Async>
  );
}

export default function FlightDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Detail id={id} />;
}
