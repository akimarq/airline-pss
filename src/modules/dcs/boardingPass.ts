import { AppError } from "@/lib/errors";
import { assertOwnerOrStaff, type AuthUser } from "@/lib/withAuth";
import {
  BoardingPass,
  CheckIn,
  Flight,
  PNR,
  type IBoardingPass,
  type ICheckIn,
  type IFlight,
  type IPNR,
  type IPnrSegment,
} from "@/models";
import { buildBcbp } from "./bcbp";
import { BOARDING_MINUTES_BEFORE } from "./constants";
import { getPnrByLocator, passengerDisplayName, toObjectId } from "./common";

/** Infants travel on a lap and have no seat; their check-in carries a pseudo seat "INF-<seq>". */
export const isInfantSeat = (seat: string) => seat.startsWith("INF");

export const boardingTimeFor = (departure: Date) => new Date(departure.getTime() - BOARDING_MINUTES_BEFORE * 60_000);

export function segmentForFlight(pnr: IPNR, flight: IFlight | { _id: unknown }): IPnrSegment | undefined {
  return pnr.segments.find((s) => s.flightId.toString() === String(flight._id));
}

/** Build the (unsaved) boarding-pass fields for a check-in. Pure given its inputs. */
export function boardingPassFields(checkIn: ICheckIn, flight: IFlight, pnr: IPNR) {
  const passenger = pnr.passengers.find((p) => p.id === checkIn.passengerId);
  const segment = segmentForFlight(pnr, flight);
  if (!passenger || !segment) throw AppError.notFound("Passenger or segment no longer exists on this PNR");
  const passengerName = passengerDisplayName(passenger);
  const seat = isInfantSeat(checkIn.seat) ? "INF" : checkIn.seat;
  return {
    checkInId: checkIn._id,
    pnrLocator: pnr.recordLocator,
    passengerName,
    flightId: flight._id,
    flightNumber: flight.flightNumber,
    origin: flight.origin,
    destination: flight.destination,
    departure: flight.departure,
    cabin: segment.cabin,
    seat,
    boardingSequence: checkIn.boardingSequence,
    gate: flight.gate,
    boardingTime: boardingTimeFor(flight.departure),
    barcode: buildBcbp({
      passengerName,
      pnrLocator: pnr.recordLocator,
      origin: flight.origin,
      destination: flight.destination,
      flightNumber: flight.flightNumber,
      departure: flight.departure,
      cabin: segment.cabin,
      seat,
      sequence: checkIn.boardingSequence,
    }),
  };
}

/** Create the boarding pass for a check-in (idempotent: returns the existing one if present). */
export async function generateBoardingPass(checkIn: ICheckIn, flight: IFlight, pnr: IPNR): Promise<IBoardingPass> {
  const fields = boardingPassFields(checkIn, flight, pnr);
  const doc = await BoardingPass.findOneAndUpdate(
    { checkInId: checkIn._id },
    { $setOnInsert: fields },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  return doc.toObject();
}

export interface BoardingPassView extends IBoardingPass {
  checkInStatus: ICheckIn["status"];
}

/**
 * Boarding pass for a check-in. Owner of the PNR or staff. Generated on demand if it is missing,
 * and the gate is refreshed from the flight so a late gate assignment is reflected.
 */
export async function getBoardingPass(user: AuthUser, checkInId: string): Promise<BoardingPassView> {
  const checkIn = await CheckIn.findById(toObjectId(checkInId, "check-in id")).lean<ICheckIn>();
  if (!checkIn) throw AppError.notFound("Check-in not found");
  const pnr = await PNR.findById(checkIn.pnrId).lean<IPNR>();
  if (!pnr) throw AppError.notFound("PNR not found");
  assertOwnerOrStaff(user, pnr.ownerUserId);
  if (checkIn.status === "NO_SHOW") throw AppError.conflict("Passenger was marked as a no-show; no boarding pass");

  const flight = await Flight.findById(checkIn.flightId).lean<IFlight>();
  if (!flight) throw AppError.notFound("Flight not found");

  let pass = await generateBoardingPass(checkIn, flight, pnr);
  if ((pass.gate ?? undefined) !== (flight.gate ?? undefined)) {
    const updated = await BoardingPass.findByIdAndUpdate(pass._id, { $set: { gate: flight.gate } }, { returnDocument: "after" });
    if (updated) pass = updated.toObject();
  }
  return { ...pass, checkInStatus: checkIn.status };
}

/** All boarding passes of a PNR (owner or staff). */
export async function listBoardingPasses(user: AuthUser, locator: string): Promise<IBoardingPass[]> {
  const pnr = await getPnrByLocator(locator);
  assertOwnerOrStaff(user, pnr.ownerUserId);
  const checkIns = await CheckIn.find({ pnrId: pnr._id, status: { $ne: "NO_SHOW" } })
    .select("_id")
    .lean<Pick<ICheckIn, "_id">[]>();
  return BoardingPass.find({ checkInId: { $in: checkIns.map((c) => c._id) } })
    .sort({ departure: 1, boardingSequence: 1 })
    .lean<IBoardingPass[]>();
}