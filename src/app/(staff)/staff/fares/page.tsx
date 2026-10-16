"use client";

import { useMemo, useState, type FormEvent } from "react";
import { FlightSelect, useRecentFlights } from "@/components/flights/FlightPicker";
import { Async, Badge, Button, Card, Checkbox, EmptyState, ErrorAlert, Input, PageHeader, Pagination, Select, Table, Td, Tr } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { CABIN_CODES, CABIN_NAMES, fmtMoney } from "@/lib/client/format";
import { useAction, useApi } from "@/lib/client/hooks";
import type { CabinCode, Fare, Page } from "@/lib/client/types";

interface FormState {
  scope: "route" | "flight";
  origin: string;
  destination: string;
  flightId: string;
  fareBasis: string;
  bookingClass: string;
  cabin: CabinCode;
  price: string;
  currency: string;
  refundable: boolean;
  changeable: boolean;
  checkedBaggageKg: string;
  active: boolean;
}

const blank: FormState = {
  scope: "route",
  origin: "",
  destination: "",
  flightId: "",
  fareBasis: "",
  bookingClass: "",
  cabin: "Y",
  price: "",
  currency: "USD",
  refundable: false,
  changeable: false,
  checkedBaggageKg: "20",
  active: true,
};

function fromFare(f: Fare): FormState {
  return {
    scope: f.flightId ? "flight" : "route",
    origin: f.origin ?? "",
    destination: f.destination ?? "",
    flightId: f.flightId ?? "",
    fareBasis: f.fareBasis,
    bookingClass: f.bookingClass,
    cabin: f.cabin,
    price: String(f.price),
    currency: f.currency,
    refundable: f.rules.refundable,
    changeable: f.rules.changeable,
    checkedBaggageKg: String(f.rules.checkedBaggageKg),
    active: f.active,
  };
}

function FareForm({ fare, onDone, onCancel }: { fare: Fare | null; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<FormState>(fare ? fromFare(fare) : blank);
  const { run, busy, error } = useAction();
  const fe = error?.fieldErrors ?? {};
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const rules = { refundable: f.refundable, changeable: f.changeable, checkedBaggageKg: Number(f.checkedBaggageKg) };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const common = { fareBasis: f.fareBasis, bookingClass: f.bookingClass, cabin: f.cabin, price: Number(f.price), currency: f.currency, rules };
    const res = await run(() =>
      fare
        ? apiFetch(`/api/fares/${fare.id}`, { method: "PATCH", body: { ...common, active: f.active } })
        : apiFetch("/api/fares", {
            method: "POST",
            body: { ...common, active: f.active, ...(f.scope === "flight" ? { flightId: f.flightId } : { origin: f.origin, destination: f.destination }) },
          }),
    );
    if (res) onDone();
  }

  return (
    <Card title={fare ? `Edit fare ${fare.fareBasis}` : "New fare"}>
      <form onSubmit={submit} className="space-y-4">
        {!fare && (
          <div className="flex gap-4 text-sm">
            {(["route", "flight"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input type="radio" checked={f.scope === s} onChange={() => set("scope", s)} /> {s === "route" ? "Route fare (origin + destination)" : "Flight-specific fare"}
              </label>
            ))}
          </div>
        )}
        {!fare && f.scope === "route" && (
          <div className="grid gap-3 sm:grid-cols-4">
            <Input label="Origin" maxLength={3} value={f.origin} onChange={(e) => set("origin", e.target.value.toUpperCase())} required error={fe.origin} />
            <Input label="Destination" maxLength={3} value={f.destination} onChange={(e) => set("destination", e.target.value.toUpperCase())} required error={fe.destination} />
          </div>
        )}
        {!fare && f.scope === "flight" && <FlightSelect value={f.flightId} onChange={(v) => set("flightId", v)} wrapperClassName="max-w-xl" />}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Input label="Fare basis" value={f.fareBasis} onChange={(e) => set("fareBasis", e.target.value.toUpperCase())} required error={fe.fareBasis} />
          <Input label="Class (RBD)" maxLength={1} value={f.bookingClass} onChange={(e) => set("bookingClass", e.target.value.toUpperCase())} required error={fe.bookingClass} />
          <Select label="Cabin" value={f.cabin} onChange={(e) => set("cabin", e.target.value as CabinCode)}>
            {CABIN_CODES.map((c) => (
              <option key={c} value={c}>
                {CABIN_NAMES[c]}
              </option>
            ))}
          </Select>
          <Input label="Price" type="number" min={0} step="0.01" value={f.price} onChange={(e) => set("price", e.target.value)} required error={fe.price} />
          <Input label="Currency" maxLength={3} value={f.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} error={fe.currency} />
          <Input label="Baggage (kg)" type="number" min={0} value={f.checkedBaggageKg} onChange={(e) => set("checkedBaggageKg", e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-5">
          <Checkbox label="Refundable" checked={f.refundable} onChange={(e) => set("refundable", e.target.checked)} />
          <Checkbox label="Changeable" checked={f.changeable} onChange={(e) => set("changeable", e.target.checked)} />
          <Checkbox label="Active" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
        </div>
        <ErrorAlert error={error} />
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            {fare ? "Save fare" : "Create fare"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function StaffFaresPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ origin: "", destination: "", bookingClass: "", cabin: "", active: "" });
  const [editing, setEditing] = useState<Fare | "new" | null>(null);
  const state = useApi<Page<Fare>>("/api/fares", { query: { ...filters, page, limit: 15 } });
  const flights = useRecentFlights();
  const action = useAction();
  const flightNames = useMemo(() => new Map(flights.data?.data.map((f) => [f.id, f.flightNumber]) ?? []), [flights.data]);

  const setFilter = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  };
  const codeOk = (v: string) => v === "" || v.length === 3;

  async function deactivate(f: Fare) {
    if (!window.confirm(`Deactivate fare ${f.fareBasis}? It stays on existing tickets but can no longer be sold.`)) return;
    if (await action.run(() => apiFetch(`/api/fares/${f.id}`, { method: "DELETE" }))) state.reload();
  }

  return (
    <>
      <PageHeader title="Fares" subtitle="Route fares apply to every flight on the route; flight fares override them" actions={<Button onClick={() => setEditing("new")}>New fare</Button>} />
      {editing && (
        <div className="mb-6">
          <FareForm
            key={editing === "new" ? "new" : editing.id}
            fare={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null);
              state.reload();
            }}
          />
        </div>
      )}
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-5">
          <Input label="Origin" maxLength={3} value={filters.origin} onChange={setFilter("origin")} />
          <Input label="Destination" maxLength={3} value={filters.destination} onChange={setFilter("destination")} />
          <Input label="Class" maxLength={1} value={filters.bookingClass} onChange={setFilter("bookingClass")} />
          <Select label="Cabin" value={filters.cabin} onChange={setFilter("cabin")}>
            <option value="">All</option>
            {CABIN_CODES.map((c) => (
              <option key={c} value={c}>
                {CABIN_NAMES[c]}
              </option>
            ))}
          </Select>
          <Select label="Active" value={filters.active} onChange={setFilter("active")}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        </div>
      </Card>
      <ErrorAlert error={action.error} className="mb-4" />
      {!codeOk(filters.origin) || !codeOk(filters.destination) ? (
        <p className="text-sm text-amber-700">Enter complete 3-letter airport codes to filter by route.</p>
      ) : (
        <Async state={state}>
          {(res) =>
            res.data.length === 0 ? (
              <EmptyState title="No fares found" />
            ) : (
              <Card padded={false}>
                <Table columns={["Applies to", "Fare basis", "Class", "Cabin", "Price", "Rules", "Status", ""]}>
                  {res.data.map((f) => (
                    <Tr key={f.id}>
                      <Td>{f.flightId ? `Flight ${flightNames.get(f.flightId) ?? f.flightId.slice(-6)}` : `Route ${f.origin}→${f.destination}`}</Td>
                      <Td className="font-mono">{f.fareBasis}</Td>
                      <Td>{f.bookingClass}</Td>
                      <Td>{CABIN_NAMES[f.cabin]}</Td>
                      <Td className="font-medium">{fmtMoney(f.price, f.currency)}</Td>
                      <Td className="text-xs text-slate-500">
                        {f.rules.refundable ? "Refundable" : "Non-refundable"} · {f.rules.changeable ? "Changeable" : "No change"} · {f.rules.checkedBaggageKg} kg
                      </Td>
                      <Td>{f.active ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Inactive</Badge>}</Td>
                      <Td className="space-x-2 whitespace-nowrap text-right">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(f)}>
                          Edit
                        </Button>
                        {f.active && (
                          <Button size="sm" variant="ghost" className="text-red-600" onClick={() => deactivate(f)} disabled={action.busy}>
                            Deactivate
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Table>
                <div className="px-4 pb-4">
                  <Pagination page={res.page} totalPages={res.totalPages} onChange={setPage} />
                </div>
              </Card>
            )
          }
        </Async>
      )}
    </>
  );
}
