"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FlightSearchForm } from "@/components/flights/FlightSearchForm";
import { Async, Badge, Card, EmptyState, LoadingBlock, PageHeader } from "@/components/ui";
import { CABIN_CODES, CABIN_NAMES, fmtDate, fmtDuration, fmtMoney, fmtTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { FlightSearchResult } from "@/lib/client/types";

function Results() {
  const sp = useSearchParams();
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const date = sp.get("date") ?? "";
  const passengers = sp.get("passengers") ?? "1";
  const cabin = sp.get("cabin") ?? "";
  const ready = Boolean(from && to && date);

  const state = useApi<{ flights: FlightSearchResult[]; count: number }>(ready ? "/api/flights/search" : null, {
    query: { from, to, date, passengers, cabin },
  });

  return (
    <div className="space-y-6">
      <Card>
        <FlightSearchForm key={`${from}${to}${date}${passengers}${cabin}`} initial={{ from, to, date, passengers, cabin }} compact />
      </Card>

      {!ready ? (
        <EmptyState title="Search for a flight">Enter an origin, destination and date above.</EmptyState>
      ) : (
        <>
          <PageHeader title={`${from.toUpperCase()} → ${to.toUpperCase()}`} subtitle={`${fmtDate(`${date}T00:00:00Z`)} · ${passengers} passenger${passengers === "1" ? "" : "s"}`} />
          <Async state={state} label="Searching flights…">
            {({ flights }) =>
              flights.length === 0 ? (
                <EmptyState title="No flights found">No flights with open seats match your search. Try another date or cabin.</EmptyState>
              ) : (
                <div className="space-y-4">
                  {flights.map((f) => (
                    <FlightCard key={f.id} flight={f} passengers={Number(passengers) || 1} />
                  ))}
                </div>
              )
            }
          </Async>
        </>
      )}
    </div>
  );
}

function FlightCard({ flight, passengers }: { flight: FlightSearchResult; passengers: number }) {
  return (
    <Card padded={false}>
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs font-medium uppercase text-slate-500">{flight.flightNumber}</div>
            <div className="mt-1 flex items-center gap-4">
              <div>
                <div className="text-2xl font-semibold">{fmtTime(flight.departure)}</div>
                <div className="text-sm text-slate-500">{flight.origin}</div>
              </div>
              <div className="text-center text-xs text-slate-400">
                <div>{fmtDuration(flight.durationMinutes)}</div>
                <div className="my-0.5 w-20 border-t border-slate-300" />
                <div>nonstop</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">{fmtTime(flight.arrival)}</div>
                <div className="text-sm text-slate-500">{flight.destination}</div>
              </div>
            </div>
            <div className="mt-1 text-xs text-slate-500">{fmtDate(flight.departure)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:w-[34rem]">
          {CABIN_CODES.map((cabin) => {
            const fare = flight.fares[cabin];
            if (!fare) return null;
            const href = `/book?${new URLSearchParams({ flightId: flight.id, fareId: fare.fareId, passengers: String(passengers) }).toString()}`;
            return (
              <Link key={cabin} href={href} className="rounded-lg border border-slate-200 p-3 transition hover:border-sky-500 hover:bg-sky-50">
                <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                  {CABIN_NAMES[cabin]}
                  <span>{fare.bookingClass}</span>
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(fare.price, fare.currency)}</div>
                <div className="text-xs text-slate-500">per passenger</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={fare.seatsAvailable <= 3 ? "amber" : "gray"}>{fare.seatsAvailable} left</Badge>
                  <Badge tone={fare.rules.refundable ? "green" : "gray"}>{fare.rules.refundable ? "Refundable" : "Non-refundable"}</Badge>
                  <Badge>{fare.rules.checkedBaggageKg} kg bag</Badge>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Results />
    </Suspense>
  );
}
