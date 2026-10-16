import { AppError } from "@/lib/errors";
import type { AuthUser } from "@/lib/withAuth";
import { CheckIn, type CabinCode, type ICabinLayout, type ICheckIn } from "@/models";
import { getAircraftOrThrow, getFlightOrThrow } from "./common";
import { isInfantSeat } from "./boardingPass";

export interface SeatMapSeat {
  seat: string; // "12A"
  letter: string;
  status: "AVAILABLE" | "OCCUPIED";
  /** Staff only. */
  occupant?: { checkInId: string; pnrLocator: string; passengerId: string; status: ICheckIn["status"] };
}

export interface SeatMapRow {
  row: number;
  seats: SeatMapSeat[];
}

export interface SeatMapCabin {
  cabin: CabinCode;
  rows: SeatMapRow[];
  totalSeats: number;
  availableSeats: number;
}

export interface SeatMap {
  flightId: string;
  flightNumber: string;
  aircraftType: string;
  cabins: SeatMapCabin[];
}

/** Seat labels of a cabin layout in row order, then layout letter order. */
export function enumerateSeats(layout: ICabinLayout): string[] {
  const seats: string[] = [];
  for (let row = layout.firstRow; row <= layout.lastRow; row++) {
    for (const letter of layout.seatLetters) seats.push(`${row}${letter.toUpperCase()}`);
  }
  return seats;
}

/** Seats currently held by an active (CHECKED_IN or BOARDED) check-in on a flight. */
export async function activeCheckIns(flightId: ICheckIn["flightId"]): Promise<ICheckIn[]> {
  return CheckIn.find({ flightId, status: { $in: ["CHECKED_IN", "BOARDED"] } }).lean<ICheckIn[]>();
}

/**
 * Seat map: per cabin and row, each seat is AVAILABLE or OCCUPIED. Passengers never see who sits where;
 * staff additionally get an `occupant` reference (check-in id, PNR locator, passenger id).
 */
export async function getSeatMap(user: AuthUser, flightId: string): Promise<SeatMap> {
  const flight = await getFlightOrThrow(flightId);
  const aircraft = await getAircraftOrThrow(flight.aircraftId);
  if (flight.status === "CANCELLED") throw AppError.conflict("Flight is cancelled");

  const taken = new Map<string, ICheckIn>();
  for (const c of await activeCheckIns(flight._id)) if (!isInfantSeat(c.seat)) taken.set(c.seat, c);

  const cabins: SeatMapCabin[] = aircraft.cabins.map((layout) => {
    const rows: SeatMapRow[] = [];
    for (let row = layout.firstRow; row <= layout.lastRow; row++) {
      rows.push({
        row,
        seats: layout.seatLetters.map((l) => {
          const letter = l.toUpperCase();
          const seat = `${row}${letter}`;
          const holder = taken.get(seat);
          const entry: SeatMapSeat = { seat, letter, status: holder ? "OCCUPIED" : "AVAILABLE" };
          if (holder && user.role === "staff") {
            entry.occupant = {
              checkInId: holder._id.toString(),
              pnrLocator: holder.pnrLocator,
              passengerId: holder.passengerId,
              status: holder.status,
            };
          }
          return entry;
        }),
      });
    }
    const all = rows.flatMap((r) => r.seats);
    return {
      cabin: layout.cabin,
      rows,
      totalSeats: all.length,
      availableSeats: all.filter((s) => s.status === "AVAILABLE").length,
    };
  });

  return { flightId: flight._id.toString(), flightNumber: flight.flightNumber, aircraftType: aircraft.type, cabins };
}
