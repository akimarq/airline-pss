import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getInventory, POST as postInventory } from "@/app/api/inventory/[flightId]/route";
import { PATCH as patchBucket } from "@/app/api/inventory/[flightId]/buckets/[class]/route";
import { POST as repriceRoute } from "@/app/api/inventory/[flightId]/reprice/route";
import { PUT as putRules } from "@/app/api/inventory/[flightId]/rules/route";
import { Flight, Inventory, PNR } from "@/models";
import {
  applyRevenueRules,
  confirmHold,
  expireHolds,
  getAvailability,
  holdSeats,
  releaseHold,
  releaseSoldSeats,
  setBucket,
} from "@/modules/inventory/service";
import { clearTestDB, startTestDB, stopTestDB } from "./helpers/db";
import { DAY, call, makeFlight, makeUser, yConfig, type TestUser } from "./helpers/booking";

let staff: TestUser;
let passenger: TestUser;

beforeAll(startTestDB);
afterAll(stopTestDB);
beforeEach(async () => {
  await clearTestDB();
  staff = await makeUser("staff", "staff@airline.test");
  passenger = await makeUser("passenger", "pax@airline.test");
});

const bucket = async (flightId: string, cls: string) => {
  const view = await getAvailability(flightId);
  return view.cabins.flatMap((c) => c.buckets).find((b) => b.class === cls)!;
};

describe("atomic seat holds", () => {
  it("never oversells: 20 parallel holds against 5 seats yields exactly 5 successes", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 5 }]) });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => holdSeats(flightId, "Y", "Y", 1, `LOC${String(i).padStart(3, "0")}`)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(15);
    expect(failed.every((f) => f.reason.status === 409)).toBe(true);

    const b = await bucket(flightId, "Y");
    expect(b).toMatchObject({ held: 5, sold: 0, available: 0 });
    expect((await Inventory.findOne({ flightId }))!.holds).toHaveLength(5);
  });

  it("respects multi-seat requests under concurrency (10 x 2 seats vs 5 -> 2 successes)", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 5 }]) });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => holdSeats(flightId, "Y", "Y", 2, `MUL${String(i).padStart(3, "0")}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await bucket(flightId, "Y")).held).toBe(4);
  });

  it("moves seats held -> sold on confirm, and releases sold seats (never below zero)", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 5 }]) });
    await holdSeats(flightId, "Y", "Y", 3, "ABC123");
    expect(await bucket(flightId, "Y")).toMatchObject({ held: 3, sold: 0, available: 2 });

    const confirmed = await confirmHold("ABC123");
    expect(confirmed).toEqual([{ flightId, cabin: "Y", bucketClass: "Y", seats: 3 }]);
    expect(await bucket(flightId, "Y")).toMatchObject({ held: 0, sold: 3, available: 2 });
    expect(await confirmHold("ABC123")).toEqual([]); // idempotent

    await releaseSoldSeats(flightId, "Y", "Y", 2, "system");
    expect(await bucket(flightId, "Y")).toMatchObject({ sold: 1, available: 4 });
    await expect(releaseSoldSeats(flightId, "Y", "Y", 2, "system")).rejects.toMatchObject({ status: 409 });
    expect((await bucket(flightId, "Y")).sold).toBe(1);

    await holdSeats(flightId, "Y", "Y", 2, "DEF456");
    expect(await releaseHold("DEF456")).toBe(2);
    expect(await bucket(flightId, "Y")).toMatchObject({ held: 0, sold: 1 });
  });

  it("rejects holds on closed buckets and unknown classes", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y" }, { class: "Q" }]) });
    await setBucket(flightId, "Q", { open: false });
    await expect(holdSeats(flightId, "Y", "Q", 1, "CLS001")).rejects.toMatchObject({ status: 409 });
    await expect(holdSeats(flightId, "Y", "Z", 1, "CLS002")).rejects.toMatchObject({ status: 400 });
  });
});

describe("hold expiry sweep", () => {
  it("returns expired holds to the bucket and expires the owning HELD PNR", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 4 }]) });
    await holdSeats(flightId, "Y", "Y", 2, "EXP001", 15);
    await holdSeats(flightId, "Y", "Y", 1, "EXP002", 60);
    const owner = await makeUser("passenger", "owner@airline.test");
    await PNR.create({
      recordLocator: "EXP001",
      ownerUserId: owner.id,
      passengers: [{ firstName: "A", lastName: "B", type: "ADULT" }],
      segments: [{ flightId, bookingClass: "Y", cabin: "Y", fareId: flightId, fareAmount: 10 }],
      contact: { email: "o@x.com" },
      status: "HELD",
      holdExpiresAt: new Date(Date.now() + 15 * 60_000),
      totalAmount: 10,
    });

    // Nothing expires yet.
    expect((await expireHolds(new Date())).expiredHolds).toBe(0);

    const swept = await expireHolds(new Date(Date.now() + 20 * 60_000));
    expect(swept).toMatchObject({ expiredHolds: 1, seatsReleased: 2, locators: ["EXP001"] });
    expect(await bucket(flightId, "Y")).toMatchObject({ held: 1, available: 3 });
    expect((await PNR.findOne({ recordLocator: "EXP001" }))!.status).toBe("EXPIRED");
    // Idempotent
    expect((await expireHolds(new Date(Date.now() + 20 * 60_000))).expiredHolds).toBe(0);
  });

  it("is applied lazily before a hold, so expired seats are sellable again", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 1 }]) });
    await holdSeats(flightId, "Y", "Y", 1, "LAZ001", 0.005); // 300ms
    await expect(holdSeats(flightId, "Y", "Y", 1, "LAZ002")).rejects.toMatchObject({ status: 409 });
    await new Promise((r) => setTimeout(r, 450));
    await expect(holdSeats(flightId, "Y", "Y", 1, "LAZ002")).resolves.toMatchObject({ seats: 1 });
  });
});

describe("bucket authorization and open/close (routes)", () => {
  it("lets staff only change buckets, validates authorization, and records history", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y", authorized: 6 }, { class: "Q", authorized: 4 }]) });
    const path = `/api/inventory/${flightId}/buckets/Q`;
    const params = { flightId, class: "Q" };

    expect((await call(patchBucket, "PATCH", path, { body: { open: false }, params })).status).toBe(401);
    expect((await call(patchBucket, "PATCH", path, { token: passenger.token, body: { open: false }, params })).status).toBe(403);
    expect((await call(patchBucket, "PATCH", path, { token: staff.token, body: {}, params })).status).toBe(400);

    const closed = await call(patchBucket, "PATCH", path, { token: staff.token, body: { open: false }, params });
    expect(closed.status).toBe(200);
    expect(closed.json.bucket).toMatchObject({ class: "Q", open: false, source: "manual" });

    const resized = await call(patchBucket, "PATCH", path, { token: staff.token, body: { authorized: 2 }, params });
    expect(resized.json.bucket).toMatchObject({ authorized: 2, available: 2 });

    // Cannot exceed cabin capacity or go below sold + held.
    expect((await call(patchBucket, "PATCH", path, { token: staff.token, body: { authorized: 11 }, params })).status).toBe(400);
    await setBucket(flightId, "Q", { open: true });
    await holdSeats(flightId, "Y", "Q", 2, "BKT001");
    const tooLow = await call(patchBucket, "PATCH", path, { token: staff.token, body: { authorized: 1 }, params });
    expect(tooLow.status).toBe(409);
    expect((await bucket(flightId, "Q")).authorized).toBe(2);

    expect((await call(patchBucket, "PATCH", `/api/inventory/${flightId}/buckets/X`, { token: staff.token, body: { open: false }, params: { flightId, class: "X" } })).status).toBe(404);

    const inv = await Inventory.findOne({ flightId });
    const actions = inv!.history.map((h) => h.action);
    expect(actions.filter((a) => a === "BUCKET_OVERRIDE")).toHaveLength(3);
    expect(inv!.history.find((h) => h.action === "BUCKET_OVERRIDE")!.actor).toBe(staff.id);
  });

  it("shows staff the full inventory and passengers only open availability", async () => {
    const { flightId } = await makeFlight({
      inventory: yConfig(10, [{ class: "Y", authorized: 6 }, { class: "Q", authorized: 4 }], {
        loadFactorRules: [{ thresholdPct: 90, closeClasses: ["Q"] }],
      }),
    });
    await setBucket(flightId, "Q", { open: false });
    const params = { flightId };

    const asStaff = await call(getInventory, "GET", `/api/inventory/${flightId}`, { token: staff.token, params });
    expect(asStaff.status).toBe(200);
    expect(asStaff.json.inventory.loadFactorRules).toHaveLength(1);
    expect(asStaff.json.inventory.cabins[0].buckets.find((b: { class: string }) => b.class === "Q")).toMatchObject({ open: false, authorized: 4 });

    const asPax = await call(getInventory, "GET", `/api/inventory/${flightId}`, { token: passenger.token, params });
    expect(asPax.status).toBe(200);
    expect(asPax.json.inventory).toBeUndefined();
    expect(asPax.json.availability.cabins).toEqual([{ cabin: "Y", buckets: [{ class: "Y", available: 6 }] }]);
    expect(JSON.stringify(asPax.json)).not.toMatch(/loadFactorRules|history|holds|authorized/);

    expect((await call(getInventory, "GET", `/api/inventory/${flightId}`, { params })).status).toBe(401);
  });

  it("creates inventory for a flight (staff only) with aircraft-derived defaults", async () => {
    const { flightId } = await makeFlight({ inventory: false });
    const params = { flightId };
    expect((await call(postInventory, "POST", `/api/inventory/${flightId}`, { token: passenger.token, params })).status).toBe(403);
    const created = await call(postInventory, "POST", `/api/inventory/${flightId}`, { token: staff.token, params });
    expect(created.status).toBe(201);
    const cabins = created.json.inventory.cabins;
    expect(cabins.map((c: { cabin: string; capacity: number }) => [c.cabin, c.capacity]).sort()).toEqual([["J", 4], ["Y", 16]]);
    expect(cabins.find((c: { cabin: string }) => c.cabin === "Y").buckets.map((b: { class: string }) => b.class)).toEqual(["Y", "B", "M", "K", "Q"]);
    expect(cabins.find((c: { cabin: string }) => c.cabin === "J").buckets.map((b: { class: string }) => b.class)).toEqual(["J", "C", "D"]);
    expect((await call(postInventory, "POST", `/api/inventory/${flightId}`, { token: staff.token, params })).status).toBe(409);
  });
});

describe("revenue rules", () => {
  // Reads raw state (no engine run) so assertions see exactly what the engine last wrote.
  const closedSources = async (flightId: string) => {
    const inv = await Inventory.findOne({ flightId }).lean();
    return Object.fromEntries(
      inv!.cabins.flatMap((c) => c.buckets).map((b) => [b.class, `${b.open ? "open" : "closed"}:${b.source ?? null}`]),
    );
  };
  it("closes classes at the load-factor threshold and reopens them when it drops", async () => {
    const { flightId } = await makeFlight({
      inventory: yConfig(10, [{ class: "Y" }, { class: "K" }, { class: "Q" }], {
        loadFactorRules: [{ thresholdPct: 50, closeClasses: ["K", "Q"] }],
      }),
    });
    await holdSeats(flightId, "Y", "Y", 4, "LFR001");
    expect((await closedSources(flightId)).Q).toBe("open:null");

    await holdSeats(flightId, "Y", "Y", 1, "LFR002"); // 5/10 = 50% => reached
    const closed = await closedSources(flightId);
    expect(closed).toMatchObject({ Y: "open:null", K: "closed:rule", Q: "closed:rule" });
    await expect(holdSeats(flightId, "Y", "Q", 1, "LFR003")).rejects.toMatchObject({ status: 409 });

    await releaseHold("LFR002"); // back to 40%
    expect(await closedSources(flightId)).toMatchObject({ K: "open:rule", Q: "open:rule" });

    const history = (await Inventory.findOne({ flightId }))!.history.map((h) => h.action);
    expect(history.filter((a) => a === "RULE_CLOSE")).toHaveLength(2);
    expect(history.filter((a) => a === "RULE_OPEN")).toHaveLength(2);
  });

  it("never overrides a manual close, and manual open beats a rule close until handed back", async () => {
    const { flightId } = await makeFlight({
      inventory: yConfig(10, [{ class: "Y" }, { class: "K" }, { class: "Q" }], {
        loadFactorRules: [{ thresholdPct: 50, closeClasses: ["K", "Q"] }],
      }),
    });
    await setBucket(flightId, "Q", { open: false }, staff.id); // manual close
    await holdSeats(flightId, "Y", "Y", 5, "MAN001"); // rule closes K, leaves manual Q alone
    expect(await closedSources(flightId)).toMatchObject({ K: "closed:rule", Q: "closed:manual" });

    await releaseHold("MAN001"); // load drops: K reopens, Q must stay closed
    await applyRevenueRules(flightId);
    expect(await closedSources(flightId)).toMatchObject({ K: "open:rule", Q: "closed:manual" });

    // Manual open survives the rule even above the threshold.
    await holdSeats(flightId, "Y", "Y", 5, "MAN002");
    expect((await closedSources(flightId)).K).toBe("closed:rule");
    await setBucket(flightId, "K", { open: true }, staff.id);
    await applyRevenueRules(flightId);
    expect((await closedSources(flightId)).K).toBe("open:manual");

    // Handing it back lets the rule close it again.
    await setBucket(flightId, "K", { releaseToRules: true }, staff.id);
    expect((await closedSources(flightId)).K).toBe("closed:rule");
  });

  it("closes discount classes within N days of departure and reopens when departure moves out", async () => {
    const { flightId } = await makeFlight({
      daysAhead: 10,
      inventory: yConfig(10, [{ class: "Y" }, { class: "Q" }], {
        timeToDepartureRules: [{ daysBeforeDeparture: 7, closeClasses: ["Q"] }],
      }),
    });
    expect((await closedSources(flightId)).Q).toBe("open:null");

    const within = await applyRevenueRules(flightId, new Date(Date.now() + 5 * DAY));
    expect(within.changes).toEqual([expect.objectContaining({ class: "Q", action: "CLOSED" })]);
    expect((await closedSources(flightId)).Q).toBe("closed:rule");

    // Idempotent
    expect((await applyRevenueRules(flightId, new Date(Date.now() + 5 * DAY))).changes).toEqual([]);

    // Flight rescheduled further out: rule no longer applies.
    await Flight.updateOne({ _id: flightId }, { departure: new Date(Date.now() + 30 * DAY) });
    await applyRevenueRules(flightId);
    expect((await closedSources(flightId)).Q).toBe("open:rule");
  });

  it("is enforced on sale: a flight inside the window rejects the discount class without a manual reprice", async () => {
    const { flightId } = await makeFlight({
      daysAhead: 3,
      inventory: yConfig(10, [{ class: "Y" }, { class: "Q" }], { timeToDepartureRules: [{ daysBeforeDeparture: 7, closeClasses: ["Q"] }] }),
    });
    // createInventoryForFlight already applied the rules.
    await expect(holdSeats(flightId, "Y", "Q", 1, "TTD001")).rejects.toMatchObject({ status: 409 });
    await expect(holdSeats(flightId, "Y", "Y", 1, "TTD002")).resolves.toBeTruthy();
  });

  it("is manageable through the staff routes (PUT rules, POST reprice)", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y" }, { class: "Q" }]) });
    const params = { flightId };
    const body = { loadFactorRules: [{ thresholdPct: 20, closeClasses: ["q"] }], timeToDepartureRules: [] };

    expect((await call(putRules, "PUT", `/api/inventory/${flightId}/rules`, { token: passenger.token, body, params })).status).toBe(403);
    expect((await call(putRules, "PUT", `/api/inventory/${flightId}/rules`, { token: staff.token, body: { loadFactorRules: [{ thresholdPct: 120, closeClasses: ["Q"] }] }, params })).status).toBe(400);
    expect((await call(putRules, "PUT", `/api/inventory/${flightId}/rules`, { token: staff.token, body: { loadFactorRules: [{ thresholdPct: 20, closeClasses: ["Z"] }] }, params })).status).toBe(400);

    const set = await call(putRules, "PUT", `/api/inventory/${flightId}/rules`, { token: staff.token, body, params });
    expect(set.status).toBe(200);
    expect(set.json.inventory.loadFactorRules).toEqual([{ thresholdPct: 20, closeClasses: ["Q"] }]);

    // Bypass the engine to simulate a missed run, then reprice via the route.
    await Inventory.updateOne({ flightId }, { $set: { "cabins.0.buckets.0.sold": 5 } });
    expect((await call(repriceRoute, "POST", `/api/inventory/${flightId}/reprice`, { token: passenger.token, params })).status).toBe(403);
    const repriced = await call(repriceRoute, "POST", `/api/inventory/${flightId}/reprice`, { token: staff.token, params });
    expect(repriced.status).toBe(200);
    expect(repriced.json.changes).toEqual([expect.objectContaining({ class: "Q", action: "CLOSED" })]);
  });
});
