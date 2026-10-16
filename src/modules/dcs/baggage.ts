import { randomInt } from "node:crypto";
import { AppError } from "@/lib/errors";
import { assertOwnerOrStaff, type AuthUser } from "@/lib/withAuth";
import {
  Baggage,
  CheckIn,
  Fare,
  PNR,
  Ticket,
  type BaggageStatus,
  type IBaggage,
  type ICheckIn,
  type IFare,
  type IPNR,
  type ITicket,
} from "@/models";
import { airlineCode, DEFAULT_BAGGAGE_ALLOWANCE_KG } from "./constants";
import { getFlightOrThrow, getPnrByLocator, isDuplicateKey, toObjectId, type Page } from "./common";
import type { BaggageCreateInput } from "./schemas";

/**
 * Baggage rules
 * -------------
 * - Tag number: airline code + 10 random digits, e.g. "PS0123456789" (unique index, retried on collision).
 * - Allowance: `Fare.rules.checkedBaggageKg` of the passenger's ticket; DEFAULT_BAGGAGE_ALLOWANCE_KG (23)
 *   when the fare cannot be resolved. It is a per-passenger TOTAL for the flight over all non-offloaded bags.
 * - A bag that pushes the total over the allowance is rejected (409 BAGGAGE_OVER_ALLOWANCE) unless the
 *   request sets `acceptExcess: true`; then it is recorded with `excess: true` and `excessKg` (the part of
 *   this bag that is over the allowance).
 * - Transitions: CHECKED -> SCREENED -> LOADED; OFFLOADED from CHECKED, SCREENED or LOADED. OFFLOADED is final.
 */

const NEXT_STATUS: Record<BaggageStatus, BaggageStatus[]> = {
  CHECKED: ["SCREENED", "OFFLOADED"],
  SCREENED: ["LOADED", "OFFLOADED"],
  LOADED: ["OFFLOADED"],
  OFFLOADED: [],
};

export function canTransition(from: BaggageStatus, to: BaggageStatus): boolean {
  return NEXT_STATUS[from].includes(to);
}

/** Pure excess calculation: how many kg of `newBagKg` exceed the allowance given what is already checked. */
export function computeExcess(existingKg: number, newBagKg: number, allowanceKg: number) {
  const over = (total: number) => Math.max(0, total - allowanceKg);
  const excessKg = Math.round((over(existingKg + newBagKg) - over(existingKg)) * 100) / 100;
  return { excessKg, excess: excessKg > 0 };
}

function newTagNumber(): string {
  return `${airlineCode()}${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}`;
}

async function resolveCheckIn(input: BaggageCreateInput): Promise<{ checkIn: ICheckIn; pnr: IPNR }> {
  if (input.checkInId) {
    const checkIn = await CheckIn.findById(toObjectId(input.checkInId, "check-in id")).lean<ICheckIn>();
    if (!checkIn) throw new AppError(409, "NOT_CHECKED_IN", "Passenger is not checked in");
    const pnr = await PNR.findById(checkIn.pnrId).lean<IPNR>();
    if (!pnr) throw AppError.notFound("PNR not found");
    return { checkIn, pnr };
  }

  const pnr = await getPnrByLocator(input.pnrLocator!);
  let passengerId = input.passengerId;
  if (!passengerId) {
    if (pnr.passengers.length !== 1) throw AppError.badRequest("passengerId is required when the PNR has more than one passenger");
    passengerId = pnr.passengers[0].id;
  }
  if (!pnr.passengers.some((p) => p.id === passengerId)) throw AppError.notFound("Passenger not found on this PNR");

  const filter: Record<string, unknown> = { pnrId: pnr._id, passengerId };
  if (input.flightId) filter.flightId = toObjectId(input.flightId, "flight id");
  const all = await CheckIn.find(filter).lean<ICheckIn[]>();
  const active = all.filter((c) => c.status === "CHECKED_IN");
  if (active.length === 0) {
    throw new AppError(409, "NOT_CHECKED_IN", all.length ? `Check-in status is ${all[0].status}` : "Passenger is not checked in");
  }
  if (active.length > 1) throw AppError.badRequest("Passenger is checked in on several flights; provide flightId");
  return { checkIn: active[0], pnr };
}

async function allowanceFor(ticketId: ICheckIn["ticketId"]): Promise<number> {
  const ticket = await Ticket.findById(ticketId).lean<ITicket>();
  if (!ticket) return DEFAULT_BAGGAGE_ALLOWANCE_KG;
  const fare = await Fare.findById(ticket.fareId).lean<IFare>();
  const kg = fare?.rules?.checkedBaggageKg;
  return typeof kg === "number" ? kg : DEFAULT_BAGGAGE_ALLOWANCE_KG;
}

/** Staff: accept a bag for a checked-in passenger and create its tag. */
export async function createBaggage(user: AuthUser, input: BaggageCreateInput): Promise<IBaggage> {
  const { checkIn } = await resolveCheckIn(input);
  if (checkIn.status !== "CHECKED_IN") {
    throw new AppError(409, "NOT_CHECKED_IN", `Passenger check-in status is ${checkIn.status}`);
  }
  const flight = await getFlightOrThrow(checkIn.flightId);
  if (flight.status === "CANCELLED" || flight.status === "CLOSED" || flight.status === "DEPARTED") {
    throw AppError.conflict(`Cannot accept baggage: flight is ${flight.status}`);
  }

  const scope = { pnrId: checkIn.pnrId, passengerId: checkIn.passengerId, flightId: checkIn.flightId };
  const [{ total = 0 } = {}] = await Baggage.aggregate<{ total: number }>([
    { $match: { ...scope, status: { $ne: "OFFLOADED" } } },
    { $group: { _id: null, total: { $sum: "$weightKg" } } },
  ]);
  const allowanceKg = await allowanceFor(checkIn.ticketId);
  const { excess, excessKg } = computeExcess(total, input.weightKg, allowanceKg);
  if (excess && !input.acceptExcess) {
    throw new AppError(409, "BAGGAGE_OVER_ALLOWANCE", `Bag exceeds the ${allowanceKg}kg allowance by ${excessKg}kg`, {
      allowanceKg,
      alreadyCheckedKg: total,
      bagKg: input.weightKg,
      excessKg,
    });
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const doc = await Baggage.create({
        tagNumber: newTagNumber(),
        pnrId: checkIn.pnrId,
        pnrLocator: checkIn.pnrLocator,
        passengerId: checkIn.passengerId,
        flightId: checkIn.flightId,
        weightKg: input.weightKg,
        excess,
        excessKg,
        allowanceKg,
        status: "CHECKED",
        history: [{ at: new Date(), status: "CHECKED", actor: user.id }],
      });
      return doc.toObject();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // tag collision: retry with a new number
    }
  }
  throw AppError.conflict("Could not generate a unique bag tag; please retry");
}

/** Staff: move a bag along CHECKED -> SCREENED -> LOADED, or OFFLOAD it. */
export async function updateBaggageStatus(user: AuthUser, tag: string, to: BaggageStatus): Promise<IBaggage> {
  const bag = await Baggage.findOne({ tagNumber: tag.toUpperCase() }).lean<IBaggage>();
  if (!bag) throw AppError.notFound("Bag not found");
  if (!canTransition(bag.status, to)) {
    throw AppError.conflict(`Invalid transition ${bag.status} -> ${to}`, { from: bag.status, to, allowed: NEXT_STATUS[bag.status] });
  }
  const flight = await getFlightOrThrow(bag.flightId);
  if (flight.status === "DEPARTED") throw AppError.conflict("Flight has already departed");

  const updated = await Baggage.findOneAndUpdate(
    { _id: bag._id, status: bag.status }, // compare-and-set: loses cleanly against a concurrent change
    { $set: { status: to }, $push: { history: { at: new Date(), status: to, actor: user.id } } },
    { returnDocument: "after" },
  ).lean<IBaggage>();
  if (!updated) throw AppError.conflict("Bag status changed concurrently; reload and retry");
  return updated;
}

export async function getBaggage(user: AuthUser, tag: string): Promise<IBaggage> {
  const bag = await Baggage.findOne({ tagNumber: tag.toUpperCase() }).lean<IBaggage>();
  if (!bag) throw AppError.notFound("Bag not found");
  const pnr = await PNR.findById(bag.pnrId).select("ownerUserId").lean<Pick<IPNR, "ownerUserId">>();
  if (!pnr) throw AppError.notFound("PNR not found");
  assertOwnerOrStaff(user, pnr.ownerUserId);
  return bag;
}

/** Staff: everything. Passenger: only bags of PNRs they own (`pnr` must be theirs; `flightId` is auto-scoped). */
export async function listBaggage(
  user: AuthUser,
  q: { pnr?: string; flightId?: string } & Page,
): Promise<{ baggage: IBaggage[]; total: number; page: number; limit: number }> {
  if (!q.pnr && !q.flightId) throw AppError.badRequest("Provide pnr and/or flightId");
  const filter: Record<string, unknown> = {};
  if (q.pnr) {
    const pnr = await getPnrByLocator(q.pnr);
    assertOwnerOrStaff(user, pnr.ownerUserId);
    filter.pnrId = pnr._id;
  }
  if (q.flightId) {
    filter.flightId = toObjectId(q.flightId, "flight id");
    if (user.role !== "staff" && !q.pnr) {
      const own = await PNR.find({ ownerUserId: user.id }).select("_id").lean<Pick<IPNR, "_id">[]>();
      filter.pnrId = { $in: own.map((p) => p._id) };
    }
  }
  const [baggage, total] = await Promise.all([
    Baggage.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<IBaggage[]>(),
    Baggage.countDocuments(filter),
  ]);
  return { baggage, total, page: q.page, limit: q.limit };
}
