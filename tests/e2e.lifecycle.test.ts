import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { startDcsDB } from "./helpers/dcs";
import {
  CONTACT,
  adult,
  bookAndTicket,
  bucketCounters,
  client,
  createFlightViaApi,
  makePassenger,
  makeStaff,
  payOk,
  r,
  type Actor,
  type FlightFixture,
} from "./helpers/e2e";

/**
 * One story through the REAL route handlers (real Requests, real JWTs from /api/auth/login, in-memory MongoDB):
 * staff set up -> passenger books and pays -> check-in -> bags -> load control -> boarding -> departure.
 * The `it`s run in order and share state.
 */
let staff: Actor;
let pax: Actor;
let fx: FlightFixture;

// PNR 1: the passenger's own booking (2 adults + 1 lap infant, class M)
let locator = "";
let passengerIds: string[] = [];
let ticketNumbers: string[] = [];
const checkIns: { id: string; barcode: string; seat: string }[] = [];
// PNR 2: staff books for the passenger (class Q), checks in at the desk, never boards. PNR 3: never checks in.
let noShowLocator = "";
let neverLocator = "";
let noShowCheckInId = "";
let bag1 = "";
let bag2 = "";

beforeAll(async () => {
  await startDcsDB();
  await clearTestDB();
});
afterAll(stopTestDB);

describe("e2e lifecycle: staff set-up", () => {
  it("staff logs in and sees their identity", async () => {
    staff = await makeStaff();
    const me = await staff.api.get(r.meRoute, "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ email: staff.email, role: "staff" });
  });

  it("staff creates an aircraft, a flight with inventory and fares", async () => {
    fx = await createFlightViaApi(staff, { hoursAhead: 10 });

    const aircraft = await staff.api.get(r.aircraftRoute, "/api/aircraft");
    expect(aircraft.json.total).toBe(1);
    expect(aircraft.json.data[0].capacity).toBe(20); // derived from the cabin layouts

    const flight = await staff.api.get(r.flightRoute, "/api/flights/:id", { id: fx.flightId });
    expect(flight.json.flight).toMatchObject({ status: "SCHEDULED", origin: "MNL", destination: "CEB", boardingOpen: false });

    const fares = await staff.api.get(r.faresRoute, `/api/fares?flightId=${fx.flightId}`);
    expect(fares.json.total).toBe(4);

    const { buckets, inventory } = await bucketCounters(staff, fx.flightId);
    expect(inventory.capacity).toBe(20);
    expect(buckets.M).toMatchObject({ sold: 0, held: 0, available: 10, open: true });
    expect(buckets.Q.available).toBe(4);
  });
});

describe("e2e lifecycle: passenger books and pays", () => {
  it("registers (duplicate rejected) and logs in", async () => {
    pax = await makePassenger("lifecycle@e2e.test", "Life Cycle");
    const again = await client().post(r.registerRoute, "/api/auth/register", { email: "lifecycle@e2e.test", password: "Passenger123!", name: "Dup" });
    expect(again.status).toBe(409);
    const me = await pax.api.get(r.meRoute, "/api/auth/me");
    expect(me.json.user).toMatchObject({ email: "lifecycle@e2e.test", role: "passenger" });
  });

  it("searches flights and sees open fares (public endpoints)", async () => {
    const res = await client().get(r.searchRoute, `/api/flights/search?from=MNL&to=CEB&date=${fx.date}&passengers=3`);
    expect(res.status).toBe(200);
    const found = res.json.flights.find((f: { id: string }) => f.id === fx.flightId);
    expect(found).toBeTruthy();
    expect(found.lowestFare).toMatchObject({ bookingClass: "Q", price: 80 });
    expect(Object.keys(found.fares).sort()).toEqual(["J", "Y"]);

    const fares = await client().get(r.flightFaresRoute, "/api/flights/:id/fares?passengers=2", { id: fx.flightId });
    expect(fares.json.fares.map((f: { bookingClass: string }) => f.bookingClass)).toEqual(["Q", "M", "Y", "J"]);
  });

  it("books a PNR: seats are HELD for the adults only (the infant holds none)", async () => {
    const res = await pax.api.post(r.pnrsRoute, "/api/pnrs", {
      passengers: [adult("Juan", "Cruz"), adult("Maria", "Cruz"), { firstName: "Baby", lastName: "Cruz", type: "INFANT" }],
      segments: [{ flightId: fx.flightId, bookingClass: "M" }],
      contact: CONTACT,
    });
    expect(res.status).toBe(201);
    expect(res.json.pnr).toMatchObject({ status: "HELD", totalAmount: 240, currency: "USD" });
    expect(res.json.pnr.recordLocator).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    locator = res.json.pnr.recordLocator;
    passengerIds = res.json.pnr.passengers.map((p: { id: string }) => p.id);

    expect((await bucketCounters(staff, fx.flightId)).buckets.M).toMatchObject({ held: 2, sold: 0, available: 8 });
    const own = await pax.api.get(r.pnrsRoute, "/api/pnrs");
    expect(own.json.total).toBe(1);
  });

  it("a declined payment keeps the booking held; a successful one issues tickets (idempotent)", async () => {
    const declined = await pax.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", { payment: { method: "card", simulate: "fail" } }, { locator });
    expect(declined.status).toBe(402);
    expect(declined.json.error.code).toBe("PAYMENT_FAILED");
    expect((await pax.api.get(r.pnrRoute, "/api/pnrs/:locator", { locator })).json.pnr.status).toBe("HELD");

    const noPayment = await pax.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", undefined, { locator });
    expect(noPayment.status).toBe(400); // passengers must pay

    const paid = await pax.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", payOk, { locator });
    expect(paid.status).toBe(201);
    expect(paid.json.pnr.status).toBe("TICKETED");
    expect(paid.json.payment).toMatchObject({ status: "PAID", amount: 240, method: "card" });
    expect(paid.json.alreadyIssued).toBe(false);
    expect(paid.json.tickets).toHaveLength(3);
    for (const t of paid.json.tickets) expect(t.ticketNumber).toMatch(/^123\d{10}$/);
    ticketNumbers = paid.json.tickets.map((t: { ticketNumber: string }) => t.ticketNumber);

    const again = await pax.api.post(r.pnrTicketsRoute, "/api/pnrs/:locator/tickets", payOk, { locator });
    expect(again.status).toBe(200);
    expect(again.json.alreadyIssued).toBe(true);

    expect((await bucketCounters(staff, fx.flightId)).buckets.M).toMatchObject({ held: 0, sold: 2, available: 8 });
  });

  it("staff views the PNR and its tickets", async () => {
    const view = await staff.api.get(r.pnrRoute, "/api/pnrs/:locator", { locator });
    expect(view.status).toBe(200);
    expect(view.json.pnr.status).toBe("TICKETED");
    expect(view.json.pnr.segments[0].flight.flightNumber).toBe(fx.flightNumber);
    expect(view.json.tickets).toHaveLength(3);
    const one = await staff.api.get(r.ticketRoute, "/api/tickets/:ticketNumber", { ticketNumber: ticketNumbers[0] });
    expect(one.json.ticket).toMatchObject({ status: "ISSUED", pnrLocator: locator });
    const list = await staff.api.get(r.pnrsRoute, `/api/pnrs?locator=${locator}`);
    expect(list.json.total).toBe(1);
  });

  it("staff books and tickets two more PNRs on the passenger's account (class Q) and tags a bag for one", async () => {
    const second = await bookAndTicket(staff, fx.flightId, "Q", [adult("Pedro", "Reyes")], { ownerEmail: pax.email });
    noShowLocator = second.locator;
    const third = await bookAndTicket(staff, fx.flightId, "Q", [adult("Ana", "Santos")], { ownerEmail: pax.email });
    neverLocator = third.locator;
    expect(second.pnr.ownerUserId).toBe(pax.id);
    expect((await bucketCounters(staff, fx.flightId)).buckets.Q).toMatchObject({ sold: 2, held: 0 });
    expect((await pax.api.get(r.pnrsRoute, "/api/pnrs")).json.total).toBe(3);
  });
});

describe("e2e lifecycle: check-in and boarding passes", () => {
  it("online check-in with a chosen seat, an automatic seat, and an infant without a seat", async () => {
    const seatmapBefore = await pax.api.get(r.seatmapRoute, "/api/flights/:id/seatmap", { id: fx.flightId });
    const y = seatmapBefore.json.seatMap.cabins.find((c: { cabin: string }) => c.cabin === "Y");
    expect(y.totalSeats).toBe(16);
    expect(y.rows[0].seats[0].occupant).toBeUndefined(); // passengers never see other passengers

    // wrong cabin seat is rejected (the ticket is economy; 1A is business)
    const wrongCabin = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[0], segmentIndex: 0, seat: "1A", channel: "ONLINE" });
    expect(wrongCabin.status).toBe(400);

    const first = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[0], segmentIndex: 0, seat: "2C", channel: "ONLINE" });
    expect(first.status).toBe(201);
    expect(first.json.checkIn).toMatchObject({ seat: "2C", boardingSequence: 1, status: "CHECKED_IN", channel: "ONLINE" });
    expect(first.json.boardingPass.barcode).toMatch(/^M1/);
    checkIns.push({ id: first.json.checkIn._id, barcode: first.json.boardingPass.barcode, seat: "2C" });

    const dup = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[0], segmentIndex: 0, channel: "ONLINE" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("ALREADY_CHECKED_IN");

    const taken = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[1], segmentIndex: 0, seat: "2C", channel: "ONLINE" });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("SEAT_TAKEN");

    const auto = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[1], segmentIndex: 0, channel: "ONLINE" });
    expect(auto.status).toBe(201);
    expect(auto.json.checkIn.seat).toBe("2A"); // first free economy seat
    expect(auto.json.checkIn.boardingSequence).toBe(2);
    checkIns.push({ id: auto.json.checkIn._id, barcode: auto.json.boardingPass.barcode, seat: "2A" });

    const infantSeat = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[2], segmentIndex: 0, seat: "2B", channel: "ONLINE" });
    expect(infantSeat.status).toBe(400);
    const infant = await pax.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: locator, passengerId: passengerIds[2], segmentIndex: 0, channel: "ONLINE" });
    expect(infant.status).toBe(201);
    expect(infant.json.checkIn.seat).toBe("INF-3");
    expect(infant.json.boardingPass.seat).toBe("INF");
    checkIns.push({ id: infant.json.checkIn._id, barcode: infant.json.boardingPass.barcode, seat: "INF-3" });

    const seatmapAfter = await staff.api.get(r.seatmapRoute, "/api/flights/:id/seatmap", { id: fx.flightId });
    const yAfter = seatmapAfter.json.seatMap.cabins.find((c: { cabin: string }) => c.cabin === "Y");
    expect(yAfter.availableSeats).toBe(14); // the infant takes no seat
    const taken2C = yAfter.rows[0].seats.find((s: { seat: string }) => s.seat === "2C");
    expect(taken2C).toMatchObject({ status: "OCCUPIED", occupant: { pnrLocator: locator } });
  });

  it("staff checks in the second PNR at the airport desk", async () => {
    const res = await staff.api.post(r.checkinRoute, "/api/checkin", { pnrLocator: noShowLocator, segmentIndex: 0, channel: "AIRPORT" });
    expect(res.status).toBe(201);
    expect(res.json.checkIn.channel).toBe("AIRPORT");
    noShowCheckInId = res.json.checkIn._id;
  });

  it("the passenger downloads the boarding passes; staff sees the check-in list", async () => {
    const one = await pax.api.get(r.bpRoute, "/api/boarding-passes/:checkInId", { checkInId: checkIns[0].id });
    expect(one.status).toBe(200);
    expect(one.json.boardingPass).toMatchObject({ pnrLocator: locator, seat: "2C", flightNumber: fx.flightNumber, boardingSequence: 1, checkInStatus: "CHECKED_IN" });
    expect(one.json.boardingPass.barcode).toBe(checkIns[0].barcode);

    const all = await pax.api.get(r.bpListRoute, `/api/boarding-passes?pnr=${locator}`);
    expect(all.json.boardingPasses).toHaveLength(3);

    const list = await staff.api.get(r.checkinRoute, `/api/checkin?flightId=${fx.flightId}`);
    expect(list.json.total).toBe(4);
  });
});

describe("e2e lifecycle: baggage", () => {
  it("staff tags bags, excess needs acceptance, and bags move through their statuses", async () => {
    const first = await staff.api.post(r.baggageRoute, "/api/baggage", { checkInId: checkIns[0].id, weightKg: 15 });
    expect(first.status).toBe(201);
    expect(first.json.baggage).toMatchObject({ status: "CHECKED", weightKg: 15, excess: false, allowanceKg: 20 });
    expect(first.json.baggage.tagNumber).toMatch(/^PS\d{10}$/);
    bag1 = first.json.baggage.tagNumber;

    const over = await staff.api.post(r.baggageRoute, "/api/baggage", { checkInId: checkIns[0].id, weightKg: 10 });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("BAGGAGE_OVER_ALLOWANCE");

    const accepted = await staff.api.post(r.baggageRoute, "/api/baggage", { checkInId: checkIns[0].id, weightKg: 10, acceptExcess: true });
    expect(accepted.status).toBe(201);
    expect(accepted.json.baggage).toMatchObject({ excess: true, excessKg: 5 });
    bag2 = accepted.json.baggage.tagNumber;

    const skip = await staff.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "LOADED" }, { tag: bag1 });
    expect(skip.status).toBe(409); // CHECKED -> LOADED is not allowed
    expect((await staff.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "SCREENED" }, { tag: bag1 })).json.baggage.status).toBe("SCREENED");
    const loaded = await staff.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "LOADED" }, { tag: bag1 });
    expect(loaded.json.baggage.status).toBe("LOADED");
    expect(loaded.json.baggage.history.map((h: { status: string }) => h.status)).toEqual(["CHECKED", "SCREENED", "LOADED"]);

    // the excess bag is offloaded again (final state)
    expect((await staff.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "OFFLOADED" }, { tag: bag2 })).json.baggage.status).toBe("OFFLOADED");
    expect((await staff.api.patch(r.baggageTagRoute, "/api/baggage/:tag", { status: "SCREENED" }, { tag: bag2 })).status).toBe(409);

    // the passenger can follow their own bags
    const mine = await pax.api.get(r.baggageRoute, `/api/baggage?pnr=${locator}`);
    expect(mine.json.total).toBe(2);
    expect((await pax.api.get(r.baggageTagRoute, "/api/baggage/:tag", { tag: bag1 })).json.baggage.status).toBe("LOADED");

    // a bag for the no-show passenger: offloaded automatically when boarding closes
    const noShowBag = await staff.api.post(r.baggageRoute, "/api/baggage", { pnrLocator: noShowLocator, weightKg: 12 });
    expect(noShowBag.status).toBe(201);
  });
});

describe("e2e lifecycle: load control, boarding, departure", () => {
  it("load control: live draft, then finalize", async () => {
    const live = await staff.api.get(r.loadRoute, "/api/flights/:id/load", { id: fx.flightId });
    expect(live.status).toBe(200);
    expect(live.json.loadSheetStatus).toBeNull();
    expect(live.json.load).toMatchObject({ adults: 3, infants: 1, passengerCount: 3, passengerWeightKg: 252, baggageCount: 2, baggageWeightKg: 27, withinLimits: true });

    // boarding cannot open without a FINAL load sheet
    const early = await staff.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", { gate: "b2" }, { id: fx.flightId });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("LOAD_SHEET_NOT_FINAL");

    const draft = await staff.api.post(r.loadRoute, "/api/flights/:id/load", { cargoWeightKg: 500, fuelWeightKg: 5000 }, { id: fx.flightId });
    expect(draft.status).toBe(200);
    expect(draft.json.loadSheetStatus).toBe("DRAFT");
    expect(draft.json.load).toMatchObject({ cargoWeightKg: 500, fuelWeightKg: 5000, zeroFuelWeightKg: 42_000 + 252 + 27 + 500, takeoffWeightKg: 42_000 + 252 + 27 + 500 + 5000 });

    const done = await staff.api.post(r.loadFinalizeRoute, "/api/flights/:id/load/finalize", undefined, { id: fx.flightId });
    expect(done.status).toBe(200);
    expect(done.json.loadSheetStatus).toBe("FINAL");
    expect(done.json.loadSheet.finalizedBy).toBe(staff.id);
    expect((await staff.api.post(r.loadFinalizeRoute, "/api/flights/:id/load/finalize", undefined, { id: fx.flightId })).status).toBe(409);
  });

  it("opens boarding: the gate shows on boarding passes and scanning is staff-only", async () => {
    const scanBefore = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId: checkIns[0].id }, { id: fx.flightId });
    expect(scanBefore.status).toBe(409);
    expect(scanBefore.json.error.code).toBe("BOARDING_NOT_OPEN");

    const open = await staff.api.post(r.boardingOpenRoute, "/api/flights/:id/boarding/open", { gate: "b2" }, { id: fx.flightId });
    expect(open.status).toBe(200);
    expect(open.json.flight).toMatchObject({ status: "BOARDING", boardingOpen: true, gate: "B2" });

    const bp = await pax.api.get(r.bpRoute, "/api/boarding-passes/:checkInId", { checkInId: checkIns[0].id });
    expect(bp.json.boardingPass.gate).toBe("B2");

    const manifest = await staff.api.get(r.boardingRoute, "/api/flights/:id/boarding", { id: fx.flightId });
    expect(manifest.json.counts).toMatchObject({ ticketed: 5, checkedIn: 4, boarded: 0, notYetBoarded: 4, notCheckedIn: 1 });

    const asPax = await pax.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId: checkIns[0].id }, { id: fx.flightId });
    expect(asPax.status).toBe(403);
  });

  it("scans boarding passes (barcode and check-in id); a second scan is 409", async () => {
    const scan = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { barcode: checkIns[0].barcode }, { id: fx.flightId });
    expect(scan.status).toBe(200);
    expect(scan.json).toMatchObject({ result: "BOARDED", pnrLocator: locator, seat: "2C", boardingSequence: 1, passengerName: "CRUZ/JUAN" });

    const dbl = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { barcode: checkIns[0].barcode }, { id: fx.flightId });
    expect(dbl.status).toBe(409);
    expect(dbl.json.error.code).toBe("ALREADY_BOARDED");

    for (const c of checkIns.slice(1)) {
      const ok = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId: c.id }, { id: fx.flightId });
      expect(ok.status).toBe(200);
    }
    const bogus = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { barcode: "M1NOPE/NOBODY         EXXXXXX MNLCEBPS 0101 001Y001A0001 100" }, { id: fx.flightId });
    expect([404, 400]).toContain(bogus.status);

    const manifest = await staff.api.get(r.boardingRoute, "/api/flights/:id/boarding", { id: fx.flightId });
    expect(manifest.json.counts).toMatchObject({ boarded: 3, notYetBoarded: 1, notCheckedIn: 1, noShowCandidates: 2 });
    // the passenger cannot cancel the check-in of someone who boarded
    const cancelBoarded = await pax.api.post(r.checkinCancelRoute, "/api/checkin/:id/cancel", undefined, { id: checkIns[0].id });
    expect(cancelBoarded.status).toBe(409);
  });

  it("closes boarding: no-shows are recorded, their seats return to inventory and their bags are offloaded", async () => {
    const close = await staff.api.post(r.boardingCloseRoute, "/api/flights/:id/boarding/close", undefined, { id: fx.flightId });
    expect(close.status).toBe(200);
    expect(close.json.summary).toMatchObject({
      status: "CLOSED",
      boarded: 3,
      noShows: { checkedInNotBoarded: 1, notCheckedIn: 1, total: 2 },
      baggageOffloaded: 1,
      seatsReleased: [{ cabin: "Y", bucketClass: "Q", seats: 2 }],
    });

    const { buckets } = await bucketCounters(staff, fx.flightId);
    expect(buckets.Q.sold).toBe(0);
    expect(buckets.M.sold).toBe(2); // the boarded passengers keep their seats

    const noShow = await staff.api.get(r.checkinRoute, `/api/checkin?pnr=${noShowLocator}`);
    expect(noShow.json.checkIns[0]).toMatchObject({ _id: noShowCheckInId, status: "NO_SHOW" });
    const bags = await staff.api.get(r.baggageRoute, `/api/baggage?pnr=${noShowLocator}`);
    expect(bags.json.baggage[0].status).toBe("OFFLOADED");
    expect((await pax.api.get(r.bpRoute, "/api/boarding-passes/:checkInId", { checkInId: noShowCheckInId })).status).toBe(409);
    expect(neverLocator).not.toBe("");

    const late = await staff.api.post(r.boardingScanRoute, "/api/flights/:id/boarding/scan", { checkInId: checkIns[0].id }, { id: fx.flightId });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("BOARDING_NOT_OPEN");
  });

  it("departs the flight: boarded passengers' tickets become USED", async () => {
    const depart = await staff.api.post(r.boardingDepartRoute, "/api/flights/:id/boarding/depart", undefined, { id: fx.flightId });
    expect(depart.status).toBe(200);
    expect(depart.json.result).toMatchObject({ status: "DEPARTED", boarded: 3, ticketsUsed: 3 });

    expect((await staff.api.get(r.flightRoute, "/api/flights/:id", { id: fx.flightId })).json.flight.status).toBe("DEPARTED");
    expect((await pax.api.get(r.ticketRoute, "/api/tickets/:ticketNumber", { ticketNumber: ticketNumbers[0] })).json.ticket.status).toBe("USED");
    expect((await staff.api.post(r.boardingDepartRoute, "/api/flights/:id/boarding/depart", undefined, { id: fx.flightId })).status).toBe(409);

    // a flown PNR can no longer be cancelled
    const cancel = await pax.api.post(r.pnrCancelRoute, "/api/pnrs/:locator/cancel", undefined, { locator });
    expect(cancel.status).toBe(409);
    // and the flight can no longer be booked
    const rebook = await pax.api.post(r.pnrsRoute, "/api/pnrs", { passengers: [adult()], segments: [{ flightId: fx.flightId, bookingClass: "M" }], contact: CONTACT });
    expect(rebook.status).toBe(409);
  });
});
