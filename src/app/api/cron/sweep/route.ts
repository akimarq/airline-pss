import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import { AppError, handleError } from "@/lib/errors";
import { Flight } from "@/models";
import { expireHolds, reprice } from "@/modules/inventory/service";
import { expirePnrs } from "@/modules/reservations/pnrs.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Flights departing within this many days are repriced by the sweep. */
const REPRICE_HORIZON_DAYS = 14;

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>`. Always false when CRON_SECRET is unset or empty. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  // timingSafeEqual needs equal lengths; a length mismatch is rejected up front (it leaks only the length).
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Scheduled sweep (Vercel Cron, daily): releases expired seat holds, expires lapsed PNRs and re-runs the revenue
 * rules for flights departing in the next 14 days. Not a user route: it is guarded by `CRON_SECRET`, not `withAuth`.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorized(req)) throw AppError.unauthorized("Invalid or missing cron secret");

    await connectDB();
    const now = new Date();

    const holds = await expireHolds(now);
    // expireHolds already flips the PNRs that owned the lapsed holds to EXPIRED (holds.locators); expirePnrs then
    // catches lapsed HELD PNRs whose inventory hold was already gone. The two sets are disjoint.
    const pnrsExpired = holds.locators.length + (await expirePnrs(now));

    const horizon = new Date(now.getTime() + REPRICE_HORIZON_DAYS * 86_400_000);
    const flights = await Flight.find({ status: { $ne: "CANCELLED" }, departure: { $gte: now, $lte: horizon } })
      .select("_id")
      .lean();

    let flightsRepriced = 0;
    let repriceErrors = 0;
    for (const flight of flights) {
      try {
        await reprice(flight._id, now);
        flightsRepriced += 1;
      } catch (err) {
        repriceErrors += 1;
        console.error("Cron sweep: reprice failed for flight", String(flight._id), err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      ok: true,
      expiredHolds: holds.expiredHolds,
      seatsReleased: holds.seatsReleased,
      pnrsExpired,
      flightsRepriced,
      repriceErrors,
      ranAt: now.toISOString(),
    });
  } catch (err) {
    return handleError(err);
  }
}
