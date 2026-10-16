import { randomInt } from "node:crypto";
import { AppError } from "@/lib/errors";
import { assertOwnerOrStaff, type AuthUser } from "@/lib/withAuth";
import {
  Flight,
  Inventory,
  PNR,
  Ticket,
  User,
  type CabinCode,
  type IFare,
  type IFlight,
  type IPNR,
  type IPnrSegment,
} from "@/models";
import { toObjectId } from "@/modules/inventory/helpers";
import { HOLD_TTL_MINUTES, holdSeats, releaseHold } from "@/modules/inventory/service";
import { toPage, withId } from "./common";
import { resolveFareForBooking } from "./fares.service";
import { expirePnrs, loadPnr, pnrHistory, seatCount } from "./pnr-core";
import type { CreatePnrInput, PnrListQuery, UpdatePnrInput } from "./schemas";
import { listTicketsForPnr, voidAllTickets } from "./tickets.service";

export { expirePnrs } from "./pnr-core";

// ---- views ----------------------------------------------------------------

const FLIGHT_SUMMARY_FIELDS = "flightNumber origin destination departure arrival status gate";

export type PnrView = ReturnType<typeof withId<IPNR>> & {
  segments: (IPnrSegment & {
    flight: Pick<IFlight, "flightNumber" | "origin" | "destination" | "departure" | "arrival" | "status" | "gate"> | null;
  })[];
};

/** PNRs as API objects: `id` instead of `_id`, and each segment carries a summary of its flight. */
export async function buildPnrViews(pnrs: IPNR[]): Promise<PnrView[]> {
  const ids = [...new Set(pnrs.flatMap((p) => p.segments.map((s) => s.flightId.toString())))];
  const flights = await Flight.find({ _id: { $in: ids } })
    .select(FLIGHT_SUMMARY_FIELDS)
    .lean();
  const byId = new Map(flights.map((f) => [f._id.toString(), f]));
  return pnrs.map((pnr) => {
    const view = withId(pnr);
    return {
      ...view,
      segments: pnr.segments.map((s) => {
        const f = byId.get(s.flightId.toString());
        return {
          ...s,
          flight: f
            ? {
                flightNumber: f.flightNumber,
                origin: f.origin,
                destination: f.destination,
                departure: f.departure,
                arrival: f.arrival,
                status: f.status,
                gate: f.gate,
              }
            : null,
        };
      }),
    } as PnrView;
  });
}

export async function buildPnrView(pnr: IPNR): Promise<PnrView> {
  return (await buildPnrViews([pnr]))[0];
}

// ---- locator --------------------------------------------------------------

const LOCATOR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid misreading

export function generateRecordLocator(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) out += LOCATOR_ALPHABET[randomInt(LOCATOR_ALPHABET.length)];
  return out;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

// ---- itinerary planning ---------------------------------------------------

interface PlannedSegment {
  flight: IFlight;
  cabin: CabinCode;
  fare: IFare;
  bookingClass: string;
}

function assertPassengerMix(passengers: { type: string }[]) {
  const adults = passengers.filter((p) => p.type === "ADULT").length;
  const infants = passengers.filter((p) => p.type === "INFANT").length;
  if (adults < 1) throw AppError.badRequest("At least one adult passenger is required");
  if (infants > adults) throw AppError.badRequest("There can be at most one infant per adult");
}

/** Validate flights (bookable, ordered, no duplicates) and resolve a fare + cabin for each requested segment. */
async function planSegments(
  requested: { flightId: string; bookingClass: string; fareId?: string }[],
  now: Date,
): Promise<{ plan: PlannedSegment[]; currency: string }> {
  const plan: PlannedSegment[] = [];
  const seen = new Set<string>();
  for (const req of requested) {
    if (seen.has(req.flightId)) throw AppError.badRequest("The same flight cannot appear twice in an itinerary");
    seen.add(req.flightId);

    const flight = await Flight.findById(toObjectId(req.flightId, "flightId")).lean();
    if (!flight) throw AppError.notFound(`Flight ${req.flightId} not found`);
    if (flight.status !== "SCHEDULED") throw AppError.conflict(`Flight ${flight.flightNumber} is ${flight.status} and cannot be booked`);
    if (flight.departure <= now) throw AppError.conflict(`Flight ${flight.flightNumber} has already departed`);

    const prev = plan[plan.length - 1];
    if (prev && flight.departure < prev.flight.arrival) {
      throw AppError.badRequest("Segments must be in chronological order and not overlap");
    }

    const inventory = await Inventory.findOne({ flightId: flight._id }).lean();
    if (!inventory) throw AppError.conflict(`Flight ${flight.flightNumber} has no inventory and cannot be booked`);
    const { fare, cabin } = await resolveFareForBooking(flight, inventory, req.bookingClass, req.fareId);
    plan.push({ flight, cabin, fare, bookingClass: req.bookingClass });
  }
  const currencies = new Set(plan.map((p) => p.fare.currency));
  if (currencies.size > 1) throw AppError.badRequest("All fares in a PNR must share the same currency");
  return { plan, currency: plan[0].fare.currency };
}

const toSegment = (p: PlannedSegment): IPnrSegment => ({
  flightId: p.flight._id,
  bookingClass: p.bookingClass,
  cabin: p.cabin,
  fareId: p.fare._id,
  fareAmount: p.fare.price,
});

const segmentKey = (s: { flightId: { toString(): string }; cabin: string; bookingClass: string }) =>
  `${s.flightId.toString()}|${s.cabin}|${s.bookingClass}`;

// ---- create ---------------------------------------------------------------

async function resolveOwner(user: AuthUser, input: CreatePnrInput): Promise<string> {
  if (user.role !== "staff") {
    if ((input.ownerUserId && input.ownerUserId !== user.id) || (input.ownerEmail && input.ownerEmail !== user.email)) {
      throw AppError.forbidden("Passengers can only book for themselves");
    }
    return user.id;
  }
  if (input.ownerUserId) {
    if (!(await User.exists({ _id: toObjectId(input.ownerUserId, "ownerUserId") }))) throw AppError.notFound("Owner user not found");
    return input.ownerUserId;
  }
  if (input.ownerEmail) {
    const owner = await User.findOne({ email: input.ownerEmail }).select("_id").lean();
    if (!owner) throw AppError.notFound("No user with that ownerEmail");
    return owner._id.toString();
  }
  return user.id;
}

/**
 * Create a HELD PNR: validate, reserve a unique locator, then hold one seat per non-infant passenger in each
 * segment's bucket (atomic, so it fails with 409 instead of overselling). Any failure releases everything.
 */
export async function createPnr(user: AuthUser, input: CreatePnrInput) {
  const now = new Date();
  assertPassengerMix(input.passengers);
  const ownerId = await resolveOwner(user, input);
  const seats = seatCount(input.passengers);
  const { plan, currency } = await planSegments(input.segments, now);

  const totalAmount = plan.reduce((sum, p) => sum + p.fare.price * seats, 0);
  const holdExpiresAt = new Date(now.getTime() + HOLD_TTL_MINUTES * 60_000);

  // Insert first: the unique index reserves the locator (a rare collision just draws another one).
  let pnr: IPNR | null = null;
  for (let attempt = 0; attempt < 8 && !pnr; attempt += 1) {
    try {
      const doc = await PNR.create({
        recordLocator: generateRecordLocator(),
        ownerUserId: toObjectId(ownerId, "ownerUserId"),
        passengers: input.passengers,
        segments: plan.map(toSegment),
        contact: input.contact,
        status: "HELD",
        holdExpiresAt,
        totalAmount,
        currency,
        history: [pnrHistory(user.id, "CREATED", { seats, segments: plan.length, totalAmount })],
      });
      pnr = doc.toObject();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  if (!pnr) throw new Error("Could not allocate a unique record locator");

  try {
    for (const p of plan) {
      await holdSeats(p.flight._id, p.cabin, p.bookingClass, seats, pnr.recordLocator, HOLD_TTL_MINUTES);
    }
  } catch (err) {
    await releaseHold(pnr.recordLocator);
    await PNR.deleteOne({ _id: pnr._id });
    throw err;
  }
  return buildPnrView(pnr);
}

// ---- read -----------------------------------------------------------------

export async function listPnrs(user: AuthUser, query: PnrListQuery) {
  await expirePnrs();
  const filter: Record<string, unknown> = {};
  if (user.role !== "staff") {
    filter.ownerUserId = toObjectId(user.id, "user id");
  } else if (query.ownerUserId) {
    filter.ownerUserId = toObjectId(query.ownerUserId, "ownerUserId");
  }
  if (query.status) filter.status = query.status;
  if (query.locator) filter.recordLocator = query.locator;
  if (query.email) filter["contact.email"] = query.email;
  if (query.flightId) filter["segments.flightId"] = toObjectId(query.flightId, "flightId");

  const [items, total] = await Promise.all([
    PNR.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    PNR.countDocuments(filter),
  ]);
  return toPage(await buildPnrViews(items), query.page, query.limit, total);
}

export async function getPnrForUser(locator: string, user: AuthUser) {
  const pnr = await loadPnr(locator);
  assertOwnerOrStaff(user, pnr.ownerUserId);
  const [view, tickets] = await Promise.all([buildPnrView(pnr), listTicketsForPnr(pnr._id)]);
  return { pnr: view, tickets: tickets.map(withId) };
}

// ---- update ---------------------------------------------------------------

/**
 * Change passenger names/DOB and contact (names are locked once TICKETED, since tickets carry them), or
 * reschedule the itinerary. Rescheduling is only allowed while HELD: the new seats are held first and the old
 * ones released only after the PNR update succeeds; if a new hold fails nothing changes (409).
 */
export async function updatePnr(locator: string, user: AuthUser, patch: UpdatePnrInput) {
  const now = new Date();
  const pnr = await loadPnr(locator, now);
  assertOwnerOrStaff(user, pnr.ownerUserId);
  if (pnr.status === "CANCELLED" || pnr.status === "EXPIRED") throw AppError.conflict(`PNR is ${pnr.status} and cannot be changed`);

  const $set: Record<string, unknown> = {};
  const changed: string[] = [];

  if (patch.passengers) {
    if (pnr.status !== "HELD") {
      throw AppError.conflict(`Passenger details cannot be changed once the PNR is ${pnr.status}; void tickets or cancel and rebook`);
    }
    const passengers = pnr.passengers.map((p) => ({ ...p }));
    for (const change of patch.passengers) {
      const target = passengers.find((p) => p.id === change.id);
      if (!target) throw AppError.badRequest(`Passenger ${change.id} is not on this PNR`);
      if (change.firstName) target.firstName = change.firstName;
      if (change.lastName) target.lastName = change.lastName;
      if (change.dateOfBirth) target.dateOfBirth = change.dateOfBirth;
    }
    $set.passengers = passengers;
    changed.push("passengers");
  }
  if (patch.contact) {
    for (const [key, value] of Object.entries(patch.contact)) {
      if (value !== undefined) $set[`contact.${key}`] = value;
    }
    changed.push("contact");
  }

  let newHolds: PlannedSegment[] = [];
  let staleHolds: IPnrSegment[] = [];
  if (patch.segments) {
    if (pnr.status !== "HELD") {
      throw AppError.conflict(`Itinerary cannot be changed once the PNR is ${pnr.status}; cancel it and rebook`);
    }
    const seats = seatCount(pnr.passengers);
    const { plan, currency } = await planSegments(patch.segments, now);
    const oldKeys = new Set(pnr.segments.map(segmentKey));
    const newSegments = plan.map(toSegment);
    const newKeys = new Set(newSegments.map(segmentKey));
    newHolds = plan.filter((p) => !oldKeys.has(segmentKey(toSegment(p))));
    staleHolds = pnr.segments.filter((s) => !newKeys.has(segmentKey(s)));

    // Hold the new seats first, keeping the PNR's original expiry.
    const minutesLeft = Math.max(0.01, ((pnr.holdExpiresAt ?? now).getTime() - now.getTime()) / 60_000);
    const done: PlannedSegment[] = [];
    try {
      for (const p of newHolds) {
        await holdSeats(p.flight._id, p.cabin, p.bookingClass, seats, pnr.recordLocator, minutesLeft);
        done.push(p);
      }
    } catch (err) {
      await rollbackHolds(pnr.recordLocator, done);
      throw err;
    }
    $set.segments = newSegments;
    $set.currency = currency;
    $set.totalAmount = plan.reduce((sum, p) => sum + p.fare.price * seats, 0);
    changed.push("segments");
  }

  const updated = await PNR.findOneAndUpdate(
    { _id: pnr._id, status: pnr.status, ...(patch.segments ? { holdExpiresAt: { $gt: now } } : {}) },
    {
      $set,
      $push: { history: pnrHistory(user.id, patch.segments ? "RESCHEDULED" : "UPDATED", { changed }) },
    },
    { returnDocument: "after", runValidators: true },
  ).lean();

  if (!updated) {
    await rollbackHolds(pnr.recordLocator, newHolds);
    throw AppError.conflict("PNR changed or expired while updating; refresh and retry");
  }
  for (const s of staleHolds) {
    await releaseHold(pnr.recordLocator, { flightId: s.flightId, cabin: s.cabin, bucketClass: s.bookingClass });
  }
  return buildPnrView(updated);
}

async function rollbackHolds(locator: string, planned: PlannedSegment[]) {
  for (const p of planned) {
    await releaseHold(locator, { flightId: p.flight._id, cabin: p.cabin, bucketClass: p.bookingClass });
  }
}

// ---- cancel ---------------------------------------------------------------

/**
 * Cancel a PNR: HELD -> release the held seats; TICKETED -> void every ticket and release the sold seats.
 * Owner or staff. Idempotent for already-cancelled PNRs (`alreadyCancelled: true`).
 */
export async function cancelPnr(locator: string, user: AuthUser) {
  const now = new Date();
  const pnr = await loadPnr(locator, now);
  assertOwnerOrStaff(user, pnr.ownerUserId);

  if (pnr.status === "CANCELLED") return { pnr: await buildPnrView(pnr), alreadyCancelled: true, heldSeatsReleased: 0, ticketsVoided: 0 };
  if (pnr.status === "EXPIRED") throw AppError.conflict("PNR has expired; there is nothing to cancel");
  if (pnr.status === "CONFIRMED") {
    throw AppError.conflict("Ticket issuance is in progress for this PNR; complete or retry ticketing, then cancel");
  }
  if (pnr.status === "TICKETED") {
    if (await Ticket.exists({ pnrId: pnr._id, status: "USED" })) {
      throw AppError.conflict("PNR has used tickets (passengers have flown) and cannot be cancelled");
    }
    const departed = await Flight.exists({ _id: { $in: pnr.segments.map((s) => s.flightId) }, departure: { $lte: now } });
    if (departed) throw AppError.conflict("A flight on this PNR has already departed; it cannot be cancelled");
  }

  const before = await PNR.findOneAndUpdate(
    { _id: pnr._id, status: { $in: ["HELD", "TICKETED"] } },
    {
      $set: { status: "CANCELLED" },
      $unset: { holdExpiresAt: "" },
      $push: { history: pnrHistory(user.id, "CANCELLED", { previousStatus: pnr.status }) },
    },
    { returnDocument: "before" },
  ).lean();
  if (!before) {
    const current = await loadPnr(locator);
    if (current.status === "CANCELLED") return { pnr: await buildPnrView(current), alreadyCancelled: true, heldSeatsReleased: 0, ticketsVoided: 0 };
    throw AppError.conflict(`PNR is ${current.status} and cannot be cancelled`);
  }

  const heldSeatsReleased = await releaseHold(before.recordLocator);
  const ticketsVoided = before.status === "TICKETED" ? await voidAllTickets(before, user.id) : 0;
  const after = await PNR.findById(pnr._id).lean();
  return { pnr: await buildPnrView(after!), alreadyCancelled: false, heldSeatsReleased, ticketsVoided };
}
