import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Inventory, PNR, Ticket } from "@/models";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { startDcsDB } from "./helpers/dcs";
import {
  CONTACT,
  DAY_HOURS,
  adult,
  book,
  bookAndTicket,
  bucketCounters,
  client,
  createFlightViaApi,
  finalizeLoadSheet,
  makePassenger,
  makeStaff,
  r,
  type Actor,
  type FlightFixture,
} from "./helpers/e2e";

beforeAll(startDcsDB);
afterAll(stopTestDB);

let staff: Actor;
let alice: Actor;
let bob: Actor;
let fx: FlightFixture;

beforeEach(async () => {
  await clearTestDB();
  staff = await makeStaff();
  alice = await makePassenger("alice@e2e.test", "Alice");
  bob = await makePassenger("bob@e2e.test", "Bob");
  fx = await createFlightViaApi(staff, { hoursAhead: 10 });
});

const OID = "665f1c2e8b3a4d0012a4b5c6";

describe("e2e roles: passenger is forbidden from staff endpoints", () => {
  it("returns 403 FORBIDDEN for every staff-only operation", async () => {
    const id = fx.flightId;
    const cases: [string, () => Promise<{ status: number; json: { error?: { code: string } } }>][] = [
      ["POST /api/aircraft", () => alice.api.post(r.aircraftRoute, "/api/aircraft", {})],
      ["GET /api/aircraft", () => alice.api.get(r.aircraftRoute, "/api/aircraft")],
      ["POST /api/auth/staff", () => alice.api.post(r.staffRoute, "/api/auth/staff", { email: "x@e2e.test", password: "Password123!", name: "X" })],
      ["POST /api/flights", () => alice.api.post(r.flightsRoute, "/api/flights", {})],
      ["PATCH /api/flights/:id", () => alice.api.patch(r.flightRoute, "/api/flights/:id", { gate: "A1" }, { id })],
      ["DELETE /api/flights/:id", () => alice.api.del(r.flightRoute, "/api/flights/:id", { id })],
      ["GET /api/fares", () => alice.api.get(r.faresRoute, "/api/fares")],
      ["POST /api/fares", () => alice.api.post(r.faresRoute, "/api/fares", {})],
      ["POST /api/inventory/:flightId", () => alice.api.post(r.inventoryRoute, "/api/inventory/:flightId", {}, { flightId: id })],
      ["PATCH bucket", () => alice.api.patch(r.inventoryBucketRoute, "/api/inventory/:flightId/buckets/:class", { open: false }, { flightId: id, class: "Q" })],
      ["POST reprice", () => alice.api.post(r.inventoryRepriceRoute, "/api/inventory/:flightId/reprice", undefined, { flightId: id })],
      ["PUT rules", () => alice.api.put(r.inventoryRulesRoute, "/api/inventory/:flightId/rules", { loadFactorRules: [], timeToDepartureRules: [] }, { flightId: id })],
      ["POST /api/baggage", () => alice.api.post(r.baggageRoute, "/api/baggage", { checkInId: OID, weightKg: 10 })],
      ["PATCH /api/baggage/:tag", () => alice.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "SCREENED" }, { tag: "PS0000000000" })],
      ["POST void ticket", () => alice.api.post(r.ticketVoidRoute, "/api/tickets/:ticketNumber/void", undefined, { ticketNumber: "1230000000001" })],
      ["GET load", () => alice.api.get(r.loadRoute, "/api/flights/:id/load", { id })],
      ["POST load", () => alice.api.post(r.loadRoute, "/api/flights/:id/load", { cargoWeightKg: 0, fuelWeightKg: 0 }, { id })],
      ["POST load/finalize", () => alice.api.post(r.loadFinalizeRoute, "/api/flights/:id/load/finalize", undefined, { id })],
      ["POST load/reopen", () => alice.api.post(r.loadReopenRoute, "/api/flights/:id/load/reopen", undefined, { id })],
      ["GET boarding", () => alice.api.get(r.boardingRoute, "/api/flights/:id/boarding", { id })],
      ["POST boarding/open", () => alice.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", undefined, { id })],
      ["POST boarding/scan", () => alice.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId: OID }, { id })],
      ["POST boarding/close", () => alice.api.post(r.boardingCloseRoute, "/api/flights/:id/boarding/close", undefined, { id })],
      ["POST boarding/depart", () => alice.api.post(r.boardingDepartRoute, "/api/flights/:id/boarding/depart", undefined, { id })],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      expect(res.status, label).toBe(403);
      expect(res.json.error?.code, label).toBe("FORBIDDEN");
    }
    // nothing changed
    expect((await staff.api.get(r.flightRoute, "/api/flights/:id", { id })).json.flight.status).toBe("SCHEDULED");
  });

  it("requires a valid token (401) but leaves search, fares and health public", async () => {
    const anon = client();
    for (const res of [
      await anon.get(r.pnrsRoute, "/api/pnrs"),
      await anon.post(r.pnrsRoute, "/api/pnrs", {}),
      await anon.get(r.flightsRoute, "/api/flights"),
      await anon.get(r.meRoute, "/api/auth/me"),
      await client("not-a-jwt").get(r.meRoute, "/api/auth/me"),
    ]) {
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("UNAUTHORIZED");
    }
    expect((await anon.get(r.searchRoute, `/api/flights/search?from=MNL&to=CEB&date=${fx.date}`)).status).toBe(200);
    expect((await anon.get(r.flightFaresRoute, "/api/flights/:id/fares", { id: fx.flightId })).status).toBe(200);
  });

  it("self-registration can never create a staff account, even when asking for the role", async () => {
    const res = await client().post(r.registerRoute, "/api/auth/register", { email: "sneaky@e2e.test", password: "Password123!", name: "Sneaky", role: "staff" });
    expect(res.status).toBe(201);
    expect(res.json.user.role).toBe("passenger");
    const login = await client().post(r.loginRoute, "/api/auth/login", { email: "sneaky@e2e.test", password: "Password123!" });
    const forbidden = await client(login.json.token).get(r.aircraftRoute, "/api/aircraft");
    expect(forbidden.status).toBe(403);

    // staff can create another staff account, who can then use staff endpoints
    const created = await staff.api.post(r.staffRoute, "/api/auth/staff", { email: "agent2@e2e.test", password: "Password123!", name: "Agent Two" });
    expect(created.status).toBe(201);
    expect(created.json.user.role).toBe("staff");
    const agent = await client().post(r.loginRoute, "/api/auth/login", { email: "agent2@e2e.test", password: "Password123!" });
    expect((await client(agent.json.token).get(r.aircraftRoute, "/api/aircraft")).status).toBe(200);
  });

  it("passengers see only the open buckets of the inventory, staff see everything", async () => {
    const asPassenger = await alice.api.get(r.inventoryRoute, "/api/inventory/:flightId", { flightId: fx.flightId });
    expect(asPassenger.json.inventory).toBeUndefined();
    expect(asPassenger.json.availability.cabins[0].buckets[0]).toEqual({ class: expect.any(String), available: expect.any(Number) });
    const asStaff = await staff.api.get(r.inventoryRoute, "/api/inventory/:flightId", { flightId: fx.flightId });
    expect(asStaff.json.inventory.cabins[0].buckets[0]).toHaveProperty("sold");
  });
});

describe("e2e ownership: a passenger cannot touch another passenger's data", () => {
  it("cannot read, change, cancel, pay or check in someone else's PNR", async () => {
    const mine = await bookAndTicket(alice, fx.flightId, "M");
    const params = { locator: mine.locator };

    const checkedIn = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: mine.locator, segmentIndex: 0, channel: "ONLINE" });
    expect(checkedIn.status).toBe(201);
    const checkInId: string = checkedIn.json.checkIn._id;
    const bag = await staff.api.post(r.baggageRoute, "/api/baggage", { checkInId, weightKg: 10 });
    expect(bag.status).toBe(201);
    const tag: string = bag.json.baggage.tagNumber;

    const attempts: [string, () => Promise<{ status: number }>][] = [
      ["GET pnr", () => bob.api.get(r.pnrRoute, "/api/pnrs/:locator", params)],
      ["PATCH pnr", () => bob.api.patch(r.pnrRoute, "/api/pnrs/:locator", { contact: { email: "evil@e2e.test" } }, params)],
      ["cancel pnr", () => bob.api.post(r.pnrCancelRoute, "/api/pnrs/:locator/cancel", undefined, params)],
      ["GET tickets", () => bob.api.get(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", params)],
      ["POST tickets", () => bob.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", { payment: { method: "card", simulate: "success" } }, params)],
      ["GET ticket", () => bob.api.get(r.ticketRoute, "/api/tickets/:ticketNumber", { ticketNumber: mine.tickets[0].ticketNumber })],
      ["check in", () => bob.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: mine.locator, segmentIndex: 0, channel: "ONLINE" })],
      ["list check-ins by pnr", () => bob.api.get(r.checkinRoute, `/api/checkin?pnr=${mine.locator}`)],
      ["list check-ins by flight", () => bob.api.get(r.checkinRoute, `/api/checkin?flightId=${fx.flightId}`)],
      ["cancel check-in", () => bob.api.post(r.checkinCancelRoute, "/api/checkin/:id/cancel", undefined, { id: checkInId })],
      ["GET boarding pass", () => bob.api.get(r.bpRoute, "/api/boarding-passes/:checkInId", { checkInId })],
      ["list boarding passes", () => bob.api.get(r.bpListRoute, `/api/boarding-passes?pnr=${mine.locator}`)],
      ["GET bag", () => bob.api.get(r.baggageTagRoute, "/api/baggage/:tag", { tag })],
      ["list bags by pnr", () => bob.api.get(r.baggageRoute, `/api/baggage?pnr=${mine.locator}`)],
      ["book for another account", () => book(bob, fx.flightId, "M", [adult()], { ownerUserId: alice.id })],
    ];
    for (const [label, run] of attempts) expect((await run()).status, label).toBe(403);

    // bob's own views are empty; the owner and staff can read everything
    expect((await bob.api.get(r.pnrsRoute, "/api/pnrs")).json.total).toBe(0);
    expect((await bob.api.get(r.baggageRoute, `/api/baggage?flightId=${fx.flightId}`)).json.total).toBe(0);
    expect((await alice.api.get(r.pnrRoute, "/api/pnrs/:locator", params)).status).toBe(200);
    expect((await staff.api.get(r.pnrRoute, "/api/pnrs/:locator", params)).status).toBe(200);

    // the unchanged PNR is intact
    const view = await alice.api.get(r.pnrRoute, "/api/pnrs/:locator", params);
    expect(view.json.pnr.contact.email).toBe(CONTACT.email);
    expect(view.json.pnr.status).toBe("TICKETED");
  });

  it("returns 404 for unknown records and 400 for malformed ones", async () => {
    expect((await alice.api.get(r.pnrRoute, "/api/pnrs/:locator", { locator: "ZZZZZZ" })).status).toBe(404);
    expect((await staff.api.get(r.flightRoute, "/api/flights/:id", { id: OID })).status).toBe(404);
    expect((await staff.api.get(r.flightRoute, "/api/flights/:id", { id: "not-an-id" })).status).toBe(400);
    expect((await alice.api.get(r.ticketRoute, "/api/tickets/:ticketNumber", { ticketNumber: "12" })).status).toBe(400);
    const bad = await alice.api.post(r.pnrsRoute, "/api/pnrs", { passengers: [], segments: [], contact: { email: "nope" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(bad.json.error.details)).toBe(true);
    expect(bad.json.error.message).toBeTruthy();
  });
});

describe("e2e inventory: overselling is impossible through the API", () => {
  async function smallFlight() {
    return createFlightViaApi(staff, {
      inventory: { cabins: [{ cabin: "Y", capacity: 10, buckets: [{ class: "M", authorized: 3 }, { class: "Q", authorized: 3 }] }] },
      fares: [
        { fareBasis: "MSAVER", bookingClass: "M", cabin: "Y", price: 120 },
        { fareBasis: "QDEEP", bookingClass: "Q", cabin: "Y", price: 80 },
      ],
    });
  }

  it("answers 409 once a bucket is full, and a smaller booking still fits", async () => {
    const small = await smallFlight();
    const first = await book(alice, small.flightId, "M", [adult("A", "One"), adult("B", "One")]);
    expect(first.status).toBe(201);

    const tooMany = await book(bob, small.flightId, "M", [adult("C", "Two"), adult("D", "Two")]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.json.error.details).toMatchObject({ reason: "INSUFFICIENT_SEATS", available: 1 });
    expect((await bob.api.get(r.pnrsRoute, "/api/pnrs")).json.total).toBe(0); // nothing half-created

    expect((await book(bob, small.flightId, "M", [adult("C", "Two")])).status).toBe(201);
    const full = await book(alice, small.flightId, "M", [adult("E", "One")]);
    expect(full.status).toBe(409);

    const { buckets } = await bucketCounters(staff, small.flightId);
    expect(buckets.M).toMatchObject({ held: 3, sold: 0, available: 0 });
    expect(buckets.Q).toMatchObject({ held: 0, available: 3 }); // the other bucket is untouched
  });

  it("concurrent bookings of the last seats: exactly the available number succeed", async () => {
    const small = await smallFlight();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => book(i % 2 === 0 ? alice : bob, small.flightId, "M", [adult(String.fromCharCode(65 + i) + "lex", "Racer")])),
    );
    const ok = results.filter((x) => x.status === 201).length;
    const conflict = results.filter((x) => x.status === 409).length;
    expect(ok).toBe(3);
    expect(conflict).toBe(5);
    const { buckets } = await bucketCounters(staff, small.flightId);
    expect(buckets.M).toMatchObject({ held: 3, available: 0 });
  });

  it("an expired hold gives its seats back and cannot be paid", async () => {
    const small = await smallFlight();
    const first = await book(alice, small.flightId, "M", [adult("A", "One"), adult("B", "One"), adult("C", "One")]);
    expect(first.status).toBe(201);
    // make the hold lapse (the 15 minutes are real time; rewind it in the database)
    await Inventory.updateOne({}, { $set: { "holds.$[].expiresAt": new Date(Date.now() - 1000) } });
    await PNR.updateOne({ recordLocator: first.json.pnr.recordLocator }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } });

    const pay = await alice.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", { payment: { method: "card", simulate: "success" } }, { locator: first.json.pnr.recordLocator });
    expect(pay.status).toBe(409);
    expect((await book(bob, small.flightId, "M", [adult("D", "Two"), adult("E", "Two"), adult("F", "Two")])).status).toBe(201);
  });
});

describe("e2e revenue rules: closed buckets are not sold or searched", () => {
  const ruleInventory = (extra: Record<string, unknown>) => ({
    cabins: [{ cabin: "Y", capacity: 4, buckets: [{ class: "Y", authorized: 4 }, { class: "M", authorized: 4 }, { class: "Q", authorized: 4 }] }],
    ...extra,
  });
  const fares = [
    { fareBasis: "YFLEX", bookingClass: "Y", cabin: "Y" as const, price: 200 },
    { fareBasis: "MSAVER", bookingClass: "M", cabin: "Y" as const, price: 120 },
    { fareBasis: "QDEEP", bookingClass: "Q", cabin: "Y" as const, price: 80 },
  ];
  const classesInSearch = async (f: FlightFixture) => {
    const res = await client().get(r.flightFaresRoute, "/api/flights/:id/fares", { id: f.flightId });
    return res.json.fares.map((x: { bookingClass: string }) => x.bookingClass);
  };

  it("a load-factor rule closes Q (search and booking), a manual override wins, releaseToRules hands it back", async () => {
    const f = await createFlightViaApi(staff, { inventory: ruleInventory({ loadFactorRules: [{ thresholdPct: 50, closeClasses: ["Q"] }] }), fares });
    const search = (await client().get(r.searchRoute, `/api/flights/search?from=MNL&to=CEB&date=${f.date}`)).json.flights.find((x: { id: string }) => x.id === f.flightId);
    expect(search.lowestFare.bookingClass).toBe("Q");

    // 2 of 4 seats booked => load factor 50% => Q closes
    expect((await book(alice, f.flightId, "M", [adult("A", "One"), adult("B", "One")])).status).toBe(201);
    expect(await classesInSearch(f)).toEqual(["M", "Y"]);
    const after = (await client().get(r.searchRoute, `/api/flights/search?from=MNL&to=CEB&date=${f.date}`)).json.flights.find((x: { id: string }) => x.id === f.flightId);
    expect(after.lowestFare.bookingClass).toBe("M");
    const closed = await book(bob, f.flightId, "Q");
    expect(closed.status).toBe(409);
    expect(closed.json.error.details).toMatchObject({ class: "Q", reason: "CLOSED" });
    expect((await bucketCounters(staff, f.flightId)).buckets.Q).toMatchObject({ open: false, source: "rule" });

    // manual open has precedence over the rule, also after a reprice
    const open = await staff.api.patch(r.inventoryBucketRoute, "/api/inventory/:flightId/buckets/:class", { open: true }, { flightId: f.flightId, class: "Q" });
    expect(open.status).toBe(200);
    expect(open.json.bucket).toMatchObject({ class: "Q", open: true, source: "manual" });
    await staff.api.post(r.inventoryRepriceRoute, "/api/inventory/:flightId/reprice", undefined, { flightId: f.flightId });
    expect(await classesInSearch(f)).toContain("Q");
    expect((await book(bob, f.flightId, "Q")).status).toBe(201);

    // back to the rules engine: Q (3 of 4 seats now) closes again
    const back = await staff.api.patch(r.inventoryBucketRoute, "/api/inventory/:flightId/buckets/:class", { releaseToRules: true }, { flightId: f.flightId, class: "Q" });
    expect(back.status).toBe(200);
    await staff.api.post(r.inventoryRepriceRoute, "/api/inventory/:flightId/reprice", undefined, { flightId: f.flightId });
    expect(await classesInSearch(f)).not.toContain("Q");
  });

  it("a time-to-departure rule hides Q on a flight departing soon; a manual close hides any bucket", async () => {
    const soon = await createFlightViaApi(staff, {
      hoursAhead: DAY_HOURS,
      inventory: ruleInventory({ timeToDepartureRules: [{ daysBeforeDeparture: 2, closeClasses: ["Q"] }] }),
      fares,
    });
    expect(await classesInSearch(soon)).toEqual(["M", "Y"]);

    const later = await createFlightViaApi(staff, { hoursAhead: 10 * DAY_HOURS, inventory: ruleInventory({ timeToDepartureRules: [{ daysBeforeDeparture: 2, closeClasses: ["Q"] }] }), fares });
    expect(await classesInSearch(later)).toEqual(["Q", "M", "Y"]);
    expect((await staff.api.patch(r.inventoryBucketRoute, "/api/inventory/:flightId/buckets/:class", { open: false }, { flightId: later.flightId, class: "M" })).status).toBe(200);
    expect(await classesInSearch(later)).toEqual(["Q", "Y"]);
    expect((await book(alice, later.flightId, "M")).status).toBe(409);
    // staff cannot authorise more than the cabin holds
    const tooMuch = await staff.api.patch(r.inventoryBucketRoute, "/api/inventory/:flightId/buckets/:class", { authorized: 99 }, { flightId: later.flightId, class: "Y" });
    expect(tooMuch.status).toBe(400);
  });
});

describe("e2e check-in window", () => {
  it("is not open 24h+ before departure, closed 45 minutes before (staff may override, passengers may not)", async () => {
    const far = await createFlightViaApi(staff, { hoursAhead: 30 });
    const farBooking = await bookAndTicket(alice, far.flightId, "M");
    const tooEarly = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: farBooking.locator, segmentIndex: 0, channel: "ONLINE" });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.json.error.code).toBe("CHECKIN_NOT_OPEN");
    // the override never bypasses "not yet open"
    const earlyOverride = await staff.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: farBooking.locator, segmentIndex: 0, channel: "AIRPORT", override: true });
    expect(earlyOverride.status).toBe(409);

    const near = await createFlightViaApi(staff, { hoursAhead: 0.3 });
    const nearBooking = await bookAndTicket(alice, near.flightId, "M");
    const late = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: nearBooking.locator, segmentIndex: 0, channel: "ONLINE" });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("CHECKIN_CLOSED");
    const sneaky = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: nearBooking.locator, segmentIndex: 0, channel: "ONLINE", override: true });
    expect(sneaky.status).toBe(403);
    const atAirport = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: nearBooking.locator, segmentIndex: 0, channel: "AIRPORT" });
    expect(atAirport.status).toBe(403);
    const desk = await staff.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: nearBooking.locator, segmentIndex: 0, channel: "AIRPORT", override: true });
    expect(desk.status).toBe(201);
  });

  it("cannot check in an unpaid (HELD) PNR", async () => {
    const held = await book(alice, fx.flightId, "M");
    const res = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: held.json.pnr.recordLocator, segmentIndex: 0, channel: "ONLINE" });
    expect(res.status).toBe(409);
  });
});

describe("e2e load control limits", () => {
  it("refuses to finalize a load sheet above the aircraft limits, then lets staff fix it and reopen it", async () => {
    const draft = await staff.api.post(r.loadRoute, "/api/flights/:id/load", { cargoWeightKg: 5000, fuelWeightKg: 5000 }, { id: fx.flightId }); // max cargo is 3000
    expect(draft.status).toBe(200);
    expect(draft.json.load.withinLimits).toBe(false);
    const refused = await staff.api.post(r.loadFinalizeRoute, "/api/flights/:id/load/finalize", undefined, { id: fx.flightId });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("LOAD_LIMITS_EXCEEDED");
    expect((await staff.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", undefined, { id: fx.flightId })).status).toBe(409);

    const ok = await finalizeLoadSheet(staff, fx.flightId);
    expect(ok.status).toBe(200);
    const reopened = await staff.api.post(r.loadReopenRoute, "/api/flights/:id/load/reopen", undefined, { id: fx.flightId });
    expect(reopened.json.loadSheetStatus).toBe("DRAFT");
    expect((await staff.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", undefined, { id: fx.flightId })).status).toBe(409);
  });
});

describe("e2e cancellation after check-in: DCS refuses passengers whose ticket is not ISSUED", () => {
  async function boardingFlight(passengers: ReturnType<typeof adult>[]) {
    const f = await createFlightViaApi(staff, { hoursAhead: 10 });
    const booking = await bookAndTicket(alice, f.flightId, "M", passengers);
    const checkIns: { id: string; seat: string }[] = [];
    for (const passengerId of booking.passengerIds) {
      const res = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: booking.locator, passengerId, segmentIndex: 0, channel: "ONLINE" });
      expect(res.status).toBe(201);
      checkIns.push({ id: res.json.checkIn._id, seat: res.json.checkIn.seat });
    }
    return { f, booking, checkIns };
  }
  const openBoarding = async (flightId: string) => {
    expect((await finalizeLoadSheet(staff, flightId)).status).toBe(200);
    expect((await staff.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", undefined, { id: flightId })).status).toBe(200);
  };
  const scan = (flightId: string, checkInId: string) =>
    staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId }, { id: flightId });

  it("a cancelled PNR cannot be scanned or boarded even though its check-in still exists", async () => {
    const { f, booking, checkIns } = await boardingFlight([adult("Gone", "Passenger")]);
    const cancel = await alice.api.post(r.pnrCancelRoute, "/api/pnrs/:locator/cancel", undefined, { locator: booking.locator });
    expect(cancel.status).toBe(200);
    expect(cancel.json).toMatchObject({ ticketsVoided: 1, alreadyCancelled: false });
    expect((await bucketCounters(staff, f.flightId)).buckets.M.sold).toBe(0);

    await openBoarding(f.flightId);
    const refused = await scan(f.flightId, checkIns[0].id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("TICKET_NOT_VALID");

    // and by barcode
    const bp = await alice.api.get(r.bpRoute, "/api/boarding-passes/:checkInId", { checkInId: checkIns[0].id });
    const byBarcode = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { barcode: bp.json.boardingPass.barcode }, { id: f.flightId });
    expect(byBarcode.status).toBe(409);
    expect(byBarcode.json.error.code).toBe("TICKET_NOT_VALID");

    const manifest = await staff.api.get(r.boardingRoute, "/api/flights/:id/boarding", { id: f.flightId });
    expect(manifest.json.counts.boarded).toBe(0);
  });

  it("a voided ticket is refused at the gate, its seat is not released a second time at close, and the other passenger boards", async () => {
    const { f, booking, checkIns } = await boardingFlight([adult("Void", "Me"), adult("Keep", "Me")]);
    expect((await bucketCounters(staff, f.flightId)).buckets.M.sold).toBe(2);

    const voided = await staff.api.post(r.ticketVoidRoute, "/api/tickets/:ticketNumber/void", { reason: "duplicate" }, { ticketNumber: booking.tickets.find((t) => t.passengerId === booking.passengerIds[0])!.ticketNumber });
    expect(voided.status).toBe(200);
    expect(voided.json.ticket.status).toBe("VOID");
    expect(voided.json.pnr.status).toBe("TICKETED"); // one valid ticket remains
    expect((await bucketCounters(staff, f.flightId)).buckets.M.sold).toBe(1);

    await openBoarding(f.flightId);
    const refused = await scan(f.flightId, checkIns[0].id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("TICKET_NOT_VALID");
    expect((await scan(f.flightId, checkIns[1].id)).status).toBe(200);

    const close = await staff.api.post(r.boardingCloseRoute, "/api/flights/:id/boarding/close", undefined, { id: f.flightId });
    expect(close.status).toBe(200);
    expect(close.json.summary.boarded).toBe(1);
    expect(close.json.summary.noShows.checkedInNotBoarded).toBe(1);
    // the voided ticket's seat was already returned when it was voided: nothing else is released
    expect(close.json.summary.seatsReleased).toEqual([]);
    expect((await bucketCounters(staff, f.flightId)).buckets.M.sold).toBe(1);

    const depart = await staff.api.post(r.boardingDepartRoute, "/api/flights/:id/boarding/depart", undefined, { id: f.flightId });
    expect(depart.json.result).toMatchObject({ boarded: 1, ticketsUsed: 1 });
    expect(await Ticket.countDocuments({ status: "VOID" })).toBe(1);
  });

  it("a cancelled PNR cannot be checked in afterwards", async () => {
    const f = await createFlightViaApi(staff, { hoursAhead: 10 });
    const booking = await bookAndTicket(alice, f.flightId, "M");
    expect((await alice.api.post(r.pnrCancelRoute, "/api/pnrs/:locator/cancel", undefined, { locator: booking.locator })).status).toBe(200);
    const res = await alice.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: booking.locator, segmentIndex: 0, channel: "ONLINE" });
    expect(res.status).toBe(409);
  });
});



