import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listAircraftRoute, POST as createAircraftRoute } from "@/app/api/aircraft/route";
import { GET as getAircraftRoute, PATCH as patchAircraftRoute } from "@/app/api/aircraft/[id]/route";
import { GET as listFlightsRoute, POST as createFlightRoute } from "@/app/api/flights/route";
import { GET as searchRoute } from "@/app/api/flights/search/route";
import { DELETE as deleteFlightRoute, GET as getFlightRoute, PATCH as patchFlightRoute } from "@/app/api/flights/[id]/route";
import { GET as flightFaresRoute } from "@/app/api/flights/[id]/fares/route";
import { GET as listFaresRoute, POST as createFareRoute } from "@/app/api/fares/route";
import { DELETE as deleteFareRoute, PATCH as patchFareRoute } from "@/app/api/fares/[id]/route";
import { GET as listPnrsRoute, POST as createPnrRoute } from "@/app/api/pnrs/route";
import { GET as getPnrRoute, PATCH as patchPnrRoute } from "@/app/api/pnrs/[locator]/route";
import { POST as cancelPnrRoute } from "@/app/api/pnrs/[locator]/cancel/route";
import { GET as listTicketsRoute, POST as issueTicketsRoute } from "@/app/api/pnrs/[locator]/tickets/route";
import { GET as getTicketRoute } from "@/app/api/tickets/[ticketNumber]/route";
import { POST as voidTicketRoute } from "@/app/api/tickets/[ticketNumber]/void/route";
import { Inventory, PNR, Ticket } from "@/models";
import { getAvailability, setBucket } from "@/modules/inventory/service";
import { expirePnrs } from "@/modules/reservations/pnrs.service";
import { clearTestDB, startTestDB, stopTestDB } from "./helpers/db";
import { DAY, adult, call, makeFlight, makeUser, yConfig, type TestUser } from "./helpers/booking";

// Lets one test force specific ticket-number draws (to exercise collision retry). Passes through otherwise.
const rnd = vi.hoisted(() => ({ queue: [] as number[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomInt = ((...args: unknown[]) =>
    rnd.queue.length > 0 && args.length === 2
      ? rnd.queue.shift()!
      : (actual.randomInt as (...a: unknown[]) => unknown)(...args)) as typeof actual.randomInt;
  return { ...actual, default: { ...actual, randomInt }, randomInt };
});

let staff: TestUser;
let alice: TestUser;
let bob: TestUser;

beforeAll(startTestDB);
afterAll(stopTestDB);
beforeEach(async () => {
  rnd.queue.length = 0;
  await clearTestDB();
  staff = await makeUser("staff", "staff@airline.test");
  alice = await makeUser("passenger", "alice@airline.test");
  bob = await makeUser("passenger", "bob@airline.test");
});

const bucketOf = async (flightId: string, cls: string) =>
  (await getAvailability(flightId)).cabins.flatMap((c) => c.buckets).find((b) => b.class === cls)!;

const payOk = { payment: { method: "card", simulate: "success" } };

function bookBody(flightId: string, bookingClass = "Q", passengers: object[] = [adult()], extra: Record<string, unknown> = {}) {
  return {
    passengers,
    segments: [{ flightId, bookingClass }],
    contact: { email: "juan@example.com", phone: "+639171234567" },
    ...extra,
  };
}

async function book(user: TestUser, flightId: string, bookingClass = "Q", passengers: object[] = [adult()], extra: Record<string, unknown> = {}) {
  return call(createPnrRoute, "POST", "/api/pnrs", { token: user.token, body: bookBody(flightId, bookingClass, passengers, extra) });
}

const issue = (user: TestUser, locator: string, body: unknown = payOk) =>
  call(issueTicketsRoute, "POST", `/api/pnrs/${locator}/tickets`, { token: user.token, body, params: { locator } });

describe("full booking flow (via routes)", () => {
  it("staff builds the schedule, passenger searches, books, pays, and cancels with seats released", async () => {
    // --- staff setup through the API ---
    const ac = await call(createAircraftRoute, "POST", "/api/aircraft", {
      token: staff.token,
      body: {
        type: "A320",
        registration: "ps-a320",
        cabins: [{ cabin: "Y", firstRow: 1, lastRow: 5, seatLetters: ["A", "B", "C", "D"] }],
        operatingEmptyWeightKg: 42000,
        maxZeroFuelWeightKg: 62500,
        maxTakeoffWeightKg: 78000,
        maxPayloadKg: 20000,
        maxCargoWeightKg: 3000,
      },
    });
    expect(ac.status).toBe(201);
    expect(ac.json.aircraft).toMatchObject({ registration: "PS-A320", capacity: 20 });

    const departure = new Date(Date.now() + 10 * DAY);
    departure.setUTCHours(2, 0, 0, 0);
    const flightRes = await call(createFlightRoute, "POST", "/api/flights", {
      token: staff.token,
      body: {
        flightNumber: "ps101",
        origin: "MNL",
        destination: "CEB",
        departure: departure.toISOString(),
        arrival: new Date(departure.getTime() + 90 * 60_000).toISOString(),
        aircraftId: ac.json.aircraft.id,
        inventory: { cabins: [{ cabin: "Y", buckets: [{ class: "Y" }, { class: "M", authorized: 10 }, { class: "Q", authorized: 5 }] }] },
      },
    });
    expect(flightRes.status).toBe(201);
    const flightId: string = flightRes.json.flight.id;
    expect(flightRes.json.flight.flightNumber).toBe("PS101");
    expect(flightRes.json.inventory.capacity).toBe(20);

    // Route fares (no flightId) for MNL-CEB.
    for (const [bookingClass, price] of [["Y", 220], ["M", 150], ["Q", 90]] as const) {
      const fare = await call(createFareRoute, "POST", "/api/fares", {
        token: staff.token,
        body: { origin: "mnl", destination: "ceb", fareBasis: `${bookingClass}BASIC`, bookingClass, cabin: "Y", price },
      });
      expect(fare.status).toBe(201);
    }

    // --- passenger searches (no auth) ---
    const date = departure.toISOString().slice(0, 10);
    const search = await call(searchRoute, "GET", `/api/flights/search?from=MNL&to=CEB&date=${date}&passengers=2`);
    expect(search.status).toBe(200);
    expect(search.json.count).toBe(1);
    const found = search.json.flights[0];
    expect(found).toMatchObject({ id: flightId, flightNumber: "PS101", origin: "MNL", destination: "CEB", durationMinutes: 90 });
    expect(found.fares.Y).toMatchObject({ bookingClass: "Q", price: 90, seatsAvailable: 5 }); // lowest available fare
    expect(found.lowestFare.price).toBe(90);

    const fares = await call(flightFaresRoute, "GET", `/api/flights/${flightId}/fares`, { params: { id: flightId } });
    expect(fares.json.fares.map((f: { bookingClass: string }) => f.bookingClass)).toEqual(["Q", "M", "Y"]);

    // --- book 2 adults + 1 infant: 2 seats held ---
    const pax = [adult("Juan", "Dela Cruz"), adult("Maria", "Dela Cruz"), { firstName: "Baby", lastName: "Dela Cruz", type: "INFANT" }];
    const created = await book(alice, flightId, "Q", pax);
    expect(created.status).toBe(201);
    const pnr = created.json.pnr;
    expect(pnr).toMatchObject({ status: "HELD", ownerUserId: alice.id, totalAmount: 180, currency: "USD" });
    expect(pnr.recordLocator).toMatch(/^[A-Z2-9]{6}$/);
    expect(new Date(pnr.holdExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(pnr.segments[0]).toMatchObject({ bookingClass: "Q", cabin: "Y", fareAmount: 90, flight: { flightNumber: "PS101" } });
    expect(pnr.passengers).toHaveLength(3);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 2, sold: 0, available: 3 });

    // --- pay and ticket ---
    const locator: string = pnr.recordLocator;
    const ticketed = await issue(alice, locator);
    expect(ticketed.status).toBe(201);
    expect(ticketed.json.pnr.status).toBe("TICKETED");
    expect(ticketed.json.payment).toMatchObject({ method: "card", status: "PAID", amount: 180 });
    expect(ticketed.json.alreadyIssued).toBe(false);
    const tickets = ticketed.json.tickets;
    expect(tickets).toHaveLength(3); // one per passenger (infant included) per segment
    expect(tickets.every((t: { ticketNumber: string; status: string }) => /^123\d{10}$/.test(t.ticketNumber) && t.status === "ISSUED")).toBe(true);
    expect(tickets.filter((t: { fareAmount: number }) => t.fareAmount === 0)).toHaveLength(1); // lap infant
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, sold: 2, available: 3 });
    expect((await PNR.findOne({ recordLocator: locator }))!.holdExpiresAt).toBeUndefined();

    // Repeat call is idempotent.
    const again = await issue(alice, locator);
    expect(again.status).toBe(200);
    expect(again.json.alreadyIssued).toBe(true);
    expect(again.json.tickets.map((t: { ticketNumber: string }) => t.ticketNumber).sort()).toEqual(
      tickets.map((t: { ticketNumber: string }) => t.ticketNumber).sort(),
    );
    expect(await Ticket.countDocuments({ pnrLocator: locator })).toBe(3);

    // Read tickets back.
    const listed = await call(listTicketsRoute, "GET", `/api/pnrs/${locator}/tickets`, { token: alice.token, params: { locator } });
    expect(listed.json.tickets).toHaveLength(3);
    const one = tickets[0].ticketNumber;
    const fetched = await call(getTicketRoute, "GET", `/api/tickets/${one}`, { token: alice.token, params: { ticketNumber: one } });
    expect(fetched.json.ticket.ticketNumber).toBe(one);
    expect((await call(getTicketRoute, "GET", `/api/tickets/${one}`, { token: bob.token, params: { ticketNumber: one } })).status).toBe(403);

    // --- cancel releases the sold seats and voids tickets ---
    const cancelled = await call(cancelPnrRoute, "POST", `/api/pnrs/${locator}/cancel`, { token: alice.token, params: { locator } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ ticketsVoided: 3, alreadyCancelled: false });
    expect(cancelled.json.pnr.status).toBe("CANCELLED");
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, sold: 0, available: 5 });
    expect((await Ticket.find({ pnrLocator: locator })).every((t) => t.status === "VOID")).toBe(true);
    const history = (await PNR.findOne({ recordLocator: locator }))!.history.map((h) => h.action);
    expect(history).toEqual(["CREATED", "TICKETING_STARTED", "TICKETED", "CANCELLED"]);

    // Cancel again is idempotent; ticketing a cancelled PNR is refused.
    expect((await call(cancelPnrRoute, "POST", `/api/pnrs/${locator}/cancel`, { token: alice.token, params: { locator } })).json.alreadyCancelled).toBe(true);
    expect((await issue(alice, locator)).status).toBe(409);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ sold: 0 });
  });

  it("releases held seats when a held PNR is cancelled", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "M");
    expect(await bucketOf(flightId, "M")).toMatchObject({ held: 1 });
    const res = await call(cancelPnrRoute, "POST", `/api/pnrs/${json.pnr.recordLocator}/cancel`, { token: alice.token, params: { locator: json.pnr.recordLocator } });
    expect(res.json).toMatchObject({ heldSeatsReleased: 1, ticketsVoided: 0 });
    expect(await bucketOf(flightId, "M")).toMatchObject({ held: 0, available: 12 });
  });
});

describe("search and fares", () => {
  it("shows the lowest available fare per cabin and hides closed or too-small buckets", async () => {
    const { flightId, flight } = await makeFlight({ inventory: yConfig(10, [{ class: "Y" }, { class: "M", authorized: 3 }, { class: "Q", authorized: 1 }]) });
    const date = flight.departure.toISOString().slice(0, 10);
    const search = (qs: string) => call(searchRoute, "GET", `/api/flights/search?from=MNL&to=CEB&date=${date}&${qs}`);

    expect((await search("passengers=1")).json.flights[0].fares.Y).toMatchObject({ bookingClass: "Q", price: 80 });
    // Q has only 1 seat: for 2 passengers the cheapest sellable is M.
    expect((await search("passengers=2")).json.flights[0].fares.Y).toMatchObject({ bookingClass: "M", price: 120 });
    // Manually close M: for 2 passengers only Y is left.
    await setBucket(flightId, "M", { open: false });
    expect((await search("passengers=2")).json.flights[0].fares.Y).toMatchObject({ bookingClass: "Y", price: 200 });
    // 9 passengers still fit in Y; invalid parameters are 400s.
    expect((await search("passengers=9")).json.flights[0].fares.Y).toMatchObject({ bookingClass: "Y" });
    expect((await search("passengers=12")).status).toBe(400);
    expect((await call(searchRoute, "GET", "/api/flights/search?from=MNL")).status).toBe(400);
    expect((await call(searchRoute, "GET", "/api/flights/search?from=MNL&to=CEB&date=2020-01-01")).json.count).toBe(0);
  });

  it("falls back to route fares when there is no flight fare, preferring flight fares otherwise", async () => {
    const { flightId } = await makeFlight({ fares: false, inventory: yConfig(10, [{ class: "Y" }, { class: "Q" }]) });
    const mk = (body: object) => call(createFareRoute, "POST", "/api/fares", { token: staff.token, body });

    await mk({ origin: "MNL", destination: "CEB", fareBasis: "QROUTE", bookingClass: "Q", price: 100 });
    await mk({ origin: "MNL", destination: "CEB", fareBasis: "YROUTE", bookingClass: "Y", price: 300 });
    let fares = (await call(flightFaresRoute, "GET", `/api/flights/${flightId}/fares`, { params: { id: flightId } })).json.fares;
    expect(fares.map((f: { fareBasis: string }) => f.fareBasis)).toEqual(["QROUTE", "YROUTE"]);
    expect(fares[0].scope).toBe("route");

    // A flight fare takes precedence over the route fare even when it is more expensive.
    const flightFare = await mk({ flightId, fareBasis: "QFLIGHT", bookingClass: "Q", price: 130 });
    fares = (await call(flightFaresRoute, "GET", `/api/flights/${flightId}/fares`, { params: { id: flightId } })).json.fares;
    expect(fares.find((f: { bookingClass: string }) => f.bookingClass === "Q")).toMatchObject({ fareBasis: "QFLIGHT", scope: "flight", price: 130 });

    // Deactivating (DELETE) the flight fare falls back to the route fare again.
    const del = await call(deleteFareRoute, "DELETE", `/api/fares/${flightFare.json.fare.id}`, { token: staff.token, params: { id: flightFare.json.fare.id } });
    expect(del.json.fare.active).toBe(false);
    fares = (await call(flightFaresRoute, "GET", `/api/flights/${flightId}/fares`, { params: { id: flightId } })).json.fares;
    expect(fares.find((f: { bookingClass: string }) => f.bookingClass === "Q").fareBasis).toBe("QROUTE");

    const patched = await call(patchFareRoute, "PATCH", `/api/fares/${flightFare.json.fare.id}`, { token: staff.token, body: { price: 55, rules: { refundable: true }, active: true }, params: { id: flightFare.json.fare.id } });
    expect(patched.json.fare).toMatchObject({ price: 55, active: true, rules: { refundable: true, changeable: false, checkedBaggageKg: 20 } });
  });

  it("restricts fare management to staff and paginates", async () => {
    const { flightId } = await makeFlight();
    expect((await call(listFaresRoute, "GET", "/api/fares", { token: alice.token })).status).toBe(403);
    expect((await call(createFareRoute, "POST", "/api/fares", { token: alice.token, body: { flightId, fareBasis: "X", bookingClass: "Y", price: 1 } })).status).toBe(403);
    expect((await call(createFareRoute, "POST", "/api/fares", { token: staff.token, body: { fareBasis: "X", bookingClass: "Y", price: 1 } })).status).toBe(400);
    const page = await call(listFaresRoute, "GET", "/api/fares?limit=3&page=2", { token: staff.token });
    expect(page.json).toMatchObject({ page: 2, limit: 3, total: 4, totalPages: 2 });
    expect(page.json.data).toHaveLength(1);
  });
});

describe("access control", () => {
  it("keeps PNRs private to their owner (staff see all) and restricts schedule writes to staff", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId);
    const locator: string = json.pnr.recordLocator;
    const params = { locator };

    expect((await call(getPnrRoute, "GET", `/api/pnrs/${locator}`, { params })).status).toBe(401);
    expect((await call(getPnrRoute, "GET", `/api/pnrs/${locator}`, { token: bob.token, params })).status).toBe(403);
    expect((await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: bob.token, body: { contact: { phone: "+63900000000" } }, params })).status).toBe(403);
    expect((await call(cancelPnrRoute, "POST", `/api/pnrs/${locator}/cancel`, { token: bob.token, params })).status).toBe(403);
    expect((await issue(bob, locator)).status).toBe(403);
    expect((await call(listTicketsRoute, "GET", `/api/pnrs/${locator}/tickets`, { token: bob.token, params })).status).toBe(403);
    expect((await call(getPnrRoute, "GET", `/api/pnrs/${locator}`, { token: alice.token, params })).status).toBe(200);
    expect((await call(getPnrRoute, "GET", `/api/pnrs/${locator.toLowerCase()}`, { token: staff.token, params: { locator: locator.toLowerCase() } })).status).toBe(200);
    expect((await call(getPnrRoute, "GET", "/api/pnrs/ZZZZZZ", { token: staff.token, params: { locator: "ZZZZZZ" } })).status).toBe(404);

    // Lists are scoped to the caller for passengers.
    await book(bob, flightId, "M");
    const mine = await call(listPnrsRoute, "GET", "/api/pnrs", { token: alice.token });
    expect(mine.json.total).toBe(1);
    expect(mine.json.data[0].recordLocator).toBe(locator);
    expect((await call(listPnrsRoute, "GET", `/api/pnrs?ownerUserId=${bob.id}`, { token: alice.token })).json.total).toBe(1); // filter ignored for passengers
    const all = await call(listPnrsRoute, "GET", "/api/pnrs", { token: staff.token });
    expect(all.json.total).toBe(2);
    expect((await call(listPnrsRoute, "GET", `/api/pnrs?ownerUserId=${bob.id}`, { token: staff.token })).json.total).toBe(1);
    expect((await call(listPnrsRoute, "GET", "/api/pnrs?status=TICKETED", { token: staff.token })).json.total).toBe(0);
    expect((await call(listPnrsRoute, "GET", `/api/pnrs?flightId=${flightId}&limit=1`, { token: staff.token })).json).toMatchObject({ total: 2, totalPages: 2 });

    // Staff may book for a passenger.
    const onBehalf = await call(createPnrRoute, "POST", "/api/pnrs", { token: staff.token, body: bookBody(flightId, "Y", [adult()], { ownerEmail: bob.email }) });
    expect(onBehalf.json.pnr.ownerUserId).toBe(bob.id);
    // ...but passengers cannot.
    expect((await book(alice, flightId, "Y", [adult()], { ownerUserId: bob.id })).status).toBe(403);
    expect((await call(createPnrRoute, "POST", "/api/pnrs", { body: bookBody(flightId) })).status).toBe(401);
  });

  it("only lets staff write flights, aircraft and fares; any user can read flights", async () => {
    const { flightId, flight } = await makeFlight();
    const body = {
      flightNumber: "PS999",
      origin: "MNL",
      destination: "DVO",
      departure: new Date(Date.now() + 5 * DAY).toISOString(),
      arrival: new Date(Date.now() + 5 * DAY + 7_200_000).toISOString(),
      aircraftId: flight.aircraftId.toString(),
    };
    expect((await call(createFlightRoute, "POST", "/api/flights", { body })).status).toBe(401);
    expect((await call(createFlightRoute, "POST", "/api/flights", { token: alice.token, body })).status).toBe(403);
    expect((await call(patchFlightRoute, "PATCH", `/api/flights/${flightId}`, { token: alice.token, body: { gate: "A1" }, params: { id: flightId } })).status).toBe(403);
    expect((await call(deleteFlightRoute, "DELETE", `/api/flights/${flightId}`, { token: alice.token, params: { id: flightId } })).status).toBe(403);
    expect((await call(listAircraftRoute, "GET", "/api/aircraft", { token: alice.token })).status).toBe(403);
    expect((await call(createAircraftRoute, "POST", "/api/aircraft", { token: alice.token, body: {} })).status).toBe(403);
    expect((await call(getAircraftRoute, "GET", `/api/aircraft/${flight.aircraftId}`, { token: alice.token, params: { id: flight.aircraftId.toString() } })).status).toBe(403);

    expect((await call(createFlightRoute, "POST", "/api/flights", { token: staff.token, body })).status).toBe(201);
    expect((await call(createFlightRoute, "POST", "/api/flights", { token: staff.token, body })).status).toBe(409); // same number + departure
    expect((await call(createFlightRoute, "POST", "/api/flights", { token: staff.token, body: { ...body, flightNumber: "PS998", arrival: body.departure } })).status).toBe(400);

    const list = await call(listFlightsRoute, "GET", "/api/flights?origin=MNL&limit=1", { token: alice.token });
    expect(list.json).toMatchObject({ total: 2, limit: 1, totalPages: 2 });
    expect((await call(listFlightsRoute, "GET", "/api/flights?destination=DVO", { token: alice.token })).json.total).toBe(1);
    expect((await call(getFlightRoute, "GET", `/api/flights/${flightId}`, { token: alice.token, params: { id: flightId } })).json.flight.flightNumber).toBe("PS101");
    expect((await call(getFlightRoute, "GET", "/api/flights/not-an-id", { token: alice.token, params: { id: "not-an-id" } })).status).toBe(400);

    const ac = await call(patchAircraftRoute, "PATCH", `/api/aircraft/${flight.aircraftId}`, { token: staff.token, body: { type: "A321" }, params: { id: flight.aircraftId.toString() } });
    expect(ac.json.aircraft.type).toBe("A321");
    expect((await call(listAircraftRoute, "GET", "/api/aircraft", { token: staff.token })).json.total).toBe(1);
  });
});

describe("overbooking protection at the booking API", () => {
  it("7 concurrent single-seat bookings against 5 seats: 5 succeed, 2 get 409", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y" }, { class: "Q", authorized: 5 }]) });
    const users = await Promise.all(Array.from({ length: 7 }, (_, i) => makeUser("passenger", `c${i}@airline.test`)));
    const results = await Promise.all(users.map((u) => book(u, flightId, "Q")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 5, available: 0 });
    // Losers leave no orphan PNRs behind.
    expect(await PNR.countDocuments()).toBe(5);
  });

  it("rejects a party larger than the remaining seats and leaves inventory untouched", async () => {
    const { flightId } = await makeFlight({ inventory: yConfig(10, [{ class: "Y" }, { class: "Q", authorized: 2 }]) });
    const res = await book(alice, flightId, "Q", [adult("A", "One"), adult("B", "Two"), adult("C", "Three")]);
    expect(res.status).toBe(409);
    expect(res.json.error.details).toMatchObject({ reason: "INSUFFICIENT_SEATS", available: 2 });
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, available: 2 });
    expect(await PNR.countDocuments()).toBe(0);
  });

  it("rolls back earlier segment holds when a later segment cannot be held", async () => {
    const outbound = await makeFlight({ flightNumber: "PS101", daysAhead: 10 });
    const inbound = await makeFlight({ flightNumber: "PS102", origin: "CEB", destination: "MNL", daysAhead: 12, inventory: yConfig(10, [{ class: "Y" }, { class: "Q", authorized: 1 }]) });
    await setBucket(inbound.flightId, "Q", { open: false });
    const res = await call(createPnrRoute, "POST", "/api/pnrs", {
      token: alice.token,
      body: { passengers: [adult()], contact: { email: "a@x.com" }, segments: [{ flightId: outbound.flightId, bookingClass: "Q" }, { flightId: inbound.flightId, bookingClass: "Q" }] },
    });
    expect(res.status).toBe(409);
    expect(await bucketOf(outbound.flightId, "Q")).toMatchObject({ held: 0 });
    expect(await PNR.countDocuments()).toBe(0);
  });

  it("books a round trip and validates passenger mix, segment order and flight status", async () => {
    const out = await makeFlight({ flightNumber: "PS101", daysAhead: 10 });
    const back = await makeFlight({ flightNumber: "PS102", origin: "CEB", destination: "MNL", daysAhead: 12 });
    const body = (segments: object[], passengers: object[] = [adult()]) => ({ passengers, contact: { email: "a@x.com" }, segments });
    const post = (b: object) => call(createPnrRoute, "POST", "/api/pnrs", { token: alice.token, body: b });

    const ok = await post(body([{ flightId: out.flightId, bookingClass: "M" }, { flightId: back.flightId, bookingClass: "M" }]));
    expect(ok.status).toBe(201);
    expect(ok.json.pnr.totalAmount).toBe(240);
    const ticketed = await issue(alice, ok.json.pnr.recordLocator);
    expect(ticketed.json.tickets).toHaveLength(2);
    expect((await bucketOf(out.flightId, "M")).sold).toBe(1);
    expect((await bucketOf(back.flightId, "M")).sold).toBe(1);

    expect((await post(body([{ flightId: back.flightId, bookingClass: "M" }, { flightId: out.flightId, bookingClass: "M" }]))).status).toBe(400); // out of order
    expect((await post(body([{ flightId: out.flightId, bookingClass: "M" }, { flightId: out.flightId, bookingClass: "Y" }]))).status).toBe(400); // duplicate flight
    expect((await post(body([{ flightId: out.flightId, bookingClass: "M" }], [{ firstName: "Kid", lastName: "X", type: "CHILD" }]))).status).toBe(400); // no adult
    expect((await post(body([{ flightId: out.flightId, bookingClass: "M" }], [adult(), { firstName: "B1", lastName: "X", type: "INFANT" }, { firstName: "B2", lastName: "X", type: "INFANT" }]))).status).toBe(400);
    expect((await post(body([{ flightId: out.flightId, bookingClass: "Z" }]))).status).toBe(400); // unknown class
    expect((await post(body([{ flightId: "0123456789abcdef01234567", bookingClass: "M" }]))).status).toBe(404);
    expect((await post(body([]))).status).toBe(400);

  });
});

describe("ticket issuance", () => {
  it("a failed payment returns 402 and leaves the PNR HELD with its seats", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q");
    const locator: string = json.pnr.recordLocator;

    const failed = await issue(alice, locator, { payment: { method: "card", simulate: "fail" } });
    expect(failed.status).toBe(402);
    expect(failed.json.error.code).toBe("PAYMENT_FAILED");

    const pnr = await PNR.findOne({ recordLocator: locator });
    expect(pnr!.status).toBe("HELD");
    expect(pnr!.holdExpiresAt).toBeDefined();
    expect(pnr!.history.map((h) => h.action)).toContain("PAYMENT_FAILED");
    expect(await Ticket.countDocuments({ pnrLocator: locator })).toBe(0);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 1, sold: 0 });

    // Retry succeeds.
    expect((await issue(alice, locator)).status).toBe(201);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, sold: 1 });
  });

  it("requires payment from passengers but not from staff, and validates it", async () => {
    const { flightId } = await makeFlight();
    const first = (await book(alice, flightId, "Q")).json.pnr.recordLocator;
    expect((await issue(alice, first, {})).status).toBe(400);
    expect((await issue(alice, first, { payment: { method: "card", simulate: "maybe" } })).status).toBe(400);
    const staffIssued = await issue(staff, first, {});
    expect(staffIssued.status).toBe(201);
    expect(staffIssued.json.payment.method).toBe("staff-desk");
  });

  it("is safe against a double click: concurrent requests issue exactly one set of tickets", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q", [adult("A", "One"), adult("B", "Two")]);
    const locator: string = json.pnr.recordLocator;
    const results = await Promise.all([issue(alice, locator), issue(alice, locator), issue(alice, locator)]);
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Ticket.countDocuments({ pnrLocator: locator })).toBe(2);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, sold: 2 });
    expect((await PNR.findOne({ recordLocator: locator }))!.status).toBe("TICKETED");
  });

  it("issues unique 13-digit numbers with the airline prefix, retrying on collisions", async () => {
    const { flightId } = await makeFlight();
    const numbers: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const user = await makeUser("passenger", `p${i}@airline.test`);
      const { json } = await book(user, flightId, "Y", [adult("A", "One"), adult("B", "Two")]);
      const res = await issue(user, json.pnr.recordLocator);
      numbers.push(...res.json.tickets.map((t: { ticketNumber: string }) => t.ticketNumber));
    }
    expect(numbers).toHaveLength(12);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers.every((n) => /^\d{13}$/.test(n) && n.startsWith("123"))).toBe(true);

    // Force a collision: the 2nd ticket draws the same serial as the 1st, then a fresh one.
    const user = await makeUser("passenger", "collide@airline.test");
    const { json } = await book(user, flightId, "Y", [adult("A", "One"), adult("B", "Two")]);
    rnd.queue.push(777, 777, 888);
    const res = await issue(user, json.pnr.recordLocator);
    expect(res.status).toBe(201);
    expect(res.json.tickets.map((t: { ticketNumber: string }) => t.ticketNumber).sort()).toEqual(["1230000000777", "1230000000888"]);
  });

  it("voids a ticket (staff only), releasing its seat, and cancels the PNR when all tickets are void", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q", [adult("A", "One"), adult("B", "Two")]);
    const locator: string = json.pnr.recordLocator;
    const [t1, t2] = (await issue(alice, locator)).json.tickets as { ticketNumber: string }[];
    expect(await bucketOf(flightId, "Q")).toMatchObject({ sold: 2 });

    const voidPath = (n: string) => `/api/tickets/${n}/void`;
    expect((await call(voidTicketRoute, "POST", voidPath(t1.ticketNumber), { token: alice.token, params: { ticketNumber: t1.ticketNumber } })).status).toBe(403);

    const v1 = await call(voidTicketRoute, "POST", voidPath(t1.ticketNumber), { token: staff.token, params: { ticketNumber: t1.ticketNumber } });
    expect(v1.status).toBe(200);
    expect(v1.json.ticket.status).toBe("VOID");
    expect(v1.json.pnr.status).toBe("TICKETED"); // one ticket still valid
    expect(await bucketOf(flightId, "Q")).toMatchObject({ sold: 1 });
    expect((await call(voidTicketRoute, "POST", voidPath(t1.ticketNumber), { token: staff.token, params: { ticketNumber: t1.ticketNumber } })).status).toBe(409);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ sold: 1 }); // not released twice

    const v2 = await call(voidTicketRoute, "POST", voidPath(t2.ticketNumber), { token: staff.token, body: { reason: "duplicate booking" }, params: { ticketNumber: t2.ticketNumber } });
    expect(v2.json.pnr.status).toBe("CANCELLED");
    expect(await bucketOf(flightId, "Q")).toMatchObject({ sold: 0, available: 6 });
    expect((await call(voidTicketRoute, "POST", voidPath("123"), { token: staff.token, params: { ticketNumber: "123" } })).status).toBe(400);
    expect((await call(voidTicketRoute, "POST", voidPath("1239999999999"), { token: staff.token, params: { ticketNumber: "1239999999999" } })).status).toBe(404);
  });

  it("refuses to ticket an expired hold", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q");
    const locator: string = json.pnr.recordLocator;
    await PNR.updateOne({ recordLocator: locator }, { holdExpiresAt: new Date(Date.now() - 1000) });
    await Inventory.updateOne({ flightId }, { $set: { "holds.0.expiresAt": new Date(Date.now() - 1000) } });
    const res = await issue(alice, locator);
    expect(res.status).toBe(409);
    expect((await PNR.findOne({ recordLocator: locator }))!.status).toBe("EXPIRED");
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0, sold: 0 });
  });
});

describe("hold expiry on PNRs", () => {
  it("lazily expires a lapsed held PNR on read and releases the seats", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q");
    const locator: string = json.pnr.recordLocator;
    // Make both the PNR hold and the inventory hold look 20 minutes old.
    const past = new Date(Date.now() - 20 * 60_000);
    await PNR.updateOne({ recordLocator: locator }, { holdExpiresAt: past });
    // Simulate an inventory that was *not* swept (e.g. sweeper not yet run): hold still present with old expiry
    await Inventory.updateOne({ flightId }, { $set: { "holds.0.expiresAt": new Date(Date.now() + 60_000) } });

    const res = await call(getPnrRoute, "GET", `/api/pnrs/${locator}`, { token: alice.token, params: { locator } });
    expect(res.status).toBe(200);
    expect(res.json.pnr.status).toBe("EXPIRED");
    expect(res.json.pnr.holdExpiresAt).toBeUndefined();
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0 });
    expect((await Inventory.findOne({ flightId }))!.holds).toHaveLength(0);
    expect((await call(cancelPnrRoute, "POST", `/api/pnrs/${locator}/cancel`, { token: alice.token, params: { locator } })).status).toBe(409);
  });

  it("expirePnrs() sweeps every lapsed hold and PNR", async () => {
    const { flightId } = await makeFlight();
    const a = (await book(alice, flightId, "Q")).json.pnr.recordLocator as string;
    const b = (await book(bob, flightId, "M")).json.pnr.recordLocator as string;
    const swept = await expirePnrs(new Date(Date.now() + 16 * 60_000));
    expect(swept).toBe(2);
    expect((await PNR.find({ recordLocator: { $in: [a, b] } })).map((p) => p.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(await bucketOf(flightId, "Q")).toMatchObject({ held: 0 });
    expect(await bucketOf(flightId, "M")).toMatchObject({ held: 0 });
    expect(await expirePnrs(new Date(Date.now() + 16 * 60_000))).toBe(0);
  });
});

describe("PNR changes", () => {
  it("updates passenger names and contact while held; names lock after ticketing", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q");
    const locator: string = json.pnr.recordLocator;
    const paxId: string = json.pnr.passengers[0].id;
    const params = { locator };

    const patched = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, {
      token: alice.token,
      body: { passengers: [{ id: paxId, firstName: "Juanito" }], contact: { phone: "+639990000000" } },
      params,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.pnr.passengers[0]).toMatchObject({ firstName: "Juanito", lastName: "Dela Cruz" });
    expect(patched.json.pnr.contact).toMatchObject({ email: "juan@example.com", phone: "+639990000000" });
    expect((await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { passengers: [{ id: "nope", firstName: "X" }] }, params })).status).toBe(400);
    expect((await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: {}, params })).status).toBe(400);

    await issue(alice, locator);
    const afterTicket = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { passengers: [{ id: paxId, firstName: "Other" }] }, params });
    expect(afterTicket.status).toBe(409);
    const contactOnly = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { contact: { email: "NEW@example.com" } }, params });
    expect(contactOnly.json.pnr.contact.email).toBe("new@example.com");
    const reschedule = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { segments: [{ flightId, bookingClass: "M" }] }, params });
    expect(reschedule.status).toBe(409);
  });

  it("reschedules a held PNR: old seats released, new seats held", async () => {
    const first = await makeFlight({ flightNumber: "PS101", daysAhead: 10 });
    const second = await makeFlight({ flightNumber: "PS103", daysAhead: 11 });
    const { json } = await book(alice, first.flightId, "Q", [adult("A", "One"), adult("B", "Two")]);
    const locator: string = json.pnr.recordLocator;
    expect(await bucketOf(first.flightId, "Q")).toMatchObject({ held: 2 });

    const res = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { segments: [{ flightId: second.flightId, bookingClass: "M" }] }, params: { locator } });
    expect(res.status).toBe(200);
    expect(res.json.pnr.segments).toHaveLength(1);
    expect(res.json.pnr.segments[0]).toMatchObject({ bookingClass: "M", fareAmount: 120, flight: { flightNumber: "PS103" } });
    expect(res.json.pnr.totalAmount).toBe(240);
    expect(await bucketOf(first.flightId, "Q")).toMatchObject({ held: 0 });
    expect(await bucketOf(second.flightId, "M")).toMatchObject({ held: 2 });

    // A reschedule that cannot be satisfied changes nothing.
    await setBucket(first.flightId, "Q", { open: false });
    const failed = await call(patchPnrRoute, "PATCH", `/api/pnrs/${locator}`, { token: alice.token, body: { segments: [{ flightId: first.flightId, bookingClass: "Q" }] }, params: { locator } });
    expect(failed.status).toBe(409);
    expect(await bucketOf(second.flightId, "M")).toMatchObject({ held: 2 });
    expect((await PNR.findOne({ recordLocator: locator }))!.segments[0].flightId.toString()).toBe(second.flightId);
  });
});

describe("flight lifecycle", () => {
  it("blocks cancelling a flight while active PNRs exist, then soft-cancels it", async () => {
    const { flightId } = await makeFlight();
    const { json } = await book(alice, flightId, "Q");
    const locator: string = json.pnr.recordLocator;
    const del = () => call(deleteFlightRoute, "DELETE", `/api/flights/${flightId}`, { token: staff.token, params: { id: flightId } });

    const blocked = await del();
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details).toMatchObject({ activePnrs: 1 });
    expect((await call(patchFlightRoute, "PATCH", `/api/flights/${flightId}`, { token: staff.token, body: { status: "CANCELLED" }, params: { id: flightId } })).status).toBe(409);
    // Identity changes are also blocked; gate and times are fine.
    expect((await call(patchFlightRoute, "PATCH", `/api/flights/${flightId}`, { token: staff.token, body: { destination: "DVO" }, params: { id: flightId } })).status).toBe(409);
    expect((await call(patchFlightRoute, "PATCH", `/api/flights/${flightId}`, { token: staff.token, body: { gate: "B7" }, params: { id: flightId } })).json.flight.gate).toBe("B7");

    await call(cancelPnrRoute, "POST", `/api/pnrs/${locator}/cancel`, { token: alice.token, params: { locator } });
    const ok = await del();
    expect(ok.status).toBe(200);
    expect(ok.json.flight.status).toBe("CANCELLED");
    expect((await del()).status).toBe(200); // idempotent

    // Cancelled flights are neither searchable nor bookable.
    const date = ok.json.flight.departure.slice(0, 10);
    expect((await call(searchRoute, "GET", `/api/flights/search?from=MNL&to=CEB&date=${date}`)).json.count).toBe(0);
    expect((await book(alice, flightId, "Q")).status).toBe(409);
  });

  it("counts a lapsed (unswept) hold as inactive when cancelling a flight", async () => {
    const { flightId } = await makeFlight();
    await book(alice, flightId, "Q");
    await PNR.updateMany({}, { holdExpiresAt: new Date(Date.now() - 1000) });
    await Inventory.updateOne({ flightId }, { $set: { "holds.0.expiresAt": new Date(Date.now() - 1000) } });
    const res = await call(deleteFlightRoute, "DELETE", `/api/flights/${flightId}`, { token: staff.token, params: { id: flightId } });
    expect(res.status).toBe(200);
  });

  it("creates aircraft through the API with a computed capacity", async () => {
    const res = await call(createAircraftRoute, "POST", "/api/aircraft", {
      token: staff.token,
      body: { type: "ATR72", registration: "RP-C1", capacity: 70, operatingEmptyWeightKg: 13000, maxZeroFuelWeightKg: 20000, maxTakeoffWeightKg: 23000, maxPayloadKg: 7000, maxCargoWeightKg: 1500 },
    });
    expect(res.status).toBe(201);
    expect((await call(createAircraftRoute, "POST", "/api/aircraft", { token: staff.token, body: { type: "ATR72", registration: "rp-c1", capacity: 70, operatingEmptyWeightKg: 1, maxZeroFuelWeightKg: 1, maxTakeoffWeightKg: 1, maxPayloadKg: 1, maxCargoWeightKg: 1 } })).status).toBe(409);
  });
});
