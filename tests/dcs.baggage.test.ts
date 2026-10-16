import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkInRoute } from "@/app/api/checkin/route";
import { GET as listBags, POST as createBag } from "@/app/api/baggage/route";
import { GET as getBag, PATCH as patchBag } from "@/app/api/baggage/[tag]/route";
import { Baggage, Fare } from "@/models";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { api, makeBooking, makeFlight, makeUsers, startDcsDB, type TestUser } from "./helpers/dcs";

let users: { passenger: TestUser; other: TestUser; staff: TestUser };

beforeAll(startDcsDB);
afterAll(stopTestDB);
beforeEach(async () => {
  await clearTestDB();
  users = await makeUsers();
});

async function checkedIn(opts: { baggageKg?: number; owner?: TestUser } = {}) {
  const owner = opts.owner ?? users.passenger;
  const flight = await makeFlight();
  const booking = await makeBooking({ ownerId: owner.id, flightId: flight._id, baggageKg: opts.baggageKg });
  const ci = await api(checkInRoute, "POST", "/api/checkin", {
    token: owner.token,
    body: { pnrLocator: booking.locator, segmentIndex: 0, channel: "ONLINE" },
  });
  expect(ci.status).toBe(201);
  return { flight, ...booking, checkInId: ci.body.checkIn._id as string };
}

const addBag = (token: string, body: Record<string, unknown>) => api(createBag, "POST", "/api/baggage", { token, body });
const setStatus = (token: string | undefined, tag: string, status: string) =>
  api(patchBag, "PATCH", "/x", { token, body: { status }, params: { tag } });

describe("bag acceptance", () => {
  it("is staff only", async () => {
    const { locator } = await checkedIn();
    expect((await addBag(users.passenger.token, { pnrLocator: locator, weightKg: 10 })).status).toBe(403);
    expect((await api(createBag, "POST", "/x", { body: { pnrLocator: locator, weightKg: 10 } })).status).toBe(401);
  });

  it("requires the passenger to be checked in", async () => {
    const flight = await makeFlight();
    const b = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    const res = await addBag(users.staff.token, { pnrLocator: b.locator, weightKg: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_CHECKED_IN");
  });

  it("creates a tag with the airline prefix + 10 digits and CHECKED history", async () => {
    const { locator, checkInId } = await checkedIn();
    const byPnr = await addBag(users.staff.token, { pnrLocator: locator, weightKg: 12.5 });
    const byCheckIn = await addBag(users.staff.token, { checkInId, weightKg: 5 });
    expect(byPnr.status).toBe(201);
    expect(byCheckIn.status).toBe(201);
    expect(byPnr.body.baggage.tagNumber).toMatch(/^PS\d{10}$/);
    expect(byPnr.body.baggage.tagNumber).not.toBe(byCheckIn.body.baggage.tagNumber);
    expect(byPnr.body.baggage).toMatchObject({ status: "CHECKED", excess: false, allowanceKg: 20 });
    expect(byPnr.body.baggage.history).toHaveLength(1);
  });

  it("enforces the fare allowance, with an explicit excess flag", async () => {
    const { locator } = await checkedIn({ baggageKg: 20 });
    expect((await addBag(users.staff.token, { pnrLocator: locator, weightKg: 18 })).status).toBe(201);

    const over = await addBag(users.staff.token, { pnrLocator: locator, weightKg: 5 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("BAGGAGE_OVER_ALLOWANCE");
    expect(over.body.error.details).toMatchObject({ allowanceKg: 20, alreadyCheckedKg: 18, excessKg: 3 });

    const accepted = await addBag(users.staff.token, { pnrLocator: locator, weightKg: 5, acceptExcess: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.baggage).toMatchObject({ excess: true, excessKg: 3 });
  });

  it("falls back to 23kg when the fare cannot be resolved", async () => {
    const { locator, fare } = await checkedIn({ baggageKg: 5 });
    await Fare.deleteOne({ _id: fare._id });
    expect((await addBag(users.staff.token, { pnrLocator: locator, weightKg: 23 })).status).toBe(201);
    expect((await addBag(users.staff.token, { pnrLocator: locator, weightKg: 1 })).status).toBe(409);
  });

  it("validates the weight", async () => {
    const { locator } = await checkedIn();
    expect((await addBag(users.staff.token, { pnrLocator: locator, weightKg: 0 })).status).toBe(400);
    expect((await addBag(users.staff.token, { pnrLocator: locator, weightKg: 80 })).status).toBe(400);
  });
});

describe("status transitions", () => {
  async function bag() {
    const c = await checkedIn();
    const res = await addBag(users.staff.token, { pnrLocator: c.locator, weightKg: 10 });
    return { ...c, tag: res.body.baggage.tagNumber as string };
  }

  it("CHECKED -> SCREENED -> LOADED appends history", async () => {
    const { tag } = await bag();
    expect((await setStatus(users.staff.token, tag, "LOADED")).status).toBe(409); // cannot skip SCREENED
    expect((await setStatus(users.staff.token, tag, "SCREENED")).body.baggage.status).toBe("SCREENED");
    const loaded = await setStatus(users.staff.token, tag, "LOADED");
    expect(loaded.body.baggage.status).toBe("LOADED");
    expect(loaded.body.baggage.history.map((h: { status: string }) => h.status)).toEqual(["CHECKED", "SCREENED", "LOADED"]);
  });

  it("OFFLOADED from an earlier state is final", async () => {
    const { tag } = await bag();
    await setStatus(users.staff.token, tag, "SCREENED");
    expect((await setStatus(users.staff.token, tag, "OFFLOADED")).status).toBe(200);
    for (const s of ["SCREENED", "LOADED", "OFFLOADED"]) {
      const res = await setStatus(users.staff.token, tag, s);
      expect(res.status).toBe(409);
    }
  });

  it("rejects going backwards or repeating, and bad status values", async () => {
    const { tag } = await bag();
    await setStatus(users.staff.token, tag, "SCREENED");
    expect((await setStatus(users.staff.token, tag, "SCREENED")).status).toBe(409);
    expect((await setStatus(users.staff.token, tag, "CHECKED")).status).toBe(400); // not an allowed target value
  });

  it("is staff only; unknown tag is 404", async () => {
    const { tag } = await bag();
    expect((await setStatus(users.passenger.token, tag, "SCREENED")).status).toBe(403);
    expect((await setStatus(undefined, tag, "SCREENED")).status).toBe(401);
    expect((await setStatus(users.staff.token, "PS0000000000", "SCREENED")).status).toBe(404);
  });

  it("only one of two concurrent identical transitions wins", async () => {
    const { tag } = await bag();
    const [a, b] = await Promise.all([setStatus(users.staff.token, tag, "SCREENED"), setStatus(users.staff.token, tag, "SCREENED")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await Baggage.findOne({ tagNumber: tag }))!.history).toHaveLength(2);
  });
});

describe("baggage queries", () => {
  it("passengers see only their own PNR's bags; staff see everything", async () => {
    const mine = await checkedIn();
    const theirs = await checkedIn({ owner: users.other });
    await addBag(users.staff.token, { pnrLocator: mine.locator, weightKg: 10 });
    await addBag(users.staff.token, { pnrLocator: theirs.locator, weightKg: 11 });

    const own = await api(listBags, "GET", `/api/baggage?pnr=${mine.locator}`, { token: users.passenger.token });
    expect(own.status).toBe(200);
    expect(own.body.baggage).toHaveLength(1);
    expect((await api(listBags, "GET", `/api/baggage?pnr=${theirs.locator}`, { token: users.passenger.token })).status).toBe(403);
    expect((await api(listBags, "GET", "/api/baggage", { token: users.passenger.token })).status).toBe(400);

    // passenger + flightId only: automatically scoped to own PNRs
    const scoped = await api(listBags, "GET", `/api/baggage?flightId=${theirs.flight._id}`, { token: users.passenger.token });
    expect(scoped.body.baggage).toHaveLength(0);

    const staffFlight = await api(listBags, "GET", `/api/baggage?flightId=${theirs.flight._id}`, { token: users.staff.token });
    expect(staffFlight.body.baggage).toHaveLength(1);
    expect(staffFlight.body.total).toBe(1);
  });

  it("GET /api/baggage/[tag] is owner or staff", async () => {
    const c = await checkedIn();
    const tag = (await addBag(users.staff.token, { pnrLocator: c.locator, weightKg: 10 })).body.baggage.tagNumber;
    expect((await api(getBag, "GET", "/x", { token: users.passenger.token, params: { tag } })).status).toBe(200);
    expect((await api(getBag, "GET", "/x", { token: users.staff.token, params: { tag } })).status).toBe(200);
    expect((await api(getBag, "GET", "/x", { token: users.other.token, params: { tag } })).status).toBe(403);
    expect((await api(getBag, "GET", "/x", { token: users.staff.token, params: { tag: "PS1" } })).status).toBe(404);
  });
});
