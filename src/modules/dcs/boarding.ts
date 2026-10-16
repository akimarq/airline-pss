import { AppError } from "@/lib/errors";
import type { AuthUser } from "@/lib/withAuth";
import {
  Baggage,
  BoardingPass,
  CheckIn,
  Flight,
  LoadSheet,
  PNR,
  Ticket,
  type IBoardingPass,
  type ICheckIn,
  type IFlight,
  type IPNR,
  type ITicket,
} from "@/models";
import { parseBcbp } from "./bcbp";
import { getFlightOrThrow, passengerDisplayName, toObjectId } from "./common";
import { releaseSoldSeats } from "./inventoryPort";
import { segmentForFlight } from "./boardingPass";

/**
 * Gate boarding
 * -------------
 * - open:   SCHEDULED -> BOARDING (+ boardingOpen). A FINAL load sheet is REQUIRED (no bypass). Optional gate.
 * - scan:   needs boarding open, the pass belongs to this flight, status CHECKED_IN and an ISSUED ticket (a PNR
 *           cancel / ticket void does not delete the check-in, so a void ticket -> 409 TICKET_NOT_VALID).
 *           BOARDED again -> 409 ALREADY_BOARDED.
 * - close:  BOARDING -> CLOSED. Still requires a FINAL load sheet (it may have been reopened during boarding).
 *           Checked-in-but-not-boarded -> NO_SHOW (their bags -> OFFLOADED). Seats of those no-shows (with an ISSUED
 *           ticket: a void ticket already gave its seat back) AND of
 *           ticketed-but-never-checked-in passengers are released to inventory (non-infants only; ticket status is
 *           untouched). The flight status flips first so no more scans are accepted while the no-shows are processed;
 *           an inventory failure is reported in `inventoryReleaseFailures` and does not block closing.
 * - depart: CLOSED -> DEPARTED, BOARDED passengers' tickets -> USED.
 */

async function requireFinalLoadSheet(flightId: IFlight["_id"]) {
  const sheet = await LoadSheet.findOne({ flightId }).select("status").lean();
  if (!sheet || sheet.status !== "FINAL") {
    throw new AppError(409, "LOAD_SHEET_NOT_FINAL", "A FINAL load sheet is required");
  }
}

export async function openBoarding(_user: AuthUser, flightId: string, opts: { gate?: string } = {}): Promise<IFlight> {
  const flight = await getFlightOrThrow(flightId);
  if (flight.status !== "SCHEDULED") throw AppError.conflict(`Cannot open boarding: flight is ${flight.status}`);
  await requireFinalLoadSheet(flight._id);

  const updated = await Flight.findOneAndUpdate(
    { _id: flight._id, status: "SCHEDULED" },
    { $set: { status: "BOARDING", boardingOpen: true, ...(opts.gate ? { gate: opts.gate.toUpperCase() } : {}) } },
    { returnDocument: "after" },
  ).lean<IFlight>();
  if (!updated) throw AppError.conflict("Flight status changed concurrently");
  if (updated.gate !== flight.gate) {
    await BoardingPass.updateMany({ flightId: flight._id }, { $set: { gate: updated.gate } });
  }
  return updated;
}

export interface ScanResult {
  result: "BOARDED";
  checkInId: string;
  pnrLocator: string;
  passengerName: string;
  seat: string;
  boardingSequence: number;
  boardedAt: Date;
}

export async function scanBoardingPass(
  _user: AuthUser,
  flightId: string,
  input: { barcode?: string; checkInId?: string },
): Promise<ScanResult> {
  const flight = await getFlightOrThrow(flightId);
  if (flight.status !== "BOARDING" || !flight.boardingOpen) {
    throw new AppError(409, "BOARDING_NOT_OPEN", "Boarding is not open for this flight");
  }

  let checkInId: string;
  if (input.barcode) {
    const parsed = parseBcbp(input.barcode);
    const pass = await BoardingPass.findOne({
      pnrLocator: parsed.pnrLocator,
      boardingSequence: parsed.sequence,
      barcode: input.barcode,
    }).lean<IBoardingPass>();
    if (!pass) throw AppError.notFound("Boarding pass not recognised (invalid or cancelled)");
    if (pass.flightId.toString() !== flight._id.toString()) {
      throw new AppError(409, "WRONG_FLIGHT", `Boarding pass is for flight ${pass.flightNumber}, not ${flight.flightNumber}`);
    }
    checkInId = pass.checkInId.toString();
  } else {
    checkInId = input.checkInId!;
  }

  const checkIn = await CheckIn.findById(toObjectId(checkInId, "check-in id")).lean<ICheckIn>();
  if (!checkIn) throw AppError.notFound("Check-in not found");
  if (checkIn.flightId.toString() !== flight._id.toString()) {
    throw new AppError(409, "WRONG_FLIGHT", "Check-in belongs to a different flight");
  }

  const fail = (status: ICheckIn["status"]) => {
    if (status === "BOARDED") return new AppError(409, "ALREADY_BOARDED", "Passenger already boarded");
    return new AppError(409, "NOT_CHECKED_IN", `Passenger check-in status is ${status}`);
  };
  if (checkIn.status !== "CHECKED_IN") throw fail(checkIn.status);

  // Cancelling a PNR / voiding a ticket does not touch DCS check-ins, so the ticket must be re-validated here.
  const ticket = await Ticket.findById(checkIn.ticketId).select("status").lean<Pick<ITicket, "status">>();
  if (!ticket || ticket.status !== "ISSUED") {
    throw new AppError(409, "TICKET_NOT_VALID", `Ticket is ${ticket?.status ?? "missing"}; passenger cannot board`);
  }

  const boardedAt = new Date();
  const updated = await CheckIn.findOneAndUpdate(
    { _id: checkIn._id, status: "CHECKED_IN" },
    { $set: { status: "BOARDED", boardedAt } },
    { returnDocument: "after" },
  ).lean<ICheckIn>();
  if (!updated) {
    const now = await CheckIn.findById(checkIn._id).select("status").lean<Pick<ICheckIn, "status">>();
    throw fail(now?.status ?? "NO_SHOW");
  }

  const pnr = await PNR.findById(checkIn.pnrId).select("passengers").lean<Pick<IPNR, "passengers">>();
  const pax = pnr?.passengers.find((p) => p.id === checkIn.passengerId);
  return {
    result: "BOARDED",
    checkInId: updated._id.toString(),
    pnrLocator: updated.pnrLocator,
    passengerName: pax ? passengerDisplayName(pax) : "",
    seat: updated.seat,
    boardingSequence: updated.boardingSequence,
    boardedAt,
  };
}

/** Ticketed passengers (ISSUED ticket on a TICKETED PNR) with no check-in on this flight. */
async function notCheckedInTickets(flightId: IFlight["_id"]): Promise<{ tickets: ITicket[]; pnrs: Map<string, IPNR> }> {
  const checkedTicketIds = await CheckIn.find({ flightId }).distinct("ticketId");
  const tickets = await Ticket.find({ flightId, status: "ISSUED", _id: { $nin: checkedTicketIds } }).lean<ITicket[]>();
  const pnrs = await loadPnrs(tickets.map((t) => t.pnrId));
  return { tickets: tickets.filter((t) => pnrs.get(t.pnrId.toString())?.status === "TICKETED"), pnrs };
}

async function loadPnrs(ids: Iterable<{ toString(): string }>): Promise<Map<string, IPNR>> {
  const unique = [...new Set([...ids].map((i) => i.toString()))];
  const docs = await PNR.find({ _id: { $in: unique } }).lean<IPNR[]>();
  return new Map(docs.map((p) => [p._id.toString(), p]));
}

export interface ManifestPassenger {
  checkInId: string;
  pnrLocator: string;
  passengerId: string;
  passengerName: string;
  type: string;
  seat: string;
  boardingSequence: number;
  status: ICheckIn["status"];
  channel: ICheckIn["channel"];
  boardedAt?: Date;
}

export interface NoShowCandidate {
  kind: "CHECKED_IN_NOT_BOARDED" | "NOT_CHECKED_IN";
  pnrLocator: string;
  passengerId: string;
  passengerName: string;
  checkInId?: string;
  ticketId: string;
}

export interface Manifest {
  flight: { id: string; flightNumber: string; status: IFlight["status"]; gate?: string; boardingOpen: boolean };
  counts: {
    ticketed: number;
    checkedIn: number; // CHECKED_IN + BOARDED
    boarded: number;
    notYetBoarded: number; // CHECKED_IN
    notCheckedIn: number; // ticketed, no check-in
    noShow: number; // already marked NO_SHOW
    noShowCandidates: number; // notYetBoarded + notCheckedIn
  };
  passengers: ManifestPassenger[];
  noShowCandidates: NoShowCandidate[];
}

export async function getBoardingManifest(flightId: string): Promise<Manifest> {
  const flight = await getFlightOrThrow(flightId);
  const checkIns = await CheckIn.find({ flightId: flight._id }).sort({ boardingSequence: 1 }).lean<ICheckIn[]>();
  const { tickets: missing } = await notCheckedInTickets(flight._id);
  const pnrs = await loadPnrs([...checkIns.map((c) => c.pnrId), ...missing.map((t) => t.pnrId)]);

  const paxOf = (pnrId: { toString(): string }, passengerId: string) =>
    pnrs.get(pnrId.toString())?.passengers.find((p) => p.id === passengerId);

  const passengers: ManifestPassenger[] = checkIns.map((c) => {
    const pax = paxOf(c.pnrId, c.passengerId);
    return {
      checkInId: c._id.toString(),
      pnrLocator: c.pnrLocator,
      passengerId: c.passengerId,
      passengerName: pax ? passengerDisplayName(pax) : "",
      type: pax?.type ?? "ADULT",
      seat: c.seat,
      boardingSequence: c.boardingSequence,
      status: c.status,
      channel: c.channel,
      boardedAt: c.boardedAt,
    };
  });

  const noShowCandidates: NoShowCandidate[] = [
    ...checkIns
      .filter((c) => c.status === "CHECKED_IN")
      .map((c) => ({
        kind: "CHECKED_IN_NOT_BOARDED" as const,
        pnrLocator: c.pnrLocator,
        passengerId: c.passengerId,
        passengerName: passengers.find((p) => p.checkInId === c._id.toString())?.passengerName ?? "",
        checkInId: c._id.toString(),
        ticketId: c.ticketId.toString(),
      })),
    ...missing.map((t) => ({
      kind: "NOT_CHECKED_IN" as const,
      pnrLocator: t.pnrLocator,
      passengerId: t.passengerId,
      passengerName: t.passengerName,
      ticketId: t._id.toString(),
    })),
  ];

  const count = (s: ICheckIn["status"]) => checkIns.filter((c) => c.status === s).length;
  const notYetBoarded = count("CHECKED_IN");
  const ticketedTotal = await Ticket.countDocuments({ flightId: flight._id, status: { $in: ["ISSUED", "USED"] } });
  return {
    flight: {
      id: flight._id.toString(),
      flightNumber: flight.flightNumber,
      status: flight.status,
      gate: flight.gate,
      boardingOpen: flight.boardingOpen,
    },
    counts: {
      ticketed: ticketedTotal,
      checkedIn: notYetBoarded + count("BOARDED"),
      boarded: count("BOARDED"),
      notYetBoarded,
      notCheckedIn: missing.length,
      noShow: count("NO_SHOW"),
      noShowCandidates: noShowCandidates.length,
    },
    passengers,
    noShowCandidates,
  };
}

export interface CloseSummary {
  flightId: string;
  status: "CLOSED";
  boarded: number;
  noShows: { checkedInNotBoarded: number; notCheckedIn: number; total: number };
  seatsReleased: { cabin: string; bucketClass: string; seats: number }[];
  inventoryReleaseFailures: { cabin: string; bucketClass: string; seats: number; error: string }[];
  baggageOffloaded: number;
  closedAt: Date;
}

export async function closeBoarding(user: AuthUser, flightId: string): Promise<CloseSummary> {
  const flight = await getFlightOrThrow(flightId);
  if (flight.status !== "BOARDING") throw AppError.conflict(`Cannot close boarding: flight is ${flight.status}`);
  await requireFinalLoadSheet(flight._id);

  // Flip first: exactly one closer wins and scans are rejected from here on.
  const closed = await Flight.findOneAndUpdate(
    { _id: flight._id, status: "BOARDING" },
    { $set: { status: "CLOSED", boardingOpen: false } },
    { returnDocument: "after" },
  ).lean<IFlight>();
  if (!closed) throw AppError.conflict("Flight status changed concurrently");

  // 1. checked-in but not boarded -> NO_SHOW (atomic per check-in, so a racing scan cannot be overwritten)
  const pending = await CheckIn.find({ flightId: flight._id, status: "CHECKED_IN" }).lean<ICheckIn[]>();
  const noShowCheckIns: ICheckIn[] = [];
  for (const c of pending) {
    const done = await CheckIn.findOneAndUpdate({ _id: c._id, status: "CHECKED_IN" }, { $set: { status: "NO_SHOW" } }, { returnDocument: "after" }).lean<ICheckIn>();
    if (done) noShowCheckIns.push(done);
  }

  // 2. ticketed but never checked in
  const { tickets: neverCheckedIn, pnrs: neverPnrs } = await notCheckedInTickets(flight._id);

  // 3. seats to release (infants hold no inventory seat), grouped by cabin + booking class
  // Only ISSUED tickets still own a sold seat: a void ticket already released its seat when it was voided.
  const noShowTickets = await Ticket.find({ _id: { $in: noShowCheckIns.map((c) => c.ticketId) }, status: "ISSUED" }).lean<ITicket[]>();
  const pnrs = await loadPnrs([...noShowCheckIns.map((c) => c.pnrId), ...neverPnrs.keys()]);
  const groups = new Map<string, { cabin: string; bucketClass: string; seats: number }>();
  const addSeat = (ticket: ITicket) => {
    const pnr = pnrs.get(ticket.pnrId.toString());
    const pax = pnr?.passengers.find((p) => p.id === ticket.passengerId);
    const segment = pnr ? segmentForFlight(pnr, flight) : undefined;
    if (!pnr || !pax || !segment || pax.type === "INFANT") return;
    const key = `${segment.cabin}:${ticket.bookingClass}`;
    const g = groups.get(key) ?? { cabin: segment.cabin, bucketClass: ticket.bookingClass, seats: 0 };
    g.seats++;
    groups.set(key, g);
  };
  noShowTickets.forEach(addSeat);
  neverCheckedIn.forEach(addSeat);

  const seatsReleased: CloseSummary["seatsReleased"] = [];
  const inventoryReleaseFailures: CloseSummary["inventoryReleaseFailures"] = [];
  for (const g of groups.values()) {
    try {
      await releaseSoldSeats(flight._id, g.cabin, g.bucketClass, g.seats, user.id);
      seatsReleased.push(g);
    } catch (err) {
      console.error("[dcs] failed to release no-show seats", g, err);
      inventoryReleaseFailures.push({ ...g, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 4. offload bags of no-show passengers
  let baggageOffloaded = 0;
  for (const c of noShowCheckIns) {
    const res = await Baggage.updateMany(
      { flightId: flight._id, pnrId: c.pnrId, passengerId: c.passengerId, status: { $ne: "OFFLOADED" } },
      { $set: { status: "OFFLOADED" }, $push: { history: { at: new Date(), status: "OFFLOADED", actor: user.id } } },
    );
    baggageOffloaded += res.modifiedCount;
  }

  return {
    flightId: flight._id.toString(),
    status: "CLOSED",
    boarded: await CheckIn.countDocuments({ flightId: flight._id, status: "BOARDED" }),
    noShows: {
      checkedInNotBoarded: noShowCheckIns.length,
      notCheckedIn: neverCheckedIn.length,
      total: noShowCheckIns.length + neverCheckedIn.length,
    },
    seatsReleased,
    inventoryReleaseFailures,
    baggageOffloaded,
    closedAt: new Date(),
  };
}

export async function departFlight(
  _user: AuthUser,
  flightId: string,
): Promise<{ flightId: string; status: "DEPARTED"; boarded: number; ticketsUsed: number }> {
  const flight = await getFlightOrThrow(flightId);
  if (flight.status !== "CLOSED") throw AppError.conflict(`Cannot depart: flight is ${flight.status} (boarding must be closed first)`);
  const updated = await Flight.findOneAndUpdate({ _id: flight._id, status: "CLOSED" }, { $set: { status: "DEPARTED", boardingOpen: false } }, { returnDocument: "after" });
  if (!updated) throw AppError.conflict("Flight status changed concurrently");

  const boarded = await CheckIn.find({ flightId: flight._id, status: "BOARDED" }).select("ticketId").lean<Pick<ICheckIn, "ticketId">[]>();
  const res = await Ticket.updateMany({ _id: { $in: boarded.map((b) => b.ticketId) }, status: "ISSUED" }, { $set: { status: "USED" } });
  return { flightId: flight._id.toString(), status: "DEPARTED", boarded: boarded.length, ticketsUsed: res.modifiedCount };
}
