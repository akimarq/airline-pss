import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkInRoute } from "@/app/api/checkin/route";
import { POST as cancelRoute } from "@/app/api/checkin/[id]/cancel/route";
import { POST as createBag } from "@/app/api/baggage/route";
import { POST as saveLoad } from "@/app/api/flights/[id]/load/route";
import { POST as finalize } from "@/app/api/flights/[id]/load/finalize/route";
import { POST as reopen } from "@/app/api/flights/[id]/load/reopen/route";
import { GET as manifest } from "@/app/api/flights/[id]/boarding/route";
import { POST as openRoute } from "@/app/api/flights/[id]/boarding/open/route";
import { POST as scanRoute } from "@/app/api/flights/[id]/boarding/scan/route";
import { POST as closeRoute } from "@/app/api/flights/[id]/boarding/close/route";
import { POST as departRoute } from "@/app/api/flights/[id]/boarding/depart/route";
import { GET as boardingPassRoute } from "@/app/api/boarding-passes/[checkInId]/route";
import { Baggage, CheckIn, Flight, Ticket } from "@/models";
import { releaseSoldSeats } from "@/modules/dcs/inventoryPort";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { api, makeBooking, makeFlight, makeUsers, startDcsDB, type TestUser } from "./helpers/dcs";

// The Inventory module is a separate worker's code: DCS only talks to it through this port.
vi.mock("@/modules/dcs/inventoryPort", () => ({ releaseSoldSeats: vi.fn(async () => {}) }));
const releaseMock = vi.mocked(releaseSoldSeats);

let users: { passenger: TestUser; other: TestUser; staff: TestUser };

beforeAll(startDcsDB);
afterAll(stopTestDB);
beforeEach(async () => {
  await clearTestDB();
  releaseMock.mockClear();
  releaseMock.mockImplementation(async () => {});
  users = await makeUsers();
});

const p = (id: string) => ({ params: { id } });
const staff = () => ({ token: users.staff.token });

/**
 * Flight with: A (checked in, boards), B (checked in with a bag, never boards),
 * C (J-cabin class K, ticketed, never checks in).
 */
async function scenario() {
  const flight = await makeFlight({ hoursToDeparture: 5 });
  const id = flight._id.toString();
  const A = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
  const B = await makeBooking({ ownerId: users.other.id, flightId: flight._id });
  const C = await makeBooking({ ownerId: users.other.id, flightId: flight._id, cabin: "J", bookingClass: "K" });

  const ci = async (locator: string) =>
    (await api(checkInRoute, "POST", "/api/checkin", { ...staff(), body: { pnrLocator: locator, segmentIndex: 0, channel: "AIRPORT" } })).body;
  const a = await ci(A.locator);
  const b = await ci(B.locator);
  const bag = await api(createBag, "POST", "/x", { ...staff(), body: { pnrLocator: B.locator, weightKg: 15 } });
  return { flight, id, A, B, C, a, b, bagTag: bag.body.baggage.tagNumber as string };
}

async function finalizeLoad(id: string) {
  expect((await api(saveLoad, "POST", "/x", { ...staff(), body: { cargoWeightKg: 500, fuelWeightKg: 6000 }, ...p(id) })).status).toBe(200);
  expect((await api(finalize, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(200);
}

const scan = (id: string, body: unknown, token = users.staff.token) => api(scanRoute, "POST", "/x", { token, body, ...p(id) });

describe("gate boarding: opening", () => {
  it("is staff only and requires a FINAL load sheet", async () => {
    const { id } = await scenario();
    expect((await api(openRoute, "POST", "/x", { token: users.passenger.token, ...p(id) })).status).toBe(403);

    const noSheet = await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });
    expect(noSheet.status).toBe(409);
    expect(noSheet.body.error.code).toBe("LOAD_SHEET_NOT_FINAL");

    await api(saveLoad, "POST", "/x", { ...staff(), body: { cargoWeightKg: 0, fuelWeightKg: 5000 }, ...p(id) });
    expect((await api(openRoute, "POST", "/x", { ...staff(), ...p(id) })).body.error.code).toBe("LOAD_SHEET_NOT_FINAL"); // DRAFT only
    expect((await Flight.findById(id))!.status).toBe("SCHEDULED");
  });

  it("sets BOARDING + boardingOpen + gate and cannot be opened twice", async () => {
    const { id } = await scenario();
    await finalizeLoad(id);
    const res = await api(openRoute, "POST", "/x", { ...staff(), body: { gate: "b12" }, ...p(id) });
    expect(res.status).toBe(200);
    expect(res.body.flight).toMatchObject({ status: "BOARDING", boardingOpen: true, gate: "B12" });
    expect((await api(openRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(409);
  });

  it("propagates the gate to existing boarding passes", async () => {
    const { id, a } = await scenario();
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), body: { gate: "C4" }, ...p(id) });
    const pass = await api(boardingPassRoute, "GET", "/x", { ...staff(), params: { checkInId: a.checkIn._id } });
    expect(pass.body.boardingPass.gate).toBe("C4");
  });
});

describe("gate boarding: scan", () => {
  it("rejects scans before boarding is open", async () => {
    const { id, a } = await scenario();
    const res = await scan(id, { barcode: a.boardingPass.barcode });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BOARDING_NOT_OPEN");
  });

  it("boards by barcode, rejects a second scan as 'already boarded' (409), staff only", async () => {
    const { id, a, b } = await scenario();
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });

    expect((await scan(id, { barcode: a.boardingPass.barcode }, users.passenger.token)).status).toBe(403);

    const ok = await scan(id, { barcode: a.boardingPass.barcode });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ result: "BOARDED", checkInId: a.checkIn._id, seat: a.checkIn.seat, passengerName: "DOE/FIRST0" });
    const stored = await CheckIn.findById(a.checkIn._id);
    expect(stored!.status).toBe("BOARDED");
    expect(stored!.boardedAt).toBeInstanceOf(Date);

    const dup = await scan(id, { barcode: a.boardingPass.barcode });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ALREADY_BOARDED");
    expect(dup.body.error.message).toMatch(/already boarded/i);
    expect((await scan(id, { checkInId: a.checkIn._id })).body.error.code).toBe("ALREADY_BOARDED");

    // B is still scannable by check-in id
    expect((await scan(id, { checkInId: b.checkIn._id })).status).toBe(200);
  });

  it("validates the payload, the flight and unknown passes", async () => {
    const { id, a } = await scenario();
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });

    expect((await scan(id, {})).status).toBe(400);
    expect((await scan(id, { barcode: "x", checkInId: a.checkIn._id })).status).toBe(400);
    expect((await scan(id, { barcode: "garbage" })).status).toBe(400);
    const forged = a.boardingPass.barcode.replace("0001 1", "0099 1");
    expect((await scan(id, { barcode: forged })).status).toBe(404);

    // a pass for another flight
    const other = await makeFlight();
    const O = await makeBooking({ ownerId: users.passenger.id, flightId: other._id });
    const oc = await api(checkInRoute, "POST", "/api/checkin", { ...staff(), body: { pnrLocator: O.locator, segmentIndex: 0, channel: "AIRPORT" } });
    const wrong = await scan(id, { barcode: oc.body.boardingPass.barcode });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("WRONG_FLIGHT");
    expect((await scan(id, { checkInId: oc.body.checkIn._id })).body.error.code).toBe("WRONG_FLIGHT");
  });

  it("a cancelled check-in's barcode no longer boards", async () => {
    const { id, a } = await scenario();
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });
    // no bags on A, so the cancel is allowed
    expect((await api(cancelRoute, "POST", "/x", { ...staff(), params: { id: a.checkIn._id } })).status).toBe(200);
    expect((await scan(id, { barcode: a.boardingPass.barcode })).status).toBe(404);
  });

  it("two concurrent scans of the same pass: one boards, one gets 409", async () => {
    const { id, a } = await scenario();
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });
    const results = await Promise.all([
      scan(id, { barcode: a.boardingPass.barcode }),
      scan(id, { barcode: a.boardingPass.barcode }),
      scan(id, { checkInId: a.checkIn._id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });
});

describe("gate boarding: manifest, close, depart", () => {
  it("runs the full flow: open, scan, double-scan, close with no-shows released, depart", async () => {
    const { id, flight, a, b, A, B, C, bagTag } = await scenario();

    // depart before closing is not possible
    expect((await api(departRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(409);

    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), body: { gate: "A1" }, ...p(id) });
    expect((await scan(id, { barcode: a.boardingPass.barcode })).status).toBe(200);
    expect((await scan(id, { barcode: a.boardingPass.barcode })).status).toBe(409);

    const m = await api(manifest, "GET", "/x", { ...staff(), ...p(id) });
    expect(m.status).toBe(200);
    expect(m.body.counts).toMatchObject({
      ticketed: 3,
      checkedIn: 2,
      boarded: 1,
      notYetBoarded: 1,
      notCheckedIn: 1,
      noShow: 0,
      noShowCandidates: 2,
    });
    expect(m.body.passengers).toHaveLength(2);
    expect(m.body.noShowCandidates.map((c: { kind: string }) => c.kind).sort()).toEqual(["CHECKED_IN_NOT_BOARDED", "NOT_CHECKED_IN"]);
    expect((await api(manifest, "GET", "/x", { token: users.passenger.token, ...p(id) })).status).toBe(403);

    // close
    expect((await api(closeRoute, "POST", "/x", { token: users.passenger.token, ...p(id) })).status).toBe(403);
    const close = await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) });
    expect(close.status).toBe(200);
    expect(close.body.summary).toMatchObject({
      status: "CLOSED",
      boarded: 1,
      noShows: { checkedInNotBoarded: 1, notCheckedIn: 1, total: 2 },
      baggageOffloaded: 1,
      inventoryReleaseFailures: [],
    });
    expect(close.body.summary.seatsReleased).toEqual(
      expect.arrayContaining([
        { cabin: "Y", bucketClass: "Y", seats: 1 },
        { cabin: "J", bucketClass: "K", seats: 1 },
      ]),
    );

    // seats were released through the (mocked) inventory port
    expect(releaseMock).toHaveBeenCalledTimes(2);
    expect(releaseMock).toHaveBeenCalledWith(flight._id, "Y", "Y", 1, users.staff.id);
    expect(releaseMock).toHaveBeenCalledWith(flight._id, "J", "K", 1, users.staff.id);

    const after = await Flight.findById(id);
    expect(after).toMatchObject({ status: "CLOSED", boardingOpen: false });
    expect((await CheckIn.findById(b.checkIn._id))!.status).toBe("NO_SHOW");
    expect((await CheckIn.findById(a.checkIn._id))!.status).toBe("BOARDED");
    const bag = await Baggage.findOne({ tagNumber: bagTag });
    expect(bag!.status).toBe("OFFLOADED");
    expect(bag!.history.at(-1)!.status).toBe("OFFLOADED");
    // ticket status stays as is for no-shows
    expect((await Ticket.findOne({ pnrLocator: C.locator }))!.status).toBe("ISSUED");
    expect((await Ticket.findOne({ pnrLocator: B.locator }))!.status).toBe("ISSUED");

    // closed: no more scans or second close
    expect((await scan(id, { checkInId: b.checkIn._id })).body.error.code).toBe("BOARDING_NOT_OPEN");
    expect((await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(409);
    expect(releaseMock).toHaveBeenCalledTimes(2);

    // depart
    const dep = await api(departRoute, "POST", "/x", { ...staff(), ...p(id) });
    expect(dep.status).toBe(200);
    expect(dep.body.result).toMatchObject({ status: "DEPARTED", boarded: 1, ticketsUsed: 1 });
    expect((await Flight.findById(id))!.status).toBe("DEPARTED");
    expect((await Ticket.findOne({ pnrLocator: A.locator }))!.status).toBe("USED");
    expect((await Ticket.findOne({ pnrLocator: B.locator }))!.status).toBe("ISSUED");
    expect((await api(departRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(409);
  });

  it("cannot close unless boarding is open and the load sheet is FINAL", async () => {
    const { id } = await scenario();
    expect((await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(409); // not boarding

    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });
    await api(reopen, "POST", "/x", { ...staff(), ...p(id) }); // reopened during boarding
    const res = await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LOAD_SHEET_NOT_FINAL");
    expect((await Flight.findById(id))!.status).toBe("BOARDING");

    await api(finalize, "POST", "/x", { ...staff(), ...p(id) });
    expect((await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) })).status).toBe(200);
  });

  it("does not release seats for infants and reports inventory failures without blocking the close", async () => {
    const flight = await makeFlight({ hoursToDeparture: 5 });
    const id = flight._id.toString();
    await makeBooking({
      ownerId: users.passenger.id,
      flightId: flight._id,
      passengers: [{ type: "ADULT" }, { type: "INFANT" }],
    });
    await finalizeLoad(id);
    await api(openRoute, "POST", "/x", { ...staff(), ...p(id) });
    releaseMock.mockRejectedValueOnce(new Error("inventory down"));

    const res = await api(closeRoute, "POST", "/x", { ...staff(), ...p(id) });
    expect(res.status).toBe(200);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(flight._id, "Y", "Y", 1, users.staff.id); // adult only
    expect(res.body.summary.noShows.notCheckedIn).toBe(2);
    expect(res.body.summary.seatsReleased).toEqual([]);
    expect(res.body.summary.inventoryReleaseFailures).toEqual([{ cabin: "Y", bucketClass: "Y", seats: 1, error: "inventory down" }]);
    expect((await Flight.findById(id))!.status).toBe("CLOSED");
  });
});
