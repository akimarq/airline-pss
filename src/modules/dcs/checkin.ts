import { AppError } from "@/lib/errors";
import { assertOwnerOrStaff, type AuthUser } from "@/lib/withAuth";
import {
  Baggage,
  BoardingPass,
  CheckIn,
  PNR,
  Ticket,
  type IAircraft,
  type IBoardingPass,
  type ICheckIn,
  type IFlight,
  type IPNR,
  type IPnrPassenger,
  type ITicket,
} from "@/models";
import { CHECKIN_CLOSE_MINUTES_BEFORE, CHECKIN_OPEN_HOURS_BEFORE } from "./constants";
import {
  dupKeyFields,
  getAircraftOrThrow,
  getFlightOrThrow,
  getPnrByLocator,
  isDuplicateKey,
  sleep,
  toObjectId,
  type Page,
} from "./common";
import { activeCheckIns, enumerateSeats } from "./seatmap";
import { generateBoardingPass } from "./boardingPass";
import type { CheckInInput } from "./schemas";

/**
 * Check-in rules and documented decisions
 * ---------------------------------------
 * - Window: opens 24h before scheduled departure, closes 45min before (inclusive at both edges).
 * - Staff may pass `override: true` to check in AFTER the closing cutoff (late, at the desk).
 *   The override NEVER bypasses the "not yet open" case, nor a cancelled/closed/departed flight.
 *   Passengers sending `override` get 403.
 * - Passengers: channel ONLINE only (and only their own PNR). Staff: ONLINE or AIRPORT, any PNR.
 * - Infants (lap infants) get NO seat. They are checked in so load control counts them and they get
 *   a boarding pass, but occupy the pseudo seat "INF-<boardingSequence>" (unique per flight, never part of
 *   the seat map, never counted as a physical seat). Requesting a seat for an infant is rejected (400).
 * - Boarding sequence is `max(sequence on the flight) + 1`, protected by the unique
 *   (flightId, boardingSequence) index; on a duplicate-key race we retry. Sequences of cancelled check-ins
 *   are not reused unless they were the highest.
 */

export const CHECKIN_ALLOWED_FLIGHT_STATUSES = ["SCHEDULED", "BOARDING"] as const;
const MAX_ATTEMPTS = 40;

export type WindowState = "TOO_EARLY" | "OPEN" | "CLOSED";

/** Pure check-in window evaluation. */
export function evaluateCheckInWindow(departure: Date, now: Date): WindowState {
  const opens = departure.getTime() - CHECKIN_OPEN_HOURS_BEFORE * 3_600_000;
  const closes = departure.getTime() - CHECKIN_CLOSE_MINUTES_BEFORE * 60_000;
  if (now.getTime() < opens) return "TOO_EARLY";
  if (now.getTime() > closes) return "CLOSED";
  return "OPEN";
}

function parseSeat(seat: string): { row: number; letter: string } {
  const m = /^(\d{1,3})([A-Za-z])$/.exec(seat.trim());
  if (!m) throw AppError.badRequest(`Invalid seat '${seat}'`);
  return { row: Number(m[1]), letter: m[2].toUpperCase() };
}

/** Validate a requested seat against the aircraft layout and the cabin the passenger booked. */
export function validateSeatForCabin(aircraft: Pick<IAircraft, "cabins">, cabin: string, rawSeat: string): string {
  const { row, letter } = parseSeat(rawSeat);
  const seat = `${row}${letter}`;
  const contains = (l: IAircraft["cabins"][number]) =>
    row >= l.firstRow && row <= l.lastRow && l.seatLetters.some((s) => s.toUpperCase() === letter);
  if (aircraft.cabins.some((l) => l.cabin === cabin && contains(l))) return seat;
  const other = aircraft.cabins.find((l) => l.cabin !== cabin && contains(l));
  if (other) {
    throw AppError.badRequest(`Seat ${seat} is in cabin ${other.cabin}, but the passenger booked cabin ${cabin}`);
  }
  throw AppError.badRequest(`Seat ${seat} does not exist on this aircraft`);
}

function pickFreeSeat(aircraft: Pick<IAircraft, "cabins">, cabin: string, taken: Set<string>): string | null {
  for (const layout of aircraft.cabins.filter((l) => l.cabin === cabin)) {
    for (const seat of enumerateSeats(layout)) if (!taken.has(seat)) return seat;
  }
  return null;
}

async function resolveTicket(pnr: IPNR, input: CheckInInput): Promise<{ ticket: ITicket; passenger: IPnrPassenger }> {
  let ticket: ITicket | null = null;

  if (input.ticketId) {
    ticket = await Ticket.findById(toObjectId(input.ticketId, "ticket id")).lean<ITicket>();
    if (!ticket || ticket.pnrId.toString() !== pnr._id.toString()) throw AppError.notFound("Ticket not found on this PNR");
    if (input.passengerId && input.passengerId !== ticket.passengerId) {
      throw AppError.badRequest("passengerId does not match the ticket");
    }
    if (input.segmentIndex !== undefined && input.segmentIndex !== ticket.segmentIndex) {
      throw AppError.badRequest("segmentIndex does not match the ticket");
    }
  } else {
    let passengerId = input.passengerId;
    if (!passengerId) {
      if (pnr.passengers.length !== 1) {
        throw AppError.badRequest("passengerId is required when the PNR has more than one passenger");
      }
      passengerId = pnr.passengers[0].id;
    }
    const candidates = await Ticket.find({ pnrId: pnr._id, passengerId, segmentIndex: input.segmentIndex }).lean<ITicket[]>();
    ticket = candidates.find((t) => t.status === "ISSUED") ?? candidates[0] ?? null;
    if (!ticket) throw AppError.notFound("No ticket found for this passenger and segment");
  }

  const passenger = pnr.passengers.find((p) => p.id === ticket.passengerId);
  if (!passenger) throw AppError.notFound("Passenger not found on this PNR");
  if (ticket.status === "VOID") throw new AppError(409, "TICKET_VOID", "Ticket is void");
  if (ticket.status !== "ISSUED") throw new AppError(409, "TICKET_NOT_VALID", `Ticket status is ${ticket.status}`);
  return { ticket, passenger };
}

async function nextSequence(flightId: ICheckIn["flightId"]): Promise<number> {
  const last = await CheckIn.findOne({ flightId }).sort({ boardingSequence: -1 }).select("boardingSequence").lean();
  return (last?.boardingSequence ?? 0) + 1;
}

export interface CheckInResult {
  checkIn: ICheckIn;
  boardingPass: IBoardingPass;
}

/**
 * Check a passenger in for one segment and generate the boarding pass.
 * `now` is injectable for tests.
 */
export async function checkInPassenger(user: AuthUser, input: CheckInInput, now: Date = new Date()): Promise<CheckInResult> {
  const pnr = await getPnrByLocator(input.pnrLocator);
  assertOwnerOrStaff(user, pnr.ownerUserId);

  if (user.role !== "staff") {
    if (input.channel !== "ONLINE") throw AppError.forbidden("Passengers can only check in through the ONLINE channel");
    if (input.override) throw AppError.forbidden("Only staff can override the check-in window");
  }

  if (pnr.status !== "TICKETED") throw AppError.conflict(`PNR must be TICKETED to check in (status: ${pnr.status})`);

  const { ticket, passenger } = await resolveTicket(pnr, input);
  const segment = pnr.segments[ticket.segmentIndex];
  if (!segment || segment.flightId.toString() !== ticket.flightId.toString()) {
    throw AppError.conflict("Ticket does not match the PNR segment");
  }

  const flight = await getFlightOrThrow(ticket.flightId);
  if (flight.status === "CANCELLED") throw new AppError(409, "FLIGHT_CANCELLED", "Flight is cancelled");
  if (!(CHECKIN_ALLOWED_FLIGHT_STATUSES as readonly string[]).includes(flight.status)) {
    throw new AppError(409, "FLIGHT_CLOSED", `Check-in is not possible: flight is ${flight.status}`);
  }

  const window = evaluateCheckInWindow(flight.departure, now);
  if (window === "TOO_EARLY") {
    throw new AppError(409, "CHECKIN_NOT_OPEN", `Check-in opens ${CHECKIN_OPEN_HOURS_BEFORE}h before departure`, {
      opensAt: new Date(flight.departure.getTime() - CHECKIN_OPEN_HOURS_BEFORE * 3_600_000),
    });
  }
  if (window === "CLOSED" && !(user.role === "staff" && input.override === true)) {
    throw new AppError(409, "CHECKIN_CLOSED", `Check-in closed ${CHECKIN_CLOSE_MINUTES_BEFORE} minutes before departure`, {
      closedAt: new Date(flight.departure.getTime() - CHECKIN_CLOSE_MINUTES_BEFORE * 60_000),
    });
  }

  const isInfant = passenger.type === "INFANT";
  if (isInfant && input.seat) throw AppError.badRequest("Infants travel on a lap and cannot be assigned a seat");

  const aircraft = await getAircraftOrThrow(flight.aircraftId);
  const requestedSeat = !isInfant && input.seat ? validateSeatForCabin(aircraft, segment.cabin, input.seat) : undefined;

  if (await CheckIn.exists({ ticketId: ticket._id })) {
    throw new AppError(409, "ALREADY_CHECKED_IN", "Passenger is already checked in for this segment");
  }

  const checkIn = await insertCheckIn({ user, input, pnr, ticket, passenger, flight, aircraft, cabin: segment.cabin, requestedSeat, isInfant, now });

  try {
    const boardingPass = await generateBoardingPass(checkIn, flight, pnr);
    return { checkIn, boardingPass };
  } catch (err) {
    await CheckIn.deleteOne({ _id: checkIn._id }); // do not leave a check-in without a pass
    throw err;
  }
}

interface InsertArgs {
  user: AuthUser;
  input: CheckInInput;
  pnr: IPNR;
  ticket: ITicket;
  passenger: IPnrPassenger;
  flight: IFlight;
  aircraft: IAircraft;
  cabin: string;
  requestedSeat?: string;
  isInfant: boolean;
  now: Date;
}

async function insertCheckIn(a: InsertArgs): Promise<ICheckIn> {
  const flightId = a.flight._id;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const sequence = await nextSequence(flightId);

    let seat: string;
    if (a.isInfant) {
      seat = `INF-${sequence}`;
    } else if (a.requestedSeat) {
      seat = a.requestedSeat;
      if (await CheckIn.exists({ flightId, seat, status: { $in: ["CHECKED_IN", "BOARDED"] } })) {
        throw new AppError(409, "SEAT_TAKEN", `Seat ${seat} is already taken`);
      }
    } else {
      const taken = new Set((await activeCheckIns(flightId)).map((c) => c.seat));
      const free = pickFreeSeat(a.aircraft, a.cabin, taken);
      if (!free) throw new AppError(409, "NO_SEATS_AVAILABLE", `No free seats left in cabin ${a.cabin}`);
      seat = free;
    }

    try {
      const doc = await CheckIn.create({
        pnrId: a.pnr._id,
        pnrLocator: a.pnr.recordLocator,
        ticketId: a.ticket._id,
        passengerId: a.passenger.id,
        flightId,
        seat,
        boardingSequence: sequence,
        status: "CHECKED_IN",
        channel: a.input.channel,
        checkedInBy: a.user.id,
        checkedInAt: a.now,
      });
      return doc.toObject();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const fields = dupKeyFields(err);
      if (fields.some((f) => f === "ticketId" || f.startsWith("ticketId"))) {
        throw new AppError(409, "ALREADY_CHECKED_IN", "Passenger is already checked in for this segment");
      }
      if (fields.some((f) => f === "seat") && a.requestedSeat) {
        throw new AppError(409, "SEAT_TAKEN", `Seat ${seat} is already taken`);
      }
      // sequence collision, or auto-assigned seat taken in a race: back off and retry
      await sleep(Math.floor(Math.random() * 8 * (attempt + 1)));
    }
  }
  throw AppError.conflict("Could not complete check-in because of heavy concurrent activity; please retry");
}

/** Undo a check-in before boarding. Owner or staff. Frees the seat and deletes the boarding pass. */
export async function cancelCheckIn(user: AuthUser, checkInId: string): Promise<{ cancelled: true; checkInId: string }> {
  const checkIn = await CheckIn.findById(toObjectId(checkInId, "check-in id")).lean<ICheckIn>();
  if (!checkIn) throw AppError.notFound("Check-in not found");
  const pnr = await getPnrByLocator(checkIn.pnrLocator);
  assertOwnerOrStaff(user, pnr.ownerUserId);

  if (checkIn.status === "BOARDED") throw new AppError(409, "ALREADY_BOARDED", "Passenger has already boarded");
  if (checkIn.status !== "CHECKED_IN") throw AppError.conflict(`Check-in is ${checkIn.status}`);

  const flight = await getFlightOrThrow(checkIn.flightId);
  if (flight.status === "CLOSED" || flight.status === "DEPARTED") {
    throw AppError.conflict(`Cannot cancel check-in: flight is ${flight.status}`);
  }
  if (await Baggage.exists({ pnrId: checkIn.pnrId, passengerId: checkIn.passengerId, flightId: checkIn.flightId, status: { $ne: "OFFLOADED" } })) {
    throw AppError.conflict("Passenger still has checked baggage; offload the bags before cancelling check-in");
  }

  const res = await CheckIn.deleteOne({ _id: checkIn._id, status: "CHECKED_IN" });
  if (res.deletedCount !== 1) throw new AppError(409, "ALREADY_BOARDED", "Check-in changed concurrently; passenger may have boarded");
  await BoardingPass.deleteOne({ checkInId: checkIn._id });
  return { cancelled: true, checkInId: checkIn._id.toString() };
}

export interface CheckInListItem extends ICheckIn {
  passengerName?: string;
}

/** List check-ins by flight and/or PNR. Staff: any. Passenger: only a PNR they own. */
export async function listCheckIns(
  user: AuthUser,
  q: { flightId?: string; pnr?: string } & Page,
): Promise<{ checkIns: CheckInListItem[]; total: number; page: number; limit: number }> {
  if (!q.flightId && !q.pnr) throw AppError.badRequest("Provide flightId and/or pnr");
  const filter: Record<string, unknown> = {};
  if (q.pnr) {
    const pnr = await getPnrByLocator(q.pnr);
    assertOwnerOrStaff(user, pnr.ownerUserId);
    filter.pnrId = pnr._id;
  } else if (user.role !== "staff") {
    throw AppError.forbidden("Passengers must query by their own PNR");
  }
  if (q.flightId) filter.flightId = toObjectId(q.flightId, "flight id");

  const [rows, total] = await Promise.all([
    CheckIn.find(filter)
      .sort({ flightId: 1, boardingSequence: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ICheckIn[]>(),
    CheckIn.countDocuments(filter),
  ]);

  const pnrs = await PNR.find({ _id: { $in: [...new Set(rows.map((r) => r.pnrId.toString()))] } }).lean<IPNR[]>();
  const names = new Map<string, string>();
  for (const p of pnrs) for (const pax of p.passengers) names.set(`${p._id}:${pax.id}`, `${pax.lastName}/${pax.firstName}`.toUpperCase());

  return {
    checkIns: rows.map((r) => ({ ...r, passengerName: names.get(`${r.pnrId}:${r.passengerId}`) })),
    total,
    page: q.page,
    limit: q.limit,
  };
}