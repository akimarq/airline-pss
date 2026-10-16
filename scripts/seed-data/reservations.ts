/**
 * Reusable, idempotent seed data for the Reservations + Inventory modules: aircraft, a daily flight schedule,
 * route fares and per-flight inventory (with revenue rules). Does nothing on import; the caller must have
 * connected to MongoDB already (`connectDB()`) and invokes `seedReservationsData()`.
 *
 * Re-running is safe: aircraft/flights/fares are upserted by their natural keys and inventory is only created
 * for flights that do not have it yet (so sold/held counts are never reset).
 */
import type { Types } from "mongoose";
import { Aircraft, Fare, Flight, Inventory } from "../../src/models";
import { createInventoryForFlight } from "../../src/modules/inventory/service";

const AIRCRAFT = [
  {
    type: "A320",
    registration: "PS-A320",
    cabins: [
      { cabin: "J", firstRow: 1, lastRow: 3, seatLetters: ["A", "C", "D", "F"] }, // 12
      { cabin: "Y", firstRow: 4, lastRow: 30, seatLetters: ["A", "B", "C", "D", "E", "F"] }, // 162
    ],
    capacity: 174,
    operatingEmptyWeightKg: 42_600,
    maxZeroFuelWeightKg: 62_500,
    maxTakeoffWeightKg: 78_000,
    maxPayloadKg: 19_900,
    maxCargoWeightKg: 3_500,
  },
  {
    type: "B737-800",
    registration: "PS-B738",
    cabins: [
      { cabin: "J", firstRow: 1, lastRow: 4, seatLetters: ["A", "C", "D", "F"] }, // 16
      { cabin: "Y", firstRow: 5, lastRow: 30, seatLetters: ["A", "B", "C", "D", "E", "F"] }, // 156
    ],
    capacity: 172,
    operatingEmptyWeightKg: 41_400,
    maxZeroFuelWeightKg: 61_700,
    maxTakeoffWeightKg: 79_000,
    maxPayloadKg: 20_300,
    maxCargoWeightKg: 3_800,
  },
] as const;

interface RouteSeed {
  flightNumber: string;
  origin: string;
  destination: string;
  departUtcHour: number;
  departUtcMinute: number;
  durationMinutes: number;
  registration: string;
  /** Base (class M) price per passenger in USD. */
  basePrice: number;
}

const ROUTES: RouteSeed[] = [
  { flightNumber: "PS101", origin: "MNL", destination: "CEB", departUtcHour: 22, departUtcMinute: 0, durationMinutes: 90, registration: "PS-A320", basePrice: 70 },
  { flightNumber: "PS102", origin: "CEB", destination: "MNL", departUtcHour: 1, departUtcMinute: 30, durationMinutes: 90, registration: "PS-A320", basePrice: 70 },
  { flightNumber: "PS201", origin: "MNL", destination: "SIN", departUtcHour: 1, departUtcMinute: 0, durationMinutes: 225, registration: "PS-B738", basePrice: 180 },
  { flightNumber: "PS202", origin: "SIN", destination: "MNL", departUtcHour: 6, departUtcMinute: 30, durationMinutes: 225, registration: "PS-B738", basePrice: 180 },
  { flightNumber: "PS301", origin: "MNL", destination: "HKG", departUtcHour: 4, departUtcMinute: 0, durationMinutes: 135, registration: "PS-A320", basePrice: 130 },
  { flightNumber: "PS302", origin: "HKG", destination: "MNL", departUtcHour: 8, departUtcMinute: 15, durationMinutes: 135, registration: "PS-A320", basePrice: 130 },
];

/** Price multipliers against the route base price, per booking class. */
const FARE_LADDER: { bookingClass: string; cabin: "F" | "J" | "Y"; factor: number; fareBasis: string; refundable: boolean; changeable: boolean; baggageKg: number }[] = [
  { bookingClass: "Y", cabin: "Y", factor: 1.6, fareBasis: "YFLEX", refundable: true, changeable: true, baggageKg: 30 },
  { bookingClass: "B", cabin: "Y", factor: 1.3, fareBasis: "BFLEX", refundable: false, changeable: true, baggageKg: 25 },
  { bookingClass: "M", cabin: "Y", factor: 1.0, fareBasis: "MSAVER", refundable: false, changeable: true, baggageKg: 20 },
  { bookingClass: "K", cabin: "Y", factor: 0.8, fareBasis: "KPROMO", refundable: false, changeable: false, baggageKg: 20 },
  { bookingClass: "Q", cabin: "Y", factor: 0.6, fareBasis: "QDEEP", refundable: false, changeable: false, baggageKg: 15 },
  { bookingClass: "J", cabin: "J", factor: 3.2, fareBasis: "JFLEX", refundable: true, changeable: true, baggageKg: 40 },
  { bookingClass: "C", cabin: "J", factor: 2.6, fareBasis: "CBIZ", refundable: false, changeable: true, baggageKg: 40 },
  { bookingClass: "D", cabin: "J", factor: 2.1, fareBasis: "DSAVER", refundable: false, changeable: false, baggageKg: 35 },
];

export interface SeedReservationsOptions {
  /** How many days of flights to schedule, starting tomorrow (UTC). Default 14. */
  days?: number;
  log?: (message: string) => void;
}

export interface SeedReservationsResult {
  aircraft: number;
  flights: number;
  flightsCreated: number;
  fares: number;
  inventoriesCreated: number;
}

export async function seedReservationsData(options: SeedReservationsOptions = {}): Promise<SeedReservationsResult> {
  const days = options.days ?? 14;
  const log = options.log ?? (() => undefined);
  const result: SeedReservationsResult = { aircraft: 0, flights: 0, flightsCreated: 0, fares: 0, inventoriesCreated: 0 };

  // Aircraft
  const aircraftIds = new Map<string, Types.ObjectId>();
  for (const spec of AIRCRAFT) {
    const doc = await Aircraft.findOneAndUpdate(
      { registration: spec.registration },
      { $set: { ...spec, cabins: spec.cabins.map((c) => ({ ...c, seatLetters: [...c.seatLetters] })) } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    aircraftIds.set(spec.registration, doc._id);
    result.aircraft += 1;
    log(`  aircraft ${spec.registration}`);
  }

  // Route fares (a flight-specific fare can still override these)
  for (const route of ROUTES) {
    for (const rung of FARE_LADDER) {
      await Fare.updateOne(
        { origin: route.origin, destination: route.destination, fareBasis: rung.fareBasis, flightId: null },
        {
          $set: {
            bookingClass: rung.bookingClass,
            cabin: rung.cabin,
            price: Math.round(route.basePrice * rung.factor),
            currency: "USD",
            rules: { refundable: rung.refundable, changeable: rung.changeable, checkedBaggageKg: rung.baggageKg },
            active: true,
          },
        },
        { upsert: true },
      );
      result.fares += 1;
    }
  }
  log(`  fares for ${ROUTES.length} routes`);

  // Flights + inventory
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let day = 1; day <= days; day += 1) {
    for (const route of ROUTES) {
      const departure = new Date(today.getTime() + day * 86_400_000);
      departure.setUTCHours(route.departUtcHour, route.departUtcMinute, 0, 0);
      const arrival = new Date(departure.getTime() + route.durationMinutes * 60_000);

      const existed = await Flight.exists({ flightNumber: route.flightNumber, departure });
      const flight = await Flight.findOneAndUpdate(
        { flightNumber: route.flightNumber, departure },
        {
          $setOnInsert: {
            origin: route.origin,
            destination: route.destination,
            arrival,
            aircraftId: aircraftIds.get(route.registration),
            status: "SCHEDULED",
            boardingOpen: false,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      result.flights += 1;
      if (!existed) result.flightsCreated += 1;

      if (!(await Inventory.exists({ flightId: flight._id }))) {
        await createInventoryForFlight(
          flight._id,
          {
            loadFactorRules: [
              { thresholdPct: 75, closeClasses: ["Q"] },
              { thresholdPct: 90, closeClasses: ["K", "M"] },
              { thresholdPct: 80, closeClasses: ["D"] },
            ],
            timeToDepartureRules: [
              { daysBeforeDeparture: 2, closeClasses: ["Q", "D"] },
              { daysBeforeDeparture: 1, closeClasses: ["K"] },
            ],
          },
          "seed",
        );
        result.inventoriesCreated += 1;
      }
    }
  }
  log(`  ${result.flights} flights (${result.flightsCreated} new), ${result.inventoriesCreated} new inventories`);
  return result;
}
