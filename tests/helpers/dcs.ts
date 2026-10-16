import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { signToken } from "@/lib/auth";
import {
  Aircraft,
  Baggage,
  BoardingPass,
  CheckIn,
  Fare,
  Flight,
  LoadSheet,
  PNR,
  Ticket,
  type CabinCode,
  type IAircraft,
  type FlightStatus,
  type PassengerType,
  type PnrStatus,
  type TicketStatus,
} from "@/models";
import { createUser } from "@/modules/auth/service";
import { startTestDB } from "./db";

/** Start the in-memory DB and make sure unique/partial indexes exist (concurrency tests rely on them). */
export async function startDcsDB() {
  await startTestDB();
  await Promise.all([CheckIn.init(), Baggage.init(), BoardingPass.init(), LoadSheet.init(), Ticket.init(), PNR.init(), Flight.init()]);
}

type Handler = (req: NextRequest, ctx: never) => Promise<Response>;

export async function api(
  handler: Handler,
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { token?: string; body?: unknown; params?: Record<string, string> } = {},
) {
  const req = new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) } as never);
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

export interface TestUser {
  id: string;
  token: string;
}

async function makeUser(email: string, role: "passenger" | "staff"): Promise<TestUser> {
  const u = await createUser({ email, password: "Passw0rd!", name: email.split("@")[0], role });
  return { id: u.id, token: await signToken({ sub: u.id, role, email }) };
}

export async function makeUsers() {
  return {
    passenger: await makeUser("pax1@example.com", "passenger"),
    other: await makeUser("pax2@example.com", "passenger"),
    staff: await makeUser("agent@airline.test", "staff"),
  };
}

export type AircraftOverrides = Partial<Omit<IAircraft, "_id">>;

/** F: rows 1 (A,B) | J: rows 2-3 (A,C,D,F) | Y: rows 4-8 (A-F). */
export async function makeAircraft(overrides: AircraftOverrides = {}) {
  return Aircraft.create({
    type: "A320",
    registration: `RP-C${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    cabins: [
      { cabin: "F", firstRow: 1, lastRow: 1, seatLetters: ["A", "B"] },
      { cabin: "J", firstRow: 2, lastRow: 3, seatLetters: ["A", "C", "D", "F"] },
      { cabin: "Y", firstRow: 4, lastRow: 8, seatLetters: ["A", "B", "C", "D", "E", "F"] },
    ],
    capacity: 40,
    operatingEmptyWeightKg: 40_000,
    maxZeroFuelWeightKg: 60_000,
    maxTakeoffWeightKg: 75_000,
    maxPayloadKg: 18_000,
    maxCargoWeightKg: 3_000,
    ...overrides,
  });
}

let flightCounter = 100;
export async function makeFlight(opts: { hoursToDeparture?: number; aircraftId?: Types.ObjectId; status?: FlightStatus; gate?: string } = {}) {
  const aircraft = opts.aircraftId ? { _id: opts.aircraftId } : await makeAircraft();
  const departure = new Date(Date.now() + (opts.hoursToDeparture ?? 10) * 3_600_000);
  return Flight.create({
    flightNumber: `PS${flightCounter++}`,
    origin: "MNL",
    destination: "CEB",
    departure,
    arrival: new Date(departure.getTime() + 90 * 60_000),
    aircraftId: aircraft._id,
    status: opts.status ?? "SCHEDULED",
    gate: opts.gate,
  });
}

let ticketCounter = 1;
let locatorCounter = 0;
const nextLocator = () => `AB${(1000 + locatorCounter++).toString(36).toUpperCase().padStart(4, "0")}`.slice(0, 6);

export interface BookingOpts {
  ownerId: string;
  flightId: Types.ObjectId;
  passengers?: { type?: PassengerType; firstName?: string; lastName?: string }[];
  cabin?: CabinCode;
  bookingClass?: string;
  baggageKg?: number;
  pnrStatus?: PnrStatus;
  ticketStatus?: TicketStatus;
  withFare?: boolean;
}

/** Creates Fare, a TICKETED PNR and one ISSUED ticket per passenger (segment 0), straight via the models. */
export async function makeBooking(o: BookingOpts) {
  const cabin = o.cabin ?? "Y";
  const bookingClass = o.bookingClass ?? "Y";
  const fare = await Fare.create({
    flightId: o.flightId,
    fareBasis: `${bookingClass}TEST`,
    bookingClass,
    cabin,
    price: 100,
    rules: { refundable: false, changeable: false, checkedBaggageKg: o.baggageKg ?? 20 },
  });
  const passengers = (o.passengers ?? [{}]).map((p, i) => ({
    id: new Types.ObjectId().toString(),
    firstName: p.firstName ?? `First${i}`,
    lastName: p.lastName ?? "Doe",
    type: p.type ?? "ADULT",
  }));
  const pnr = await PNR.create({
    recordLocator: nextLocator(),
    ownerUserId: o.ownerId,
    passengers,
    segments: [{ flightId: o.flightId, bookingClass, cabin, fareId: fare._id, fareAmount: 100 }],
    contact: { email: "pax@example.com" },
    status: o.pnrStatus ?? "TICKETED",
    totalAmount: 100 * passengers.length,
  });
  const tickets = [];
  for (const p of passengers) {
    tickets.push(
      await Ticket.create({
        ticketNumber: `123${String(ticketCounter++).padStart(10, "0")}`,
        pnrId: pnr._id,
        pnrLocator: pnr.recordLocator,
        passengerId: p.id,
        passengerName: `${p.lastName}/${p.firstName}`.toUpperCase(),
        segmentIndex: 0,
        flightId: o.flightId,
        bookingClass,
        fareId: fare._id,
        fareAmount: 100,
        status: o.ticketStatus ?? "ISSUED",
      }),
    );
  }
  return { pnr, fare, tickets, locator: pnr.recordLocator, passengerIds: passengers.map((p) => p.id) };
}
