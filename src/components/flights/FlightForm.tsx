"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, Checkbox, ErrorAlert, Input, Select } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { Aircraft, Flight, Page } from "@/lib/client/types";

/** Create (no `flight`) or edit a flight. All times are UTC. */
export function FlightForm({ flight, onSaved }: { flight?: Flight; onSaved?: (f: Flight) => void }) {
  const router = useRouter();
  const aircraft = useApi<Page<Aircraft>>("/api/aircraft", { query: { limit: 100 } });
  const { run, busy, error } = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    flightNumber: flight?.flightNumber ?? "",
    origin: flight?.origin ?? "",
    destination: flight?.destination ?? "",
    departure: flight ? toDateTimeInput(flight.departure) : "",
    arrival: flight ? toDateTimeInput(flight.arrival) : "",
    aircraftId: flight?.aircraftId ?? "",
    gate: flight?.gate ?? "",
  });
  const [withInventory, setWithInventory] = useState(true);
  const fe = error?.fieldErrors ?? {};
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setF((p) => ({ ...p, [k]: e.target.value }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!flight) {
      const res = await run(() =>
        apiFetch<{ flight: Flight }>("/api/flights", {
          method: "POST",
          body: {
            flightNumber: f.flightNumber,
            origin: f.origin,
            destination: f.destination,
            departure: fromDateTimeInput(f.departure),
            arrival: fromDateTimeInput(f.arrival),
            aircraftId: f.aircraftId,
            ...(f.gate ? { gate: f.gate } : {}),
            ...(withInventory ? { inventory: {} } : {}),
          },
        }),
      );
      if (res) router.push(`/staff/flights/${res.flight.id}`);
      return;
    }
    // Edit: send only what changed (flights in BOARDING/CLOSED/DEPARTED accept gate changes only).
    const patch: Record<string, string> = {};
    if (f.flightNumber !== flight.flightNumber) patch.flightNumber = f.flightNumber;
    if (f.origin !== flight.origin) patch.origin = f.origin;
    if (f.destination !== flight.destination) patch.destination = f.destination;
    if (f.departure !== toDateTimeInput(flight.departure)) patch.departure = fromDateTimeInput(f.departure);
    if (f.arrival !== toDateTimeInput(flight.arrival)) patch.arrival = fromDateTimeInput(f.arrival);
    if (f.aircraftId !== flight.aircraftId) patch.aircraftId = f.aircraftId;
    if (f.gate !== (flight.gate ?? "")) patch.gate = f.gate;
    if (Object.keys(patch).length === 0) return setSaved(true);
    const res = await run(() => apiFetch<{ flight: Flight }>(`/api/flights/${flight.id}`, { method: "PATCH", body: patch }));
    if (res) {
      setSaved(true);
      onSaved?.(res.flight);
    }
  }

  return (
    <Card title={flight ? "Flight details" : "New flight"}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Flight number" placeholder="PS101" value={f.flightNumber} onChange={set("flightNumber")} required className="uppercase" error={fe.flightNumber} />
          <Input label="Origin (IATA)" placeholder="MNL" maxLength={3} value={f.origin} onChange={set("origin")} required className="uppercase" error={fe.origin} />
          <Input label="Destination (IATA)" placeholder="CEB" maxLength={3} value={f.destination} onChange={set("destination")} required className="uppercase" error={fe.destination} />
          <Input label="Departure (UTC)" type="datetime-local" value={f.departure} onChange={set("departure")} required error={fe.departure} />
          <Input label="Arrival (UTC)" type="datetime-local" value={f.arrival} onChange={set("arrival")} required error={fe.arrival} />
          <Input label="Gate" maxLength={10} value={f.gate} onChange={set("gate")} error={fe.gate} />
          <Select label="Aircraft" value={f.aircraftId} onChange={set("aircraftId")} required disabled={aircraft.loading} error={fe.aircraftId ?? aircraft.error?.message} wrapperClassName="sm:col-span-3">
            <option value="">{aircraft.loading ? "Loading aircraft…" : "Select aircraft"}</option>
            {aircraft.data?.data.map((a) => (
              <option key={a.id} value={a.id}>
                {a.registration} · {a.type} · {a.capacity} seats
              </option>
            ))}
          </Select>
        </div>
        {!flight && <Checkbox label="Also create inventory (buckets from the aircraft layout)" checked={withInventory} onChange={(e) => setWithInventory(e.target.checked)} />}
        {error && Object.keys(fe).length === 0 && <ErrorAlert error={error} />}
        {error && Object.keys(fe).length > 0 && <ErrorAlert error="Please fix the highlighted fields." />}
        {saved && <p className="text-sm text-emerald-700">Saved.</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            {flight ? "Save changes" : "Create flight"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
