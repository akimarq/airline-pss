import { randomInt, randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { assertOwnerOrStaff, type AuthUser } from "@/lib/withAuth";
import { PNR, Ticket, type IPNR, type ITicket } from "@/models";
import { toObjectId } from "@/modules/inventory/helpers";
import {
  confirmHold,
  releaseHold,
  releaseSoldSeats,
  type ConfirmedHold,
} from "@/modules/inventory/service";
import type { PaymentInput } from "./schemas";
import { loadPnr, pnrHistory } from "./pnr-core";

/** A PNR stuck in CONFIRMED (ticketing crashed mid-way) may be resumed after this long. */
export const TICKETING_STALE_MS = 60_000;

export interface PaymentReceipt {
  method: string;
  status: "PAID";
  reference: string;
  amount: number;
  currency: string;
}

export interface IssueResult {
  pnr: IPNR;
  tickets: ITicket[];
  payment: PaymentReceipt | null;
  /** True when the PNR was already ticketed and this call just returned the existing tickets. */
  alreadyIssued: boolean;
}

// ---- ticket numbers -------------------------------------------------------

function ticketPrefix(): string {
  const prefix = process.env.AIRLINE_TICKET_PREFIX ?? "";
  return /^\d{3}$/.test(prefix) ? prefix : "123";
}

/** 13 digits: 3-digit airline prefix + 10 random digits. Uniqueness is enforced by the DB index (see retry). */
export function generateTicketNumber(): string {
  return `${ticketPrefix()}${String(randomInt(0, 10_000_000_000)).padStart(10, "0")}`;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

async function createTicket(data: Omit<ITicket, "_id" | "ticketNumber" | "createdAt" | "updatedAt">): Promise<ITicket> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const doc = await Ticket.create({ ...data, ticketNumber: generateTicketNumber() });
      return doc.toObject();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // collision on ticketNumber: draw another number
    }
  }
  throw new Error("Could not allocate a unique ticket number");
}

// ---- payment (simulated) --------------------------------------------------

async function settlePayment(user: AuthUser, pnr: IPNR, payment: PaymentInput | undefined): Promise<PaymentReceipt> {
  if (!payment) {
    if (user.role !== "staff") throw AppError.badRequest("payment { method, simulate } is required");
    payment = { method: "staff-desk", simulate: "success" };
  }
  if (payment.simulate === "fail") {
    await PNR.updateOne(
      { _id: pnr._id },
      { $push: { history: pnrHistory(user.id, "PAYMENT_FAILED", { method: payment.method }) } },
    );
    throw new AppError(402, "PAYMENT_FAILED", "Payment was declined; the booking is still held", {
      method: payment.method,
      pnrStatus: pnr.status,
      holdExpiresAt: pnr.holdExpiresAt,
    });
  }
  return {
    method: payment.method,
    status: "PAID",
    reference: `PAY-${randomUUID().slice(0, 8).toUpperCase()}`,
    amount: pnr.totalAmount,
    currency: pnr.currency,
  };
}

export async function listTicketsForPnr(pnrId: IPNR["_id"]): Promise<ITicket[]> {
  return Ticket.find({ pnrId }).sort({ segmentIndex: 1, passengerName: 1, createdAt: 1 }).lean();
}

// ---- issuance -------------------------------------------------------------

/**
 * Issue one ticket per passenger per segment: simulated payment -> claim the PNR (HELD -> CONFIRMED, atomic, so
 * a double click can only win once) -> held seats become sold -> create tickets -> TICKETED.
 *
 * - Idempotent: an already TICKETED PNR returns its tickets with `alreadyIssued: true`.
 * - A declined payment throws 402 and leaves the PNR HELD.
 * - If the seat hold lapsed before ticketing, any seats already converted are released, the PNR becomes EXPIRED
 *   and a 409 is thrown.
 * - A crash mid-way leaves the PNR CONFIRMED; the same call resumes after `TICKETING_STALE_MS`.
 */
export async function issueTickets(
  locator: string,
  user: AuthUser,
  input: { payment?: PaymentInput } = {},
): Promise<IssueResult> {
  const now = new Date();
  const pnr = await loadPnr(locator, now);
  assertOwnerOrStaff(user, pnr.ownerUserId);

  const existingResult = async (current: IPNR): Promise<IssueResult> => ({
    pnr: current,
    tickets: await listTicketsForPnr(current._id),
    payment: null,
    alreadyIssued: true,
  });

  if (pnr.status === "TICKETED") return existingResult(pnr);
  if (pnr.status === "EXPIRED") throw AppError.conflict("The seat hold has expired; please create a new booking");
  if (pnr.status === "CANCELLED") throw AppError.conflict("PNR is cancelled");

  const staleBefore = new Date(now.getTime() - TICKETING_STALE_MS);
  const resume = pnr.status === "CONFIRMED";
  if (resume && pnr.updatedAt > staleBefore) {
    throw AppError.conflict("Ticket issuance is already in progress for this PNR; retry shortly");
  }

  const receipt = await settlePayment(user, pnr, input.payment);

  const claimed = await PNR.findOneAndUpdate(
    {
      _id: pnr._id,
      $or: [
        { status: "HELD", holdExpiresAt: { $gt: now } },
        { status: "CONFIRMED", updatedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: { status: "CONFIRMED" },
      $push: { history: pnrHistory(user.id, "TICKETING_STARTED", { payment: receipt }) },
    },
    { returnDocument: "after" },
  ).lean();

  if (!claimed) {
    // Lost the race (double click / concurrent request) or the hold lapsed meanwhile.
    const current = await loadPnr(locator);
    if (current.status === "TICKETED") return existingResult(current);
    if (current.status === "CONFIRMED") {
      throw AppError.conflict("Ticket issuance is already in progress for this PNR; retry shortly");
    }
    throw AppError.conflict(`PNR is ${current.status}; tickets cannot be issued`);
  }

  const confirmed: ConfirmedHold[] = await confirmHold(claimed.recordLocator);
  if (!resume && confirmed.length < claimed.segments.length) {
    // The hold lapsed (and was possibly swept) before we could convert it: undo and expire the booking.
    for (const c of confirmed) {
      await releaseSoldSeats(c.flightId, c.cabin, c.bucketClass, c.seats, "system");
    }
    await releaseHold(claimed.recordLocator);
    await PNR.updateOne(
      { _id: claimed._id, status: "CONFIRMED" },
      {
        $set: { status: "EXPIRED" },
        $unset: { holdExpiresAt: "" },
        $push: { history: pnrHistory("system", "TICKETING_FAILED", { reason: "Seat hold lapsed before ticketing" }) },
      },
    );
    throw AppError.conflict("The seat hold lapsed before ticketing; the booking was released");
  }

  const existing = await Ticket.find({ pnrId: claimed._id }).lean();
  const issued = new Set(existing.filter((t) => t.status !== "VOID").map((t) => `${t.passengerId}:${t.segmentIndex}`));
  for (const [segmentIndex, segment] of claimed.segments.entries()) {
    for (const pax of claimed.passengers) {
      if (issued.has(`${pax.id}:${segmentIndex}`)) continue;
      await createTicket({
        pnrId: claimed._id,
        pnrLocator: claimed.recordLocator,
        passengerId: pax.id,
        passengerName: `${pax.lastName}/${pax.firstName}`.toUpperCase(),
        segmentIndex,
        flightId: segment.flightId,
        bookingClass: segment.bookingClass,
        fareId: segment.fareId,
        fareAmount: pax.type === "INFANT" ? 0 : segment.fareAmount, // lap infants travel free in this system
        currency: claimed.currency,
        status: "ISSUED",
        issuedAt: new Date(),
        issuedBy: toObjectId(user.id, "user id"),
      });
    }
  }

  const ticketed = await PNR.findOneAndUpdate(
    { _id: claimed._id, status: "CONFIRMED" },
    {
      $set: { status: "TICKETED" },
      $unset: { holdExpiresAt: "" },
      $push: { history: pnrHistory(user.id, "TICKETED", { payment: receipt }) },
    },
    { returnDocument: "after" },
  ).lean();
  if (!ticketed) throw AppError.conflict("PNR changed while ticketing; refresh and retry");

  return { pnr: ticketed, tickets: await listTicketsForPnr(ticketed._id), payment: receipt, alreadyIssued: false };
}

// ---- read -----------------------------------------------------------------

export async function listPnrTickets(locator: string, user: AuthUser): Promise<ITicket[]> {
  const pnr = await loadPnr(locator);
  assertOwnerOrStaff(user, pnr.ownerUserId);
  return listTicketsForPnr(pnr._id);
}

export async function getTicketForUser(ticketNumber: string, user: AuthUser) {
  const number = ticketNumber.trim();
  if (!/^\d{13}$/.test(number)) throw AppError.badRequest("Ticket number must be 13 digits");
  const ticket = await Ticket.findOne({ ticketNumber: number }).lean();
  if (!ticket) throw AppError.notFound("Ticket not found");
  const pnr = await PNR.findById(ticket.pnrId).lean();
  if (!pnr) throw AppError.notFound("PNR not found for ticket");
  assertOwnerOrStaff(user, pnr.ownerUserId);
  return { ticket, pnr };
}

// ---- void -----------------------------------------------------------------

/**
 * Atomically ISSUED -> VOID and give the passenger's seat back (infants hold no seat). Returns false when the
 * ticket was not ISSUED (already void/used/refunded), so concurrent voids release a seat exactly once.
 */
export async function voidTicketRecord(ticket: ITicket, pnr: IPNR, actor: string): Promise<boolean> {
  const voided = await Ticket.findOneAndUpdate(
    { _id: ticket._id, status: "ISSUED" },
    { $set: { status: "VOID", voidedAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  if (!voided) return false;

  const passenger = pnr.passengers.find((p) => p.id === ticket.passengerId);
  const segment = pnr.segments[ticket.segmentIndex];
  if (passenger && segment && passenger.type !== "INFANT") {
    await releaseSoldSeats(ticket.flightId, segment.cabin, segment.bookingClass, 1, actor);
  }
  return true;
}

/** Void every ISSUED ticket of a PNR (used by cancellation). Returns the number voided. */
export async function voidAllTickets(pnr: IPNR, actor: string): Promise<number> {
  const tickets = await Ticket.find({ pnrId: pnr._id, status: "ISSUED" }).lean();
  let count = 0;
  for (const ticket of tickets) {
    if (await voidTicketRecord(ticket, pnr, actor)) count += 1;
  }
  return count;
}

/**
 * Staff voids one ticket: its seat is released. When no non-void ticket remains on the PNR, the PNR becomes
 * CANCELLED (its seats are all gone, so it cannot go back to CONFIRMED); otherwise it stays TICKETED.
 */
export async function voidTicket(ticketNumber: string, user: AuthUser, reason?: string) {
  const number = ticketNumber.trim();
  if (!/^\d{13}$/.test(number)) throw AppError.badRequest("Ticket number must be 13 digits");
  const ticket = await Ticket.findOne({ ticketNumber: number }).lean();
  if (!ticket) throw AppError.notFound("Ticket not found");
  const pnr = await PNR.findById(ticket.pnrId).lean();
  if (!pnr) throw AppError.notFound("PNR not found for ticket");

  if (!(await voidTicketRecord(ticket, pnr, user.id))) {
    const current = await Ticket.findById(ticket._id).lean();
    throw AppError.conflict(`Ticket is ${current?.status ?? "not issued"} and cannot be voided`);
  }
  await PNR.updateOne(
    { _id: pnr._id },
    { $push: { history: pnrHistory(user.id, "TICKET_VOIDED", { ticketNumber: number, reason }) } },
  );
  const remaining = await Ticket.countDocuments({ pnrId: pnr._id, status: { $ne: "VOID" } });
  if (remaining === 0) {
    await PNR.updateOne(
      { _id: pnr._id, status: "TICKETED" },
      {
        $set: { status: "CANCELLED" },
        $push: { history: pnrHistory(user.id, "CANCELLED", { reason: "All tickets voided" }) },
      },
    );
  }
  const [updatedTicket, updatedPnr] = await Promise.all([Ticket.findById(ticket._id).lean(), PNR.findById(pnr._id).lean()]);
  return { ticket: updatedTicket!, pnr: updatedPnr! };
}
