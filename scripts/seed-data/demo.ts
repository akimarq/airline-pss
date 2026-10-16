/**
 * Demo users + demo bookings for the seed script. Does nothing on import; the caller must already be connected
 * to MongoDB (`connectDB()`).
 *
 * Demo bookings are created through the REAL services (createPnr / issueTickets / checkInPassenger /
 * createBaggage), so inventory counters, ticket numbers, boarding passes and bag tags are all consistent.
 * Everything demo-related is recognisable by the contact e-mail `DEMO_MARKER_EMAIL` (and the dedicated flight
 * `DEMO_FLIGHT_NUMBER`), which is what makes seeding idempotent and `--reset` precise (it never drops the DB).
 */
import { hashPassword } from "../../src/lib/auth";
import type { Role } from "../../src/lib/roles";
import type { AuthUser } from "../../src/lib/withAuth";
import {
  Aircraft,
  Baggage,
  BoardingPass,
  CheckIn,
  Flight,
  Inventory,
  LoadSheet,
  PNR,
  Ticket,
  User,
} from "../../src/models";
import { createBaggage } from "../../src/modules/dcs/baggage";
import { checkInPassenger } from "../../src/modules/dcs/checkin";
import { releaseHold, releaseSoldSeats } from "../../src/modules/inventory/service";
import { createFlight } from "../../src/modules/reservations/flights.service";
import { createPnr } from "../../src/modules/reservations/pnrs.service";
import { issueTickets } from "../../src/modules/reservations/tickets.service";

export const DEMO_MARKER_EMAIL = "demo-seed@airline.test";
export const DEMO_FLIGHT_NUMBER = "PS900";

export const SEED_USERS: { email: string; password: string; name: string; role: Role }[] = [
  { email: "staff@airline.test", password: "Staff123!", name: "Demo Staff", role: "staff" },
  { email: "passenger@airline.test", password: "Passenger123!", name: "Demo Passenger", role: "passenger" },
];

type Log = (message: string) => void;
const noop: Log = () => undefined;

export async function seedUsers(log: Log = noop) {
  for (const { password, ...rest } of SEED_USERS) {
    await User.updateOne(
      { email: rest.email },
      { $set: { ...rest, passwordHash: await hashPassword(password) } },
      { upsert: true },
    );
    log(`  user ${rest.email} (${rest.role})`);
  }
}

// ---- reset ----------------------------------------------------------------

export interface ResetResult {
  pnrs: number;
  tickets: number;
  checkIns: number;
  baggage: number;
  demoFlights: number;
}

/**
 * Remove ONLY the demo bookings (PNRs with the marker e-mail and everything hanging off them) and the dedicated
 * demo flight. Seats those bookings still hold/own on other flights are given back to inventory first.
 */
export async function resetDemoData(log: Log = noop): Promise<ResetResult> {
  const result: ResetResult = { pnrs: 0, tickets: 0, checkIns: 0, baggage: 0, demoFlights: 0 };
  const demoPnrs = await PNR.find({ "contact.email": DEMO_MARKER_EMAIL }).lean();

  for (const pnr of demoPnrs) {
    await releaseHold(pnr.recordLocator);
    const tickets = await Ticket.find({ pnrId: pnr._id, status: "ISSUED" }).lean();
    for (const t of tickets) {
      const pax = pnr.passengers.find((p) => p.id === t.passengerId);
      const segment = pnr.segments[t.segmentIndex];
      if (pax && segment && pax.type !== "INFANT") {
        await releaseSoldSeats(t.flightId, segment.cabin, segment.bookingClass, 1, "seed-reset");
      }
    }
    const checkIns = await CheckIn.find({ pnrId: pnr._id }).select("_id").lean();
    await BoardingPass.deleteMany({ checkInId: { $in: checkIns.map((c) => c._id) } });
    result.checkIns += (await CheckIn.deleteMany({ pnrId: pnr._id })).deletedCount;
    result.baggage += (await Baggage.deleteMany({ pnrId: pnr._id })).deletedCount;
    result.tickets += (await Ticket.deleteMany({ pnrId: pnr._id })).deletedCount;
    result.pnrs += (await PNR.deleteOne({ _id: pnr._id })).deletedCount;
  }

  const demoFlights = await Flight.find({ flightNumber: DEMO_FLIGHT_NUMBER }).select("_id").lean();
  for (const f of demoFlights) {
    await Promise.all([
      Inventory.deleteMany({ flightId: f._id }),
      LoadSheet.deleteMany({ flightId: f._id }),
      CheckIn.deleteMany({ flightId: f._id }),
      BoardingPass.deleteMany({ flightId: f._id }),
      Baggage.deleteMany({ flightId: f._id }),
    ]);
    result.demoFlights += (await Flight.deleteOne({ _id: f._id })).deletedCount;
  }
  log(`  reset: ${result.pnrs} PNRs, ${result.tickets} tickets, ${result.checkIns} check-ins, ${result.baggage} bags, ${result.demoFlights} demo flight(s) removed`);
  return result;
}

// ---- demo bookings --------------------------------------------------------

export interface DemoBooking {
  label: string;
  locator: string;
  status: string;
  flight: string;
}

export interface DemoBookingsResult {
  created: boolean;
  bookings: DemoBooking[];
}

const DAY_MS = 86_400_000;

async function findSeededFlight(flightNumber: string, minDaysAhead: number) {
  const flight = await Flight.findOne({ flightNumber, status: "SCHEDULED", departure: { $gte: new Date(Date.now() + minDaysAhead * DAY_MS) } })
    .sort({ departure: 1 })
    .lean();
  if (!flight) throw new Error(`No upcoming ${flightNumber} flight found; run seedReservationsData() first`);
  return flight;
}

/** Create the demo flight (departs in ~8 hours, so online check-in is open right after seeding). */
async function createDemoFlight(actor: string) {
  const aircraft = await Aircraft.findOne({ registration: "PS-A320" }).lean();
  if (!aircraft) throw new Error("Aircraft PS-A320 not found; run seedReservationsData() first");
  const departure = new Date(Date.now() + 8 * 3_600_000);
  const { flight } = await createFlight(
    {
      flightNumber: DEMO_FLIGHT_NUMBER,
      origin: "MNL",
      destination: "CEB",
      departure,
      arrival: new Date(departure.getTime() + 90 * 60_000),
      aircraftId: aircraft._id.toString(),
      gate: "A1",
      inventory: {},
    },
    actor,
  );
  return flight;
}

const contact = { email: DEMO_MARKER_EMAIL, phone: "+639170000000" };
const payment = { method: "demo-card", simulate: "success" as const };

/**
 * Add demo bookings for `passenger@airline.test`, unless the marker booking already exists:
 *  1. a HELD PNR (hold expires after 15 minutes; pay it via the API/UI to see ticketing),
 *  2. a TICKETED PNR (adult + lap infant),
 *  3. a TICKETED PNR that is checked in with a seat, a boarding pass and one tagged bag (demo flight PS900).
 */
export async function seedDemoBookings(log: Log = noop): Promise<DemoBookingsResult> {
  if (await PNR.exists({ "contact.email": DEMO_MARKER_EMAIL })) {
    log("  demo bookings already exist (use --reset to recreate them)");
    return { created: false, bookings: [] };
  }
  const [passengerDoc, staffDoc] = await Promise.all([
    User.findOne({ email: "passenger@airline.test" }).lean(),
    User.findOne({ email: "staff@airline.test" }).lean(),
  ]);
  if (!passengerDoc || !staffDoc) throw new Error("Demo users are missing; run seedUsers() first");
  const passenger: AuthUser = { id: passengerDoc._id.toString(), role: "passenger", email: passengerDoc.email };
  const staff: AuthUser = { id: staffDoc._id.toString(), role: "staff", email: staffDoc.email };

  const bookings: DemoBooking[] = [];
  const record = (label: string, locator: string, status: string, flight: string) => {
    bookings.push({ label, locator, status, flight });
    log(`  PNR ${locator}  ${status.padEnd(9)} ${flight}  (${label})`);
  };

  // 1. HELD
  const heldFlight = await findSeededFlight("PS201", 4);
  const held = await createPnr(passenger, {
    passengers: [{ firstName: "Demo", lastName: "Passenger", type: "ADULT" }],
    segments: [{ flightId: heldFlight._id.toString(), bookingClass: "M" }],
    contact,
  });
  record("held, awaiting payment", held.recordLocator, held.status, heldFlight.flightNumber);

  // 2. TICKETED (adult + lap infant)
  const ticketedFlight = await findSeededFlight("PS301", 4);
  const created = await createPnr(passenger, {
    passengers: [
      { firstName: "Demo", lastName: "Passenger", type: "ADULT" },
      { firstName: "Baby", lastName: "Passenger", type: "INFANT" },
    ],
    segments: [{ flightId: ticketedFlight._id.toString(), bookingClass: "M" }],
    contact,
  });
  const ticketed = await issueTickets(created.recordLocator, passenger, { payment });
  record("ticketed, adult + infant", ticketed.pnr.recordLocator, ticketed.pnr.status, ticketedFlight.flightNumber);

  // 3. TICKETED + checked in (+ boarding pass + bag) on the dedicated demo flight
  const demoFlight = await createDemoFlight(staff.id);
  const toCheckIn = await createPnr(passenger, {
    passengers: [{ firstName: "Demo", lastName: "Flyer", type: "ADULT" }],
    segments: [{ flightId: demoFlight.id, bookingClass: "Y" }],
    contact,
  });
  const paid = await issueTickets(toCheckIn.recordLocator, passenger, { payment });
  const { checkIn, boardingPass } = await checkInPassenger(passenger, {
    pnrLocator: paid.pnr.recordLocator,
    segmentIndex: 0,
    channel: "ONLINE",
  });
  const bag = await createBaggage(staff, { checkInId: checkIn._id.toString(), weightKg: 18 });
  record(
    `checked in, seat ${checkIn.seat}, boarding pass seq ${boardingPass.boardingSequence}, bag ${bag.tagNumber}`,
    paid.pnr.recordLocator,
    paid.pnr.status,
    DEMO_FLIGHT_NUMBER,
  );

  return { created: true, bookings };
}

// ---- CLI args -------------------------------------------------------------

export interface SeedArgs {
  /** Remove the demo data (bookings + demo flight) first. */
  reset: boolean;
  /** With `--reset-only`: remove it and stop. */
  resetOnly: boolean;
}

export function parseSeedArgs(argv: string[]): SeedArgs {
  const known = new Set(["--reset", "--reset-only"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}. Supported: --reset, --reset-only`);
  const resetOnly = argv.includes("--reset-only");
  return { reset: argv.includes("--reset") || resetOnly, resetOnly };
}
