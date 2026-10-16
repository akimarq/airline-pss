import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/cron/sweep/route";
import { Flight, Inventory, PNR } from "@/models";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { startDcsDB } from "./helpers/dcs";
import { book, createFlightViaApi, makePassenger, makeStaff, type Actor, type FlightFixture } from "./helpers/e2e";

const SECRET = "test-cron-secret-0123456789";
const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeAll(startDcsDB);
afterAll(stopTestDB);

let staff: Actor;
let alice: Actor;
let fx: FlightFixture;

beforeEach(async () => {
  process.env.CRON_SECRET = SECRET;
  await clearTestDB();
  staff = await makeStaff();
  alice = await makePassenger("alice@e2e.test", "Alice");
  fx = await createFlightViaApi(staff, { hoursAhead: 10 });
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

/** The sweep route is not a user route: it is called with `Authorization: Bearer <CRON_SECRET>` only. */
async function sweep(authorization?: string) {
  const req = new NextRequest("http://localhost/api/cron/sweep", {
    method: "GET",
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  });
  const res = await GET(req);
  return { status: res.status, json: await res.json() };
}

describe("GET /api/cron/sweep", () => {
  it("returns 401 in the standard error shape without an Authorization header", async () => {
    const res = await sweep();
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("UNAUTHORIZED");
    expect(res.json.error.message).toBeTruthy();
  });

  it("returns 401 for a wrong secret (same length, different length, wrong scheme, bare secret)", async () => {
    for (const header of [`Bearer ${"x".repeat(SECRET.length)}`, "Bearer nope", `Basic ${SECRET}`, SECRET, "Bearer "]) {
      const res = await sweep(header);
      expect(res.status, header).toBe(401);
      expect(res.json.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("returns 401 when CRON_SECRET is unset or empty, even for a matching-looking header", async () => {
    delete process.env.CRON_SECRET;
    expect((await sweep("Bearer undefined")).status).toBe(401);
    expect((await sweep("Bearer ")).status).toBe(401);
    expect((await sweep()).status).toBe(401);

    process.env.CRON_SECRET = "";
    expect((await sweep("Bearer ")).status).toBe(401);
    expect((await sweep("Bearer")).status).toBe(401);
  });

  it("does not accept a user JWT instead of the cron secret", async () => {
    expect((await sweep(`Bearer ${staff.token}`)).status).toBe(401);
  });

  it("returns 200 with the summary for the right secret", async () => {
    const before = Date.now();
    const res = await sweep(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      expiredHolds: 0,
      seatsReleased: 0,
      pnrsExpired: 0,
      flightsRepriced: 1, // the flight created in beforeEach departs in 10 hours
      repriceErrors: 0,
    });
    expect(new Date(res.json.ranAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("sweeps an expired hold and its PNR, and leaves a live hold alone", async () => {
    const expired = await book(alice, fx.flightId, "M");
    const live = await book(alice, fx.flightId, "Q");
    expect(expired.status).toBe(201);
    expect(live.status).toBe(201);
    const expiredLocator: string = expired.json.pnr.recordLocator;
    const liveLocator: string = live.json.pnr.recordLocator;

    // Lapse only the first hold, in both the PNR and the inventory.
    const past = new Date(Date.now() - 1000);
    await PNR.updateOne({ recordLocator: expiredLocator }, { $set: { holdExpiresAt: past } });
    await Inventory.updateOne(
      { flightId: fx.flightId },
      { $set: { "holds.$[h].expiresAt": past } },
      { arrayFilters: [{ "h.pnrLocator": expiredLocator }] },
    );

    const res = await sweep(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, expiredHolds: 1, seatsReleased: 1, pnrsExpired: 1, flightsRepriced: 1, repriceErrors: 0 });

    expect((await PNR.findOne({ recordLocator: expiredLocator }))!.status).toBe("EXPIRED");
    expect((await PNR.findOne({ recordLocator: liveLocator }))!.status).toBe("HELD");
    const inv = await Inventory.findOne({ flightId: fx.flightId }).lean();
    expect(inv!.holds.map((h) => h.pnrLocator)).toEqual([liveLocator]);

    // Idempotent: a second run finds nothing left to expire.
    const again = await sweep(`Bearer ${SECRET}`);
    expect(again.json).toMatchObject({ expiredHolds: 0, seatsReleased: 0, pnrsExpired: 0 });
  });

  it("expires a lapsed PNR whose inventory hold is already gone", async () => {
    const created = await book(alice, fx.flightId, "M");
    const locator: string = created.json.pnr.recordLocator;
    await PNR.updateOne({ recordLocator: locator }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });

    const res = await sweep(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.json.pnrsExpired).toBeGreaterThanOrEqual(1);
    expect((await PNR.findOne({ recordLocator: locator }))!.status).toBe("EXPIRED");
  });

  it("reprices only non-cancelled flights departing within 14 days", async () => {
    const far = await createFlightViaApi(staff, { hoursAhead: 24 * 20 });
    const cancelled = await createFlightViaApi(staff, { hoursAhead: 24 * 3 });
    const past = await createFlightViaApi(staff, { hoursAhead: 5 });
    await Flight.updateOne({ _id: cancelled.flightId }, { $set: { status: "CANCELLED" } });
    await Flight.updateOne({ _id: past.flightId }, { $set: { departure: new Date(Date.now() - 3_600_000) } });

    const res = await sweep(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(far.flightId).toBeTruthy();
    expect(res.json.flightsRepriced).toBe(1); // only the 10-hour flight from beforeEach
  });

  it("counts a failing reprice and keeps going", async () => {
    const broken = await createFlightViaApi(staff, { hoursAhead: 48 });
    await Inventory.deleteOne({ flightId: broken.flightId }); // reprice -> 404 for this flight

    const res = await sweep(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, flightsRepriced: 1, repriceErrors: 1 });
  });
});
