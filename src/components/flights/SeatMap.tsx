"use client";

import { Async } from "@/components/ui";
import { CABIN_NAMES } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { CabinCode, SeatMap as SeatMapData } from "@/lib/client/types";

interface Props {
  flightId: string;
  /** Only show this cabin (the passenger's booked cabin). */
  cabin?: CabinCode;
  selected?: string | null;
  onSelect?: (seat: string) => void;
  /** Change to force a refetch (e.g. after a seat-taken error). */
  refreshKey?: number;
}

export function SeatMap({ flightId, cabin, selected, onSelect, refreshKey = 0 }: Props) {
  const state = useApi<{ seatMap: SeatMapData }>(`/api/flights/${flightId}/seatmap`, { query: { r: refreshKey } });

  return (
    <Async state={state} label="Loading seat map…">
      {({ seatMap }) => {
        const cabins = seatMap.cabins.filter((c) => !cabin || c.cabin === cabin);
        if (cabins.length === 0) return <p className="text-sm text-slate-500">This aircraft has no seat layout for the booked cabin; seats will be auto-assigned.</p>;
        return (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <Legend className="border-slate-300 bg-white" label="Available" />
              <Legend className="border-sky-700 bg-sky-700" label="Selected" />
              <Legend className="border-slate-200 bg-slate-200" label="Taken" />
              <span>{seatMap.aircraftType}</span>
            </div>
            {cabins.map((c) => (
              <div key={c.cabin} className="overflow-x-auto">
                <div className="mb-2 text-sm font-semibold text-slate-700">
                  {CABIN_NAMES[c.cabin]} <span className="font-normal text-slate-500">· {c.availableSeats} of {c.totalSeats} seats free</span>
                </div>
                <div className="inline-block rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {c.rows.map((row) => {
                    const mid = row.seats.length >= 4 ? Math.ceil(row.seats.length / 2) : -1;
                    return (
                      <div key={row.row} className="mb-1 flex items-center gap-1">
                        <span className="w-6 text-right text-xs text-slate-400">{row.row}</span>
                        {row.seats.map((s, i) => {
                          const taken = s.status === "OCCUPIED";
                          const isSel = selected === s.seat;
                          return (
                            <span key={s.seat} className={`flex ${i === mid ? "ml-5" : ""}`}>
                              <button
                                type="button"
                                disabled={taken || !onSelect}
                                onClick={() => onSelect?.(s.seat)}
                                title={taken ? (s.occupant ? `${s.seat}: ${s.occupant.pnrLocator}` : `${s.seat} (taken)`) : s.seat}
                                aria-label={`Seat ${s.seat}${taken ? " taken" : ""}`}
                                aria-pressed={isSel}
                                className={`h-8 w-8 rounded-md border text-xs font-medium transition ${
                                  isSel
                                    ? "border-sky-700 bg-sky-700 text-white"
                                    : taken
                                      ? "cursor-not-allowed border-slate-200 bg-slate-200 text-slate-400"
                                      : "border-slate-300 bg-white text-slate-700 hover:border-sky-500 hover:bg-sky-50"
                                }`}
                              >
                                {s.letter}
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      }}
    </Async>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-3 w-3 rounded border ${className}`} /> {label}
    </span>
  );
}
