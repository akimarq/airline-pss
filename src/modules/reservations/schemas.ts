import { z } from "zod";
import { CABIN_CODES, FLIGHT_STATUSES, PASSENGER_TYPES, PNR_STATUSES } from "@/models";
import { inventoryConfigSchema } from "@/modules/inventory/schemas";

// ---- shared ---------------------------------------------------------------

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const iata = z.string().trim().toUpperCase().pipe(z.string().length(3, "Must be a 3-letter IATA code").regex(/^[A-Z]{3}$/));
const cabinSchema = z.enum(CABIN_CODES);
const bookingClass = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]$/, "Booking class must be a single letter"));
const money = z.number().min(0).finite();
const currency = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/));

export const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const boolQuery = z.enum(["true", "false"]).transform((v) => v === "true");

// ---- aircraft -------------------------------------------------------------

const cabinLayoutSchema = z
  .object({
    cabin: cabinSchema,
    firstRow: z.number().int().min(1),
    lastRow: z.number().int().min(1),
    seatLetters: z.array(z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]$/))).min(1),
  })
  .refine((c) => c.lastRow >= c.firstRow, { message: "lastRow must be >= firstRow", path: ["lastRow"] });

const aircraftBase = z.object({
  type: z.string().trim().min(1).max(30),
  registration: z.string().trim().toUpperCase().min(2).max(12),
  cabins: z.array(cabinLayoutSchema).default([]),
  capacity: z.number().int().min(1).optional(),
  operatingEmptyWeightKg: z.number().min(0),
  maxZeroFuelWeightKg: z.number().min(0),
  maxTakeoffWeightKg: z.number().min(0),
  maxPayloadKg: z.number().min(0),
  maxCargoWeightKg: z.number().min(0),
});

export const createAircraftSchema = aircraftBase.refine((a) => a.capacity !== undefined || a.cabins.length > 0, {
  message: "Provide capacity or at least one cabin layout",
  path: ["capacity"],
});

export const updateAircraftSchema = aircraftBase
  .omit({ cabins: true })
  .partial()
  .extend({ cabins: z.array(cabinLayoutSchema).optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const aircraftListQuery = z.object({
  type: z.string().trim().optional(),
  registration: z.string().trim().optional(),
  ...paginationFields,
});

// ---- flights --------------------------------------------------------------

export const createFlightSchema = z.object({
  flightNumber: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z0-9]{2}\d{1,4}$/, "Flight number looks like PS101")),
  origin: iata,
  destination: iata,
  departure: z.coerce.date(),
  arrival: z.coerce.date(),
  aircraftId: objectIdSchema,
  gate: z.string().trim().max(10).optional(),
  /** Optionally create the inventory in the same call (defaults come from the aircraft layout). */
  inventory: inventoryConfigSchema.optional(),
});

export const updateFlightSchema = z
  .object({
    flightNumber: createFlightSchema.shape.flightNumber,
    origin: iata,
    destination: iata,
    departure: z.coerce.date(),
    arrival: z.coerce.date(),
    aircraftId: objectIdSchema,
    gate: z.string().trim().max(10),
    /** Only SCHEDULED / CANCELLED can be set here; BOARDING/CLOSED/DEPARTED are driven by departure control. */
    status: z.enum(["SCHEDULED", "CANCELLED"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const flightListQuery = z.object({
  origin: iata.optional(),
  destination: iata.optional(),
  flightNumber: z.string().trim().toUpperCase().optional(),
  status: z.enum(FLIGHT_STATUSES).optional(),
  aircraftId: objectIdSchema.optional(),
  departureFrom: z.coerce.date().optional(),
  departureTo: z.coerce.date().optional(),
  ...paginationFields,
});

export const flightSearchQuery = z.object({
  from: iata,
  to: iata,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD (interpreted as a UTC day)"),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  cabin: cabinSchema.optional(),
});

// ---- fares ----------------------------------------------------------------

const fareRulesSchema = z.object({
  refundable: z.boolean().optional(),
  changeable: z.boolean().optional(),
  checkedBaggageKg: z.number().min(0).optional(),
});

export const createFareSchema = z
  .object({
    flightId: objectIdSchema.optional(),
    origin: iata.optional(),
    destination: iata.optional(),
    fareBasis: z.string().trim().toUpperCase().min(1).max(15),
    bookingClass,
    cabin: cabinSchema.default("Y"),
    price: money,
    currency: currency.default("USD"),
    rules: fareRulesSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((f) => f.flightId || (f.origin && f.destination), {
    message: "A fare needs a flightId, or both origin and destination (route fare)",
    path: ["flightId"],
  });

export const updateFareSchema = z
  .object({
    fareBasis: z.string().trim().toUpperCase().min(1).max(15),
    bookingClass,
    cabin: cabinSchema,
    price: money,
    currency,
    rules: fareRulesSchema,
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const fareListQuery = z.object({
  flightId: objectIdSchema.optional(),
  origin: iata.optional(),
  destination: iata.optional(),
  bookingClass: bookingClass.optional(),
  cabin: cabinSchema.optional(),
  active: boolQuery.optional(),
  ...paginationFields,
});

export const flightFaresQuery = z.object({
  passengers: z.coerce.number().int().min(1).max(9).default(1),
});

// ---- PNRs -----------------------------------------------------------------

const personName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}][\p{L} '.-]*$/u, "Names may only contain letters, spaces, apostrophes, dots and hyphens");

const passengerInput = z.object({
  firstName: personName,
  lastName: personName,
  type: z.enum(PASSENGER_TYPES).default("ADULT"),
  dateOfBirth: z.coerce.date().optional(),
});

const segmentInput = z.object({
  flightId: objectIdSchema,
  bookingClass,
  /** Optional: pick a specific fare (from GET /api/flights/:id/fares). Otherwise the best match is used. */
  fareId: objectIdSchema.optional(),
});

const contactInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  phone: z.string().trim().min(5).max(30).optional(),
});

export const createPnrSchema = z.object({
  passengers: z.array(passengerInput).min(1).max(9),
  segments: z.array(segmentInput).min(1).max(6),
  contact: contactInput,
  /** Staff only: book on behalf of a passenger account. */
  ownerUserId: objectIdSchema.optional(),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
});

export const updatePnrSchema = z
  .object({
    passengers: z
      .array(
        z.object({
          id: z.string().min(1),
          firstName: personName.optional(),
          lastName: personName.optional(),
          dateOfBirth: z.coerce.date().optional(),
        }),
      )
      .min(1)
      .optional(),
    contact: contactInput.partial().optional(),
    /** Reschedule: only while the PNR is still HELD. Replaces the whole itinerary. */
    segments: z.array(segmentInput).min(1).max(6).optional(),
  })
  .refine((v) => v.passengers || v.contact || v.segments, { message: "Nothing to update" });

export const pnrListQuery = z.object({
  status: z.enum(PNR_STATUSES).optional(),
  locator: z.string().trim().toUpperCase().optional(),
  ownerUserId: objectIdSchema.optional(),
  email: z.string().trim().toLowerCase().optional(),
  flightId: objectIdSchema.optional(),
  ...paginationFields,
});

// ---- tickets --------------------------------------------------------------

export const paymentSchema = z.object({
  method: z.string().trim().min(1).max(30),
  simulate: z.enum(["success", "fail"]),
});

export const issueTicketsSchema = z.object({
  payment: paymentSchema.optional(),
});

export type CreateAircraftInput = z.infer<typeof createAircraftSchema>;
export type UpdateAircraftInput = z.infer<typeof updateAircraftSchema>;
export type CreateFlightInput = z.infer<typeof createFlightSchema>;
export type UpdateFlightInput = z.infer<typeof updateFlightSchema>;
export type CreateFareInput = z.infer<typeof createFareSchema>;
export type UpdateFareInput = z.infer<typeof updateFareSchema>;
export type CreatePnrInput = z.infer<typeof createPnrSchema>;
export type UpdatePnrInput = z.infer<typeof updatePnrSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type FlightListQuery = z.infer<typeof flightListQuery>;
export type FareListQuery = z.infer<typeof fareListQuery>;
export type PnrListQuery = z.infer<typeof pnrListQuery>;
