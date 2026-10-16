"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Input, Select } from "@/components/ui";
import { CABIN_CODES, CABIN_NAMES, utcDate } from "@/lib/client/format";

export interface SearchParamsValue {
  from: string;
  to: string;
  date: string;
  passengers: string;
  cabin: string;
}

export function FlightSearchForm({ initial, compact = false }: { initial?: Partial<SearchParamsValue>; compact?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<SearchParamsValue>(() => ({
    from: initial?.from ?? "",
    to: initial?.to ?? "",
    date: initial?.date ?? utcDate(new Date(), 1),
    passengers: initial?.passengers ?? "1",
    cabin: initial?.cabin ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof SearchParamsValue) => (value: string) => setV((p) => ({ ...p, [k]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const from = v.from.trim().toUpperCase();
    const to = v.to.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return setError("Use 3-letter airport codes (e.g. MNL).");
    if (from === to) return setError("Origin and destination must differ.");
    if (!v.date) return setError("Pick a travel date.");
    setError(null);
    const q = new URLSearchParams({ from, to, date: v.date, passengers: v.passengers });
    if (v.cabin) q.set("cabin", v.cabin);
    router.push(`/search?${q.toString()}`);
  }

  return (
    <form onSubmit={submit} className={`grid gap-3 ${compact ? "md:grid-cols-6" : "sm:grid-cols-2 lg:grid-cols-6"}`}>
      <Input label="From" placeholder="MNL" maxLength={3} value={v.from} onChange={(e) => set("from")(e.target.value.toUpperCase())} required className="uppercase" />
      <Input label="To" placeholder="CEB" maxLength={3} value={v.to} onChange={(e) => set("to")(e.target.value.toUpperCase())} required className="uppercase" />
      <Input label="Date (UTC)" type="date" value={v.date} onChange={(e) => set("date")(e.target.value)} required />
      <Select label="Passengers" value={v.passengers} onChange={(e) => set("passengers")(e.target.value)}>
        {Array.from({ length: 9 }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </Select>
      <Select label="Cabin" value={v.cabin} onChange={(e) => set("cabin")(e.target.value)}>
        <option value="">Any cabin</option>
        {CABIN_CODES.map((c) => (
          <option key={c} value={c}>
            {CABIN_NAMES[c]}
          </option>
        ))}
      </Select>
      <div className="flex items-end">
        <Button type="submit" className="w-full">
          Search flights
        </Button>
      </div>
      {error && <p className="text-sm text-red-600 sm:col-span-2 lg:col-span-6">{error}</p>}
    </form>
  );
}
