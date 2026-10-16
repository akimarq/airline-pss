import { AppError } from "@/lib/errors";
import { PNR, type IPNR, type IPnrHistory, type IPnrPassenger } from "@/models";
import { expireHolds, releaseHold } from "@/modules/inventory/service";

export function normalizeLocator(locator: string): string {
  const l = locator?.trim().toUpperCase();
  if (!l || !/^[A-Z0-9]{6}$/.test(l)) throw AppError.badRequest("Record locator must be 6 letters/digits");
  return l;
}

export function pnrHistory(actor: string, action: string, details?: unknown): IPnrHistory {
  return { at: new Date(), actor, action, details };
}

/** Seats a passenger list occupies: infants travel on a lap and take no seat. */
export function seatCount(passengers: Pick<IPnrPassenger, "type">[]): number {
  return passengers.filter((p) => p.type !== "INFANT").length;
}

/**
 * If the PNR is HELD and its hold has lapsed, atomically flip it to EXPIRED and release any remaining seats.
 * Returns the (possibly updated) PNR.
 */
export async function expirePnrIfStale(pnr: IPNR, now: Date = new Date()): Promise<IPNR> {
  if (pnr.status !== "HELD" || !pnr.holdExpiresAt || pnr.holdExpiresAt > now) return pnr;
  const updated = await PNR.findOneAndUpdate(
    { _id: pnr._id, status: "HELD", holdExpiresAt: { $lte: now } },
    {
      $set: { status: "EXPIRED" },
      $unset: { holdExpiresAt: "" },
      $push: { history: pnrHistory("system", "EXPIRED", { reason: "Seat hold expired" }) },
    },
    { returnDocument: "after" },
  ).lean();
  if (updated) {
    await releaseHold(pnr.recordLocator); // no-op when the inventory sweep already released the seats
    return updated;
  }
  return (await PNR.findById(pnr._id).lean()) ?? pnr;
}

/** Load a PNR by locator (404 if absent), lazily expiring a lapsed hold. */
export async function loadPnr(locator: string, now: Date = new Date()): Promise<IPNR> {
  const pnr = await PNR.findOne({ recordLocator: normalizeLocator(locator) }).lean();
  if (!pnr) throw AppError.notFound("PNR not found");
  return expirePnrIfStale(pnr, now);
}

/**
 * Sweep: expire every HELD PNR whose hold has lapsed and release their seats (also sweeps the inventory
 * holds themselves). Returns the number of PNRs expired.
 */
export async function expirePnrs(now: Date = new Date()): Promise<number> {
  // Releases seats and expires the PNRs owning those holds.
  let expired = (await expireHolds(now)).locators.length;
  // Anything left (e.g. holds that were already gone): expire in batches.
  for (;;) {
    const stale = await PNR.find({ status: "HELD", holdExpiresAt: { $lte: now } })
      .limit(200)
      .lean();
    if (stale.length === 0) break;
    for (const pnr of stale) {
      const after = await expirePnrIfStale(pnr, now);
      if (after.status === "EXPIRED") expired += 1;
    }
    if (stale.length < 200) break;
  }
  return expired;
}
