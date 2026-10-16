import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkInRoute, GET as listCheckInsRoute } from "@/app/api/checkin/route";
import { POST as cancelRoute } from "@/app/api/checkin/[id]/cancel/route";
import { GET as seatMapRoute } from "@/app/api/flights/[id]/seatmap/route";
import { GET as boardingPassRoute } from "@/app/api/boarding-passes/[checkInId]/route";
import { GET as listPassesRoute } from "@/app/api/boarding-passes/route";
import { BoardingPass, CheckIn, Flight } from "@/models";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { api, makeAircraft, makeBooking, makeFlight, makeUsers, startDcsDB, type TestUser } from "./helpers/dcs";

let users: { passenger: TestUser; other: TestUser; staff: TestUser };

beforeAll(startDcsDB);
afterAll(stopTestDB);
beforeEach(async () => {
  await clearTestDB();
  users = await makeUsers();
});

const checkIn = (token: string | undefined, body: Record<string, unknown>) =>
  api(checkInRoute, "POST", "/api/checkin", { token, body: { channel: "ONLINE", segmentIndex: 0, ...body } });

async function setup(opts: { hours?: number; passengers?: { type?: "ADULT" | "CHILD" | "INFANT" }[]; cabin?: "F" | "J" | "Y" } = {}) {
  const flight = await makeFlight({ hoursToDeparture: opts.hours ?? 10 });
  const booking = await makeBooking({
    ownerId: users.passenger.id,
    flightId: flight._id,
    passengers: opts.passengers,
    cabin: opts.cabin,
    bookingClass: opts.cabin === "J" ? "J" : "Y",
  });
  return { flight, ...booking };
}

describe("check-in window", () => {
  it("rejects too early (409 CHECKIN_NOT_OPEN), even for staff override", async () => {
    const { locator } = await setup({ hours: 30 });
    const p = await checkIn(users.passenger.token, { pnrLocator: locator });
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("CHECKIN_NOT_OPEN");

    const s = await checkIn(users.staff.token, { pnrLocator: locator, channel: "AIRPORT", override: true });
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("CHECKIN_NOT_OPEN");
  });

  it("accepts inside the window and returns a boarding pass", async () => {
    const { locator, flight } = await setup({ hours: 10 });
    const res = await checkIn(users.passenger.token, { pnrLocator: locator });
    expect(res.status).toBe(201);
    expect(res.body.checkIn).toMatchObject({ status: "CHECKED_IN", seat: "4A", boardingSequence: 1, channel: "ONLINE" });
    expect(res.body.boardingPass.flightId).toBe(flight._id.toString());
  });

  it("rejects too late (409 CHECKIN_CLOSED) for passengers and for staff without override", async () => {
    const { locator } = await setup({ hours: 0.5 }); // 30 min before departure
    const p = await checkIn(users.passenger.token, { pnrLocator: locator });
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("CHECKIN_CLOSED");
    const s = await checkIn(users.staff.token, { pnrLocator: locator, channel: "AIRPORT" });
    expect(s.body.error.code).toBe("CHECKIN_CLOSED");
  });

  it("lets staff override the closing cutoff only with override: true; passengers cannot", async () => {
    const { locator, passengerIds } = await setup({ hours: 0.5, passengers: [{}, {}] });
    const [a, b] = passengerIds;

    const forbidden = await checkIn(users.passenger.token, { pnrLocator: locator, passengerId: a, override: true });
    expect(forbidden.status).toBe(403);

    const ok = await checkIn(users.staff.token, { pnrLocator: locator, passengerId: b, channel: "AIRPORT", override: true });
    expect(ok.status).toBe(201);
    expect(ok.body.checkIn.channel).toBe("AIRPORT");
  });

  it("rejects cancelled, closed and departed flights", async () => {
    for (const status of ["CANCELLED", "CLOSED", "DEPARTED"]) {
      const { locator, flight } = await setup();
      await Flight.updateOne({ _id: flight._id }, { status });
      const res = await checkIn(users.staff.token, { pnrLocator: locator, channel: "AIRPORT", override: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(status === "CANCELLED" ? "FLIGHT_CANCELLED" : "FLIGHT_CLOSED");
    }
  });
});

describe("eligibility", () => {
  it("requires a TICKETED PNR and a non-void ISSUED ticket", async () => {
    const flight = await makeFlight();
    const held = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id, pnrStatus: "CONFIRMED" });
    expect((await checkIn(users.passenger.token, { pnrLocator: held.locator })).status).toBe(409);

    const voided = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id, ticketStatus: "VOID" });
    const res = await checkIn(users.passenger.token, { pnrLocator: voided.locator });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TICKET_VOID");
  });

  it("accepts ticketId in place of segmentIndex and detects double check-in (409)", async () => {
    const { locator, tickets } = await setup();
    const body = { pnrLocator: locator, ticketId: tickets[0]._id.toString() };
    const first = await api(checkInRoute, "POST", "/api/checkin", { token: users.passenger.token, body: { ...body, channel: "ONLINE" } });
    expect(first.status).toBe(201);
    const again = await api(checkInRoute, "POST", "/api/checkin", { token: users.passenger.token, body: { ...body, channel: "ONLINE" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_CHECKED_IN");
  });

  it("requires passengerId when the PNR has several passengers", async () => {
    const { locator } = await setup({ passengers: [{}, {}] });
    expect((await checkIn(users.passenger.token, { pnrLocator: locator })).status).toBe(400);
  });

  it("validates input (400) and unknown PNR (404)", async () => {
    expect((await api(checkInRoute, "POST", "/api/checkin", { token: users.staff.token, body: { pnrLocator: "ABCDEF" } })).status).toBe(400);
    expect((await checkIn(users.staff.token, { pnrLocator: "ZZZZZZ" })).status).toBe(404);
  });
});

describe("roles and ownership", () => {
  it("requires authentication", async () => {
    const { locator } = await setup();
    expect((await checkIn(undefined, { pnrLocator: locator })).status).toBe(401);
  });

  it("a passenger cannot check in someone else's PNR", async () => {
    const { locator } = await setup();
    const res = await checkIn(users.other.token, { pnrLocator: locator });
    expect(res.status).toBe(403);
  });

  it("a passenger cannot use the AIRPORT channel", async () => {
    const { locator } = await setup();
    const res = await checkIn(users.passenger.token, { pnrLocator: locator, channel: "AIRPORT" });
    expect(res.status).toBe(403);
  });

  it("staff can check in any PNR via AIRPORT or ONLINE", async () => {
    const a = await setup();
    const b = await setup();
    expect((await checkIn(users.staff.token, { pnrLocator: a.locator, channel: "AIRPORT" })).status).toBe(201);
    expect((await checkIn(users.staff.token, { pnrLocator: b.locator, channel: "ONLINE" })).status).toBe(201);
  });

  it("GET /api/checkin: staff by flight, owner by pnr, others forbidden", async () => {
    const { locator, flight } = await setup();
    await checkIn(users.passenger.token, { pnrLocator: locator });
    const q = (token: string, qs: string) => api(listCheckInsRoute, "GET", `/api/checkin?${qs}`, { token });

    const staff = await q(users.staff.token, `flightId=${flight._id}`);
    expect(staff.status).toBe(200);
    expect(staff.body.total).toBe(1);
    expect(staff.body.checkIns[0].passengerName).toBe("DOE/FIRST0");

    expect((await q(users.passenger.token, `pnr=${locator}`)).body.total).toBe(1);
    expect((await q(users.other.token, `pnr=${locator}`)).status).toBe(403);
    expect((await q(users.passenger.token, `flightId=${flight._id}`)).status).toBe(403);
    expect((await q(users.staff.token, "")).status).toBe(400);
  });
});

describe("seat assignment", () => {
  it("auto-assigns the next free seat in the booked cabin", async () => {
    const flight = await makeFlight();
    const eco = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id, passengers: [{}, {}, {}] });
    const biz = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id, cabin: "J", bookingClass: "J" });
    const ids = eco.passengerIds;

    expect((await checkIn(users.passenger.token, { pnrLocator: eco.locator, passengerId: ids[0], seat: "4B" })).body.checkIn.seat).toBe("4B");
    const seats: string[] = [];
    for (const id of ids.slice(1)) {
      seats.push((await checkIn(users.passenger.token, { pnrLocator: eco.locator, passengerId: id })).body.checkIn.seat);
    }
    expect(seats).toEqual(["4A", "4C"]); // 4B is taken, so skipped
    expect((await checkIn(users.passenger.token, { pnrLocator: biz.locator })).body.checkIn.seat).toBe("2A");
  });

  it("validates the seat against the layout and the booked cabin", async () => {
    const { locator } = await setup();
    const nonexistent = await checkIn(users.passenger.token, { pnrLocator: locator, seat: "99A" });
    expect(nonexistent.status).toBe(400);
    const badLetter = await checkIn(users.passenger.token, { pnrLocator: locator, seat: "2B" }); // J has no B
    expect(badLetter.status).toBe(400);
    const wrongCabin = await checkIn(users.passenger.token, { pnrLocator: locator, seat: "2A" });
    expect(wrongCabin.status).toBe(400);
    expect(wrongCabin.body.error.message).toMatch(/cabin J/);
  });

  it("returns 409 SEAT_TAKEN for an occupied seat", async () => {
    const flight = await makeFlight();
    const a = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    const b = await makeBooking({ ownerId: users.other.id, flightId: flight._id });
    expect((await checkIn(users.passenger.token, { pnrLocator: a.locator, seat: "5C" })).status).toBe(201);
    const res = await checkIn(users.other.token, { pnrLocator: b.locator, seat: "5c" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SEAT_TAKEN");
  });

  it("exactly one of several parallel check-ins for the same seat succeeds", async () => {
    const flight = await makeFlight();
    const n = 8;
    const bookings = await Promise.all(
      Array.from({ length: n }, () => makeBooking({ ownerId: users.passenger.id, flightId: flight._id })),
    );
    const results = await Promise.all(bookings.map((b) => checkIn(users.passenger.token, { pnrLocator: b.locator, seat: "6D" })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(n - 1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SEAT_TAKEN")).toBe(true);
    expect(await CheckIn.countDocuments({ flightId: flight._id, seat: "6D" })).toBe(1);
  });

  it("parallel auto-assignment gives distinct seats and unique, gap-free boarding sequences", async () => {
    const flight = await makeFlight();
    const n = 10;
    const bookings = await Promise.all(
      Array.from({ length: n }, () => makeBooking({ ownerId: users.passenger.id, flightId: flight._id })),
    );
    const results = await Promise.all(bookings.map((b) => checkIn(users.passenger.token, { pnrLocator: b.locator })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seats = results.map((r) => r.body.checkIn.seat);
    const seqs = results.map((r) => r.body.checkIn.boardingSequence).sort((x, y) => x - y);
    expect(new Set(seats).size).toBe(n);
    expect(seqs).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it("boarding sequence is per flight", async () => {
    const a = await setup();
    const b = await setup();
    expect((await checkIn(users.passenger.token, { pnrLocator: a.locator })).body.checkIn.boardingSequence).toBe(1);
    expect((await checkIn(users.passenger.token, { pnrLocator: b.locator })).body.checkIn.boardingSequence).toBe(1);
  });

  it("returns 409 NO_SEATS_AVAILABLE when the cabin is full", async () => {
    const aircraft = await makeAircraft({
      cabins: [{ cabin: "Y", firstRow: 4, lastRow: 4, seatLetters: ["A"] }],
    });
    const flight = await makeFlight({ aircraftId: aircraft._id });
    const a = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    const b = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    expect((await checkIn(users.passenger.token, { pnrLocator: a.locator })).status).toBe(201);
    const res = await checkIn(users.passenger.token, { pnrLocator: b.locator });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_SEATS_AVAILABLE");
  });
});

describe("infants", () => {
  it("are checked in without a seat (pseudo seat INF-n); requesting a seat is rejected", async () => {
    const { locator, passengerIds } = await setup({ passengers: [{ type: "ADULT" }, { type: "INFANT" }] });
    const bad = await checkIn(users.passenger.token, { pnrLocator: locator, passengerId: passengerIds[1], seat: "4A" });
    expect(bad.status).toBe(400);

    const adult = await checkIn(users.passenger.token, { pnrLocator: locator, passengerId: passengerIds[0] });
    const infant = await checkIn(users.passenger.token, { pnrLocator: locator, passengerId: passengerIds[1] });
    expect(infant.status).toBe(201);
    expect(adult.body.checkIn.seat).toBe("4A");
    expect(infant.body.checkIn.seat).toBe("INF-2");
    expect(infant.body.boardingPass.seat).toBe("INF");
    expect(infant.body.boardingPass.barcode.slice(48, 52)).toBe("INF ");
  });
});

describe("seat map", () => {
  it("shows availability per cabin/row/seat; hides identities from passengers", async () => {
    const { locator, flight } = await setup();
    await checkIn(users.passenger.token, { pnrLocator: locator, seat: "4B" });

    const asPax = await api(seatMapRoute, "GET", "/x", { token: users.other.token, params: { id: flight._id.toString() } });
    expect(asPax.status).toBe(200);
    const map = asPax.body.seatMap;
    expect(map.cabins.map((c: { cabin: string }) => c.cabin)).toEqual(["F", "J", "Y"]);
    const economy = map.cabins[2];
    expect(economy.totalSeats).toBe(30);
    expect(economy.availableSeats).toBe(29);
    const row4 = economy.rows.find((r: { row: number }) => r.row === 4);
    expect(row4.seats.find((s: { seat: string }) => s.seat === "4B").status).toBe("OCCUPIED");
    expect(row4.seats.find((s: { seat: string }) => s.seat === "4A").status).toBe("AVAILABLE");
    expect(JSON.stringify(map)).not.toContain(locator);
    expect(JSON.stringify(map)).not.toContain("occupant");

    const asStaff = await api(seatMapRoute, "GET", "/x", { token: users.staff.token, params: { id: flight._id.toString() } });
    const occupied = asStaff.body.seatMap.cabins[2].rows[0].seats[1];
    expect(occupied.occupant.pnrLocator).toBe(locator);
    expect((await api(seatMapRoute, "GET", "/x", { params: { id: flight._id.toString() } })).status).toBe(401);
  });
});

describe("cancel check-in", () => {
  it("frees the seat and invalidates the boarding pass; owner or staff only", async () => {
    const { locator, flight } = await setup();
    const res = await checkIn(users.passenger.token, { pnrLocator: locator, seat: "7A" });
    const id = res.body.checkIn._id;

    expect((await api(cancelRoute, "POST", "/x", { token: users.other.token, params: { id } })).status).toBe(403);
    const ok = await api(cancelRoute, "POST", "/x", { token: users.passenger.token, params: { id } });
    expect(ok.status).toBe(200);
    expect(await BoardingPass.countDocuments({ checkInId: id })).toBe(0);
    expect((await api(cancelRoute, "POST", "/x", { token: users.passenger.token, params: { id } })).status).toBe(404);

    // the seat is free again and the passenger can re-check-in
    const other = await makeBooking({ ownerId: users.other.id, flightId: flight._id });
    expect((await checkIn(users.other.token, { pnrLocator: other.locator, seat: "7A" })).status).toBe(201);
    expect((await checkIn(users.passenger.token, { pnrLocator: locator })).status).toBe(201);
  });

  it("is refused once boarded", async () => {
    const { locator } = await setup();
    const res = await checkIn(users.passenger.token, { pnrLocator: locator });
    await CheckIn.updateOne({ _id: res.body.checkIn._id }, { status: "BOARDED" });
    const cancel = await api(cancelRoute, "POST", "/x", { token: users.staff.token, params: { id: res.body.checkIn._id } });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("ALREADY_BOARDED");
  });
});

describe("boarding pass", () => {
  it("stores flight, seat, gate, boarding time (dep-40min), sequence and BCBP barcode", async () => {
    const flight = await makeFlight({ hoursToDeparture: 10, gate: "A3" });
    const { locator } = await makeBooking({ ownerId: users.passenger.id, flightId: flight._id });
    const res = await checkIn(users.passenger.token, { pnrLocator: locator, seat: "8F" });
    const id = res.body.checkIn._id;

    const get = await api(boardingPassRoute, "GET", "/x", { token: users.passenger.token, params: { checkInId: id } });
    expect(get.status).toBe(200);
    const pass = get.body.boardingPass;
    expect(pass).toMatchObject({
      pnrLocator: locator,
      flightNumber: flight.flightNumber,
      seat: "8F",
      gate: "A3",
      boardingSequence: 1,
      cabin: "Y",
      passengerName: "DOE/FIRST0",
      checkInStatus: "CHECKED_IN",
    });
    expect(new Date(pass.boardingTime).getTime()).toBe(flight.departure.getTime() - 40 * 60_000);
    expect(pass.barcode).toHaveLength(60);
    expect(pass.barcode.startsWith("M1DOE/FIRST0")).toBe(true);
    expect(pass.barcode.slice(48, 52)).toBe("008F");
  });

  it("is regenerated on demand and follows a late gate change", async () => {
    const { locator, flight } = await setup();
    const res = await checkIn(users.passenger.token, { pnrLocator: locator });
    const id = res.body.checkIn._id;
    await BoardingPass.deleteMany({});
    await Flight.updateOne({ _id: flight._id }, { gate: "C9" });
    const get = await api(boardingPassRoute, "GET", "/x", { token: users.staff.token, params: { checkInId: id } });
    expect(get.status).toBe(200);
    expect(get.body.boardingPass.gate).toBe("C9");
  });

  it("is owner or staff only, and lists by pnr", async () => {
    const { locator } = await setup();
    const res = await checkIn(users.passenger.token, { pnrLocator: locator });
    const id = res.body.checkIn._id;
    expect((await api(boardingPassRoute, "GET", "/x", { token: users.other.token, params: { checkInId: id } })).status).toBe(403);
    expect((await api(boardingPassRoute, "GET", "/x", { params: { checkInId: id } })).status).toBe(401);
    expect((await api(boardingPassRoute, "GET", "/x", { token: users.staff.token, params: { checkInId: "nope" } })).status).toBe(400);

    const list = await api(listPassesRoute, "GET", `/api/boarding-passes?pnr=${locator}`, { token: users.passenger.token });
    expect(list.status).toBe(200);
    expect(list.body.boardingPasses).toHaveLength(1);
    expect((await api(listPassesRoute, "GET", `/api/boarding-passes?pnr=${locator}`, { token: users.other.token })).status).toBe(403);
    expect((await api(listPassesRoute, "GET", "/api/boarding-passes", { token: users.staff.token })).status).toBe(400);
  });
});
