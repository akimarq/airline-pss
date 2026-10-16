import { AppError } from "@/lib/errors";
import { Aircraft, Flight, PNR, type CabinCode, type IFlight } from "@/models";
import { toObjectId } from "@/modules/inventory/helpers";
import { applyRevenueRules } from "@/modules/inventory/rules";
import { createInventoryForFlight, expireHolds, type InventoryView } from "@/modules/inventory/service";
import { escapeRegex, toPage, withId } from "./common";
import { getOpenFares, type OfferedFare } from "./fares.service";
import type { CreateFlightInput, FlightListQuery, UpdateFlightInput } from "./schemas";

/** PNR statuses that hold or have sold seats on a flight. */
export const ACTIVE_PNR_STATUSES = ["HELD", "CONFIRMED", "TICKETED"] as const;

function assertTimes(departure: Date, arrival: Date, origin: string, destination: string) {
  if (arrival <= departure) throw AppError.badRequest("Arrival must be after departure");
  if (origin === destination) throw AppError.badRequest("Origin and destination must differ");
}

export async function createFlight(input: CreateFlightInput, actor = "system") {
  const { inventory: inventoryConfig, ...data } = input;
  assertTimes(data.departure, data.arrival, data.origin, data.destination);
  if (!(await Aircraft.exists({ _id: toObjectId(data.aircraftId, "aircraftId") }))) {
    throw AppError.notFound("Aircraft not found");
  }
  const flight = await Flight.create(data);
  let inventory: InventoryView | undefined;
  if (inventoryConfig) {
    try {
      inventory = await createInventoryForFlight(flight._id, inventoryConfig, actor);
    } catch (err) {
      await Flight.deleteOne({ _id: flight._id });
      throw err;
    }
  }
  return { flight: withId(flight.toObject()), inventory };
}

export async function listFlights(query: FlightListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.origin) filter.origin = query.origin;
  if (query.destination) filter.destination = query.destination;
  if (query.flightNumber) filter.flightNumber = { $regex: `^${escapeRegex(query.flightNumber)}` };
  if (query.status) filter.status = query.status;
  if (query.aircraftId) filter.aircraftId = toObjectId(query.aircraftId, "aircraftId");
  if (query.departureFrom || query.departureTo) {
    filter.departure = {
      ...(query.departureFrom ? { $gte: query.departureFrom } : {}),
      ...(query.departureTo ? { $lte: query.departureTo } : {}),
    };
  }
  const [items, total] = await Promise.all([
    Flight.find(filter)
      .sort({ departure: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Flight.countDocuments(filter),
  ]);
  return toPage(items.map(withId), query.page, query.limit, total);
}

export async function getFlight(id: string) {
  const flight = await Flight.findById(toObjectId(id, "flight id")).lean();
  if (!flight) throw AppError.notFound("Flight not found");
  return withId(flight);
}

/** Number of PNRs that hold or have sold seats on the flight (stale holds are expired first). */
export async function countActivePnrs(flightId: string | IFlight["_id"]): Promise<number> {
  const id = toObjectId(flightId, "flightId");
  await expireHolds(new Date(), { flightId: id });
  return PNR.countDocuments({ "segments.flightId": id, status: { $in: ACTIVE_PNR_STATUSES } });
}

export async function updateFlight(id: string, patch: UpdateFlightInput, actor = "system") {
  const flight = await Flight.findById(toObjectId(id, "flight id"));
  if (!flight) throw AppError.notFound("Flight not found");

  const { status, ...fields } = patch;
  if (status === "CANCELLED") {
    if (Object.keys(fields).length > 0) throw AppError.badRequest("Cancel a flight without other changes");
    return cancelFlight(id);
  }

  const onlyGate = Object.keys(fields).every((k) => k === "gate");
  if (!onlyGate && (flight.status === "BOARDING" || flight.status === "CLOSED" || flight.status === "DEPARTED")) {
    throw AppError.conflict(`Flight is ${flight.status}; only the gate can be changed`);
  }
  if (flight.status === "CANCELLED" && status !== "SCHEDULED") {
    throw AppError.conflict("Flight is cancelled; set status to SCHEDULED to reinstate it");
  }

  // Changing what the flight *is* is only allowed while nobody holds a booking on it.
  const identityChange = ["flightNumber", "origin", "destination", "aircraftId"].some((k) => k in fields);
  if (identityChange && (await countActivePnrs(flight._id)) > 0) {
    throw AppError.conflict("Flight number, route and aircraft cannot change while active PNRs exist; cancel them first");
  }
  if (fields.aircraftId && !(await Aircraft.exists({ _id: toObjectId(fields.aircraftId, "aircraftId") }))) {
    throw AppError.notFound("Aircraft not found");
  }

  const merged = {
    departure: fields.departure ?? flight.departure,
    arrival: fields.arrival ?? flight.arrival,
    origin: fields.origin ?? flight.origin,
    destination: fields.destination ?? flight.destination,
  };
  assertTimes(merged.departure, merged.arrival, merged.origin, merged.destination);

  flight.set({ ...fields, ...(status ? { status } : {}) });
  await flight.save();
  if (fields.departure) await applyRevenueRules(flight._id); // time-to-departure rules depend on departure
  void actor;
  return withId(flight.toObject());
}

/** Soft cancel (status CANCELLED). Blocked with 409 while active PNRs exist. Idempotent. */
export async function cancelFlight(id: string) {
  const flight = await Flight.findById(toObjectId(id, "flight id"));
  if (!flight) throw AppError.notFound("Flight not found");
  if (flight.status === "CANCELLED") return withId(flight.toObject());
  if (flight.status === "DEPARTED") throw AppError.conflict("Flight has already departed");
  const active = await countActivePnrs(flight._id);
  if (active > 0) {
    throw AppError.conflict(`Flight has ${active} active PNR(s); cancel them first`, { activePnrs: active });
  }
  flight.status = "CANCELLED";
  await flight.save();
  return withId(flight.toObject());
}

// ---- search ---------------------------------------------------------------

export interface FlightSearchResult {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: Date;
  arrival: Date;
  durationMinutes: number;
  /** Lowest available fare per cabin (open buckets with enough seats only). */
  fares: Partial<Record<CabinCode, OfferedFare>>;
  lowestFare: OfferedFare;
}

/**
 * Search scheduled flights for a route on a UTC calendar day. Only flights with at least one open bucket that
 * has `passengers` seats AND an active fare are returned.
 */
export async function searchFlights(params: {
  from: string;
  to: string;
  date: string;
  passengers: number;
  cabin?: CabinCode;
}): Promise<FlightSearchResult[]> {
  const dayStart = new Date(`${params.date}T00:00:00.000Z`);
  if (Number.isNaN(dayStart.getTime())) throw AppError.badRequest("Invalid date");
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const from = new Date(Math.max(dayStart.getTime(), Date.now()));

  const flights = await Flight.find({
    origin: params.from,
    destination: params.to,
    status: "SCHEDULED",
    departure: { $gte: from, $lt: dayEnd },
  })
    .sort({ departure: 1 })
    .lean();

  const results = await Promise.all(
    flights.map(async (flight): Promise<FlightSearchResult | null> => {
      const offers = await getOpenFares(flight, params.passengers);
      const fares: Partial<Record<CabinCode, OfferedFare>> = {};
      for (const offer of offers) {
        if (params.cabin && offer.cabin !== params.cabin) continue;
        if (!fares[offer.cabin]) fares[offer.cabin] = offer; // offers are sorted by price: first = lowest
      }
      const lowest = Object.values(fares).sort((a, b) => a.price - b.price)[0];
      if (!lowest) return null;
      return {
        id: flight._id.toString(),
        flightNumber: flight.flightNumber,
        origin: flight.origin,
        destination: flight.destination,
        departure: flight.departure,
        arrival: flight.arrival,
        durationMinutes: Math.round((flight.arrival.getTime() - flight.departure.getTime()) / 60_000),
        fares,
        lowestFare: lowest,
      };
    }),
  );
  return results.filter((r): r is FlightSearchResult => r !== null);
}
