import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkInRoute } from "@/app/api/checkin/route";
import { POST as createBag } from "@/app/api/baggage/route";
import { GET as getLoad, POST as saveLoad } from "@/app/api/flights/[id]/load/route";
import { POST as finalize } from "@/app/api/flights/[id]/load/finalize/route";
import { POST as reopen } from "@/app/api/flights/[id]/load/reopen/route";
import { Flight, LoadSheet } from "@/models";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { api, makeBooking, makeFlight, makeUsers, startDcsDB, type TestUser } from "./helpers/dcs";

let users: { passenger: TestUser; other: TestUser; staff: TestUser };

beforeAll(startDcsDB);
afterAll(stopTestDB);
beforeEach(async () => {
  await clearTestDB();
  users = await makeUsers();
});

/** 2 adults + 1 child + 1 infant checked in (infant on a second PNR), and two bags (20kg + 15kg). */
async function loadedFlight() {
  const flight = await makeFlight();
  const a = await makeBooking({
    ownerId: users.passenger.id,
    flightId: flight._id,
    passengers: [{ type: "ADULT" }, { type: "ADULT" }, { type: "CHILD" }, { type: "INFANT" }],
    baggageKg: 30,
  });
  for (const id of a.passengerIds) {
    const res = await api(checkInRoute, "POST", "/api/checkin", {
      token: users.staff.token,
      body: { pnrLocator: a.locator, passengerId: id, segmentIndex: 0, channel: "AIRPORT" },
    });
    expect(res.status).toBe(201);
  }
  await api(createBag, "POST", "/x", { token: users.staff.token, body: { pnrLocator: a.locator, passengerId: a.passengerIds[0], weightKg: 20 } });
  await api(createBag, "POST", "/x", { token: users.staff.token, body: { pnrLocator: a.locator, passengerId: a.passengerIds[1], weightKg: 15 } });
  return { flight, id: flight._id.toString() };
}

const get = (token: string | undefined, id: string) => api(getLoad, "GET", "/x", { token, params: { id } });
const save = (token: string, id: string, body: unknown) => api(saveLoad, "POST", "/x", { token, body, params: { id } });
const fin = (token: string, id: string) => api(finalize, "POST", "/x", { token, params: { id } });
const reop = (token: string, id: string) => api(reopen, "POST", "/x", { token, params: { id } });

describe("load control", () => {
  it("is staff only", async () => {
    const { id } = await loadedFlight();
    expect((await get(users.passenger.token, id)).status).toBe(403);
    expect((await get(undefined, id)).status).toBe(401);
    expect((await save(users.passenger.token, id, { cargoWeightKg: 0, fuelWeightKg: 0 })).status).toBe(403);
    expect((await fin(users.passenger.token, id)).status).toBe(403);
    expect((await reop(users.passenger.token, id)).status).toBe(403);
  });

  it("computes the live draft from check-ins, baggage and standard weights", async () => {
    const { id } = await loadedFlight();
    const res = await get(users.staff.token, id);
    expect(res.status).toBe(200);
    expect(res.body.loadSheetStatus).toBeNull();
    expect(res.body.load).toMatchObject({
      adults: 2,
      children: 1,
      infants: 1,
      passengerCount: 3,
      passengerWeightKg: 2 * 84 + 35,
      baggageCount: 2,
      baggageWeightKg: 35,
      cargoWeightKg: 0,
      zeroFuelWeightKg: 40_000 + 203 + 35,
      withinLimits: true,
    });
  });

  it("saves the DRAFT with cargo and fuel and updates it", async () => {
    const { id } = await loadedFlight();
    const first = await save(users.staff.token, id, { cargoWeightKg: 1000, fuelWeightKg: 10_000 });
    expect(first.status).toBe(200);
    expect(first.body.loadSheetStatus).toBe("DRAFT");
    expect(first.body.load).toMatchObject({ zeroFuelWeightKg: 41_238, takeoffWeightKg: 51_238 });
    expect(first.body.loadSheet).toMatchObject({ status: "DRAFT", cargoWeightKg: 1000, fuelWeightKg: 10_000, takeoffWeightKg: 51_238 });

    await save(users.staff.token, id, { cargoWeightKg: 500, fuelWeightKg: 9_000 });
    expect(await LoadSheet.countDocuments()).toBe(1);
    expect((await get(users.staff.token, id)).body.load.takeoffWeightKg).toBe(40_000 + 203 + 35 + 500 + 9_000);
    expect((await save(users.staff.token, id, { cargoWeightKg: -1, fuelWeightKg: 0 })).status).toBe(400);
  });

  it("finalizes within limits, records who/when, and cannot be repeated or edited until reopened", async () => {
    const { id } = await loadedFlight();
    await save(users.staff.token, id, { cargoWeightKg: 1000, fuelWeightKg: 10_000 });
    const done = await fin(users.staff.token, id);
    expect(done.status).toBe(200);
    expect(done.body.loadSheet).toMatchObject({ status: "FINAL", finalizedBy: users.staff.id });
    expect(done.body.loadSheet.finalizedAt).toBeTruthy();

    const again = await fin(users.staff.token, id);
    expect(again.status).toBe(409);
    expect((await save(users.staff.token, id, { cargoWeightKg: 0, fuelWeightKg: 0 })).status).toBe(409);

    const reopened = await reop(users.staff.token, id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.loadSheet.status).toBe("DRAFT");
    expect(reopened.body.loadSheet.finalizedAt).toBeUndefined();
    expect((await reop(users.staff.token, id)).status).toBe(409); // not FINAL anymore
    expect((await save(users.staff.token, id, { cargoWeightKg: 900, fuelWeightKg: 10_000 })).status).toBe(200);
    expect((await fin(users.staff.token, id)).status).toBe(200);
  });

  it("refuses to finalize without a draft", async () => {
    const { id } = await loadedFlight();
    expect((await fin(users.staff.token, id)).status).toBe(409);
  });

  it("refuses to finalize when aircraft limits are exceeded (409 LOAD_LIMITS_EXCEEDED)", async () => {
    const { id } = await loadedFlight();

    await save(users.staff.token, id, { cargoWeightKg: 3500, fuelWeightKg: 5000 }); // cargo above max 3000
    const cargo = await fin(users.staff.token, id);
    expect(cargo.status).toBe(409);
    expect(cargo.body.error.code).toBe("LOAD_LIMITS_EXCEEDED");
    expect(cargo.body.error.details.warnings.join(" ")).toMatch(/Cargo weight/);

    await save(users.staff.token, id, { cargoWeightKg: 0, fuelWeightKg: 40_000 }); // takeoff above 75,000
    const mtow = await fin(users.staff.token, id);
    expect(mtow.status).toBe(409);
    expect(mtow.body.error.details.warnings.join(" ")).toMatch(/Takeoff weight/);

    await save(users.staff.token, id, { cargoWeightKg: 3000, fuelWeightKg: 5000 });
    expect((await fin(users.staff.token, id)).status).toBe(200); // exactly at the cargo limit is fine
    expect((await LoadSheet.findOne())!.status).toBe("FINAL");
  });

  it("reports exceeded limits as warnings in the live view and flags a stale FINAL sheet", async () => {
    const { id, flight } = await loadedFlight();
    await save(users.staff.token, id, { cargoWeightKg: 3500, fuelWeightKg: 5000 });
    const live = await get(users.staff.token, id);
    expect(live.body.load.withinLimits).toBe(false);
    expect(live.body.load.warnings[0]).toMatch(/^EXCEEDS/);

    await save(users.staff.token, id, { cargoWeightKg: 100, fuelWeightKg: 5000 });
    await fin(users.staff.token, id);
    expect((await get(users.staff.token, id)).body.outOfDate).toBe(false);

    const extra = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    await api(checkInRoute, "POST", "/api/checkin", {
      token: users.staff.token,
      body: { pnrLocator: extra.locator, segmentIndex: 0, channel: "AIRPORT" },
    });
    expect((await get(users.staff.token, id)).body.outOfDate).toBe(true);
  });

  it("cannot reopen or edit once the flight is closed", async () => {
    const { id, flight } = await loadedFlight();
    await save(users.staff.token, id, { cargoWeightKg: 0, fuelWeightKg: 5000 });
    await fin(users.staff.token, id);
    await Flight.updateOne({ _id: flight._id }, { status: "CLOSED" });
    expect((await reop(users.staff.token, id)).status).toBe(409);
  });

  it("404s on an unknown flight and 400s on a malformed id", async () => {
    expect((await get(users.staff.token, "64b000000000000000000000")).status).toBe(404);
    expect((await get(users.staff.token, "nope")).status).toBe(400);
  });
});
