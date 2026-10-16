import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Baggage, BoardingPass, CheckIn, Flight, Inventory, PNR, Ticket, User } from "@/models";
import { getAvailability } from "@/modules/inventory/service";
import { DEMO_FLIGHT_NUMBER, DEMO_MARKER_EMAIL, parseSeedArgs, resetDemoData, seedDemoBookings, seedUsers } from "../scripts/seed-data/demo";
import { seedReservationsData } from "../scripts/seed-data/reservations";
import { verifyPassword } from "@/lib/auth";
import { clearTestDB, stopTestDB } from "./helpers/db";
import { startDcsDB } from "./helpers/dcs";

beforeAll(startDcsDB);
afterAll(stopTestDB);
beforeEach(clearTestDB);

async function fullSeed() {
  await seedUsers();
  await seedReservationsData({ days: 7 });
  return seedDemoBookings();
}

const soldTotal = async () => {
  const invs = await Inventory.find().lean();
  const views = await Promise.all(invs.map((i) => getAvailability(i.flightId)));
  return views.reduce((sum, v) => sum + v.sold, 0);
};

describe("demo seed", () => {
  it("creates users, a HELD PNR, a TICKETED PNR and a checked-in PNR with a boarding pass and a bag", async () => {
    const result = await fullSeed();
    expect(result.created).toBe(true);
    expect(result.bookings).toHaveLength(3);

    const staff = await User.findOne({ email: "staff@airline.test" }).select("+passwordHash").lean();
    expect(staff?.role).toBe("staff");
    expect(await verifyPassword("Staff123!", staff!.passwordHash)).toBe(true);
    const pax = await User.findOne({ email: "passenger@airline.test" }).select("+passwordHash").lean();
    expect(await verifyPassword("Passenger123!", pax!.passwordHash)).toBe(true);

    const pnrs = await PNR.find({ "contact.email": DEMO_MARKER_EMAIL }).lean();
    expect(pnrs.map((p) => p.status).sort()).toEqual(["HELD", "TICKETED", "TICKETED"]);
    expect(pnrs.every((p) => p.ownerUserId.toString() === pax!._id.toString())).toBe(true);

    // adult + infant => 2 tickets; plus 1 for the checked-in booking
    expect(await Ticket.countDocuments({ status: "ISSUED" })).toBe(3);
    const checkIn = await CheckIn.findOne().lean();
    expect(checkIn?.status).toBe("CHECKED_IN");
    expect(await BoardingPass.countDocuments({ checkInId: checkIn!._id })).toBe(1);
    const bag = await Baggage.findOne().lean();
    expect(bag?.status).toBe("CHECKED");
    expect(bag?.pnrLocator).toBe(checkIn!.pnrLocator);

    const demoFlight = await Flight.findOne({ flightNumber: DEMO_FLIGHT_NUMBER }).lean();
    expect(demoFlight).toBeTruthy();
    expect(checkIn!.flightId.toString()).toBe(demoFlight!._id.toString());
    // sold: 1 (adult) + 1 (checked-in) = 2 seats; the infant holds none
    expect(await soldTotal()).toBe(2);
  });

  it("is idempotent: a second run adds nothing", async () => {
    await fullSeed();
    const counts = async () => [await PNR.countDocuments(), await Ticket.countDocuments(), await CheckIn.countDocuments(), await Flight.countDocuments(), await User.countDocuments()];
    const before = await counts();
    const again = await fullSeed();
    expect(again).toEqual({ created: false, bookings: [] });
    expect(await counts()).toEqual(before);
  });

  it("--reset removes only the demo data, gives the seats back, and can be re-seeded", async () => {
    await fullSeed();
    // an unrelated booking that must survive the reset
    const other = await User.create({ email: "other@example.com", name: "Other", role: "passenger", passwordHash: "x" });
    await PNR.create({
      recordLocator: "KEEP22",
      ownerUserId: other._id,
      passengers: [{ firstName: "Keep", lastName: "Me", type: "ADULT" }],
      segments: [{ flightId: (await Flight.findOne({ flightNumber: "PS101" }).lean())!._id, bookingClass: "M", cabin: "Y", fareId: new Types.ObjectId(), fareAmount: 1 }],
      contact: { email: "other@example.com" },
      status: "CANCELLED",
    });
    const flightsBefore = await Flight.countDocuments({ flightNumber: { $ne: DEMO_FLIGHT_NUMBER } });

    const reset = await resetDemoData();
    expect(reset).toMatchObject({ pnrs: 3, tickets: 3, checkIns: 1, baggage: 1, demoFlights: 1 });

    expect(await PNR.find().distinct("recordLocator")).toEqual(["KEEP22"]);
    expect(await Ticket.countDocuments()).toBe(0);
    expect(await CheckIn.countDocuments()).toBe(0);
    expect(await Baggage.countDocuments()).toBe(0);
    expect(await Flight.countDocuments({ flightNumber: DEMO_FLIGHT_NUMBER })).toBe(0);
    expect(await Flight.countDocuments({ flightNumber: { $ne: DEMO_FLIGHT_NUMBER } })).toBe(flightsBefore);
    expect(await User.countDocuments()).toBe(3); // users are kept
    expect(await soldTotal()).toBe(0);
    const held = (await Inventory.find().lean()).reduce((n, i) => n + i.holds.length, 0);
    expect(held).toBe(0);
  });

  it("recreates the demo bookings after a reset", async () => {
    await fullSeed();
    await resetDemoData();
    const again = await seedDemoBookings();
    expect(again.created).toBe(true);
    expect(again.bookings).toHaveLength(3);
  });
});

describe("parseSeedArgs", () => {
  it("parses --reset and --reset-only and rejects unknown flags", () => {
    expect(parseSeedArgs([])).toEqual({ reset: false, resetOnly: false });
    expect(parseSeedArgs(["--reset"])).toEqual({ reset: true, resetOnly: false });
    expect(parseSeedArgs(["--reset-only"])).toEqual({ reset: true, resetOnly: true });
    expect(() => parseSeedArgs(["--drop-everything"])).toThrow(/Unknown option/);
  });
});
