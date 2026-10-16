import { AppError } from "@/lib/errors";
import {
  Fare,
  Flight,
  Inventory,
  type CabinCode,
  type IFare,
  type IFareRules,
  type IFlight,
  type IInventory,
} from "@/models";
import { bucketAvailable, toObjectId, type ObjectIdLike } from "@/modules/inventory/helpers";
import { MAX_DISPLAY_AVAILABILITY, expireHolds } from "@/modules/inventory/service";
import { applyRevenueRules } from "@/modules/inventory/rules";
import { toPage, withId } from "./common";
import type { CreateFareInput, FareListQuery, UpdateFareInput } from "./schemas";

// ---- CRUD (staff) ---------------------------------------------------------

export async function createFare(input: CreateFareInput) {
  if (input.flightId) {
    if (!(await Flight.exists({ _id: toObjectId(input.flightId, "flightId") }))) throw AppError.notFound("Flight not found");
  }
  const doc = await Fare.create({
    ...input,
    // A flight fare is keyed by flightId only; route fields are for route fares.
    ...(input.flightId ? { origin: undefined, destination: undefined } : {}),
  });
  return withId(doc.toObject());
}

export async function listFares(query: FareListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.flightId) filter.flightId = toObjectId(query.flightId, "flightId");
  if (query.origin) filter.origin = query.origin;
  if (query.destination) filter.destination = query.destination;
  if (query.bookingClass) filter.bookingClass = query.bookingClass;
  if (query.cabin) filter.cabin = query.cabin;
  if (query.active !== undefined) filter.active = query.active;
  const [items, total] = await Promise.all([
    Fare.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Fare.countDocuments(filter),
  ]);
  return toPage(items.map(withId), query.page, query.limit, total);
}

export async function getFare(id: string) {
  const doc = await Fare.findById(toObjectId(id, "fare id")).lean();
  if (!doc) throw AppError.notFound("Fare not found");
  return withId(doc);
}

export async function updateFare(id: string, patch: UpdateFareInput) {
  const fare = await Fare.findById(toObjectId(id, "fare id"));
  if (!fare) throw AppError.notFound("Fare not found");
  const { rules, ...rest } = patch;
  fare.set(rest);
  for (const [key, value] of Object.entries(rules ?? {})) fare.set(`rules.${key}`, value);
  await fare.save();
  return withId(fare.toObject());
}

/** Fares referenced by PNRs/tickets are never hard-deleted: DELETE deactivates (`active: false`). */
export async function deactivateFare(id: string) {
  const fare = await Fare.findByIdAndUpdate(toObjectId(id, "fare id"), { $set: { active: false } }, { returnDocument: "after" }).lean();
  if (!fare) throw AppError.notFound("Fare not found");
  return withId(fare);
}

// ---- offers ---------------------------------------------------------------

export interface OfferedFare {
  fareId: string;
  fareBasis: string;
  bookingClass: string;
  cabin: CabinCode;
  price: number;
  currency: string;
  rules: IFareRules;
  scope: "flight" | "route";
  seatsAvailable: number; // capped at MAX_DISPLAY_AVAILABILITY
}

type FlightRoute = Pick<IFlight, "_id" | "origin" | "destination">;

/** Active fares that apply to a flight: flight-specific fares and (fallback) route fares. */
async function applicableFares(flight: FlightRoute): Promise<(IFare & { scope: "flight" | "route" })[]> {
  const fares = await Fare.find({
    active: true,
    $or: [{ flightId: flight._id }, { flightId: null, origin: flight.origin, destination: flight.destination }],
  }).lean();
  return fares.map((f) => ({ ...f, scope: f.flightId ? ("flight" as const) : ("route" as const) }));
}

/**
 * Fares currently sellable on a flight: for every OPEN bucket with at least `minSeats` seats left, the
 * cheapest matching fare (a flight-specific fare wins over a route fare). Sorted by price ascending.
 * Stale holds are expired and the revenue rules applied first, so the result is current.
 */
export async function getOpenFares(
  flight: FlightRoute,
  minSeats = 1,
  inventory?: Pick<IInventory, "cabins"> | null,
  opts: { refresh?: boolean } = {},
): Promise<OfferedFare[]> {
  if (opts.refresh !== false) {
    const now = new Date();
    await expireHolds(now, { flightId: flight._id });
    await applyRevenueRules(flight._id, now);
  }
  const inv = inventory ?? (await Inventory.findOne({ flightId: flight._id }).lean());
  if (!inv) return [];
  const fares = await applicableFares(flight);

  const offers: OfferedFare[] = [];
  for (const cabin of inv.cabins) {
    for (const bucket of cabin.buckets) {
      const available = bucketAvailable(bucket);
      if (!bucket.open || available < minSeats) continue;
      const candidates = fares.filter((f) => f.bookingClass === bucket.class && f.cabin === cabin.cabin);
      if (candidates.length === 0) continue;
      const tier = candidates.some((f) => f.scope === "flight") ? "flight" : "route";
      const best = candidates.filter((f) => f.scope === tier).sort((a, b) => a.price - b.price)[0];
      offers.push({
        fareId: best._id.toString(),
        fareBasis: best.fareBasis,
        bookingClass: bucket.class,
        cabin: cabin.cabin,
        price: best.price,
        currency: best.currency,
        rules: best.rules,
        scope: best.scope,
        seatsAvailable: Math.min(available, MAX_DISPLAY_AVAILABILITY),
      });
    }
  }
  return offers.sort((a, b) => a.price - b.price);
}

/** GET /api/flights/:id/fares */
export async function getFlightFares(flightId: ObjectIdLike, minSeats = 1) {
  const flight = await Flight.findById(toObjectId(flightId, "flightId")).lean();
  if (!flight) throw AppError.notFound("Flight not found");
  return getOpenFares(flight, minSeats);
}

/**
 * Validate a requested (class, optional fare) for a flight inside the booking flow and return the fare and
 * the cabin that owns the class. Does NOT check seat availability (the atomic hold does).
 */
export async function resolveFareForBooking(
  flight: FlightRoute,
  inventory: Pick<IInventory, "cabins">,
  bookingClass: string,
  fareId?: string,
): Promise<{ fare: IFare; cabin: CabinCode }> {
  const cabin = inventory.cabins.find((c) => c.buckets.some((b) => b.class === bookingClass));
  if (!cabin) throw AppError.badRequest(`Class ${bookingClass} is not offered on this flight`);

  const fares = await applicableFares(flight);
  const matches = fares.filter((f) => f.bookingClass === bookingClass && f.cabin === cabin.cabin);

  if (fareId) {
    const chosen = matches.find((f) => f._id.toString() === fareId);
    if (!chosen) throw AppError.badRequest("Fare does not exist, is inactive, or does not apply to this flight and class");
    return { fare: chosen, cabin: cabin.cabin };
  }
  if (matches.length === 0) throw AppError.badRequest(`No active fare found for class ${bookingClass} on this flight`);
  const tier = matches.some((f) => f.scope === "flight") ? "flight" : "route";
  const best = matches.filter((f) => f.scope === tier).sort((a, b) => a.price - b.price)[0];
  return { fare: best, cabin: cabin.cabin };
}
