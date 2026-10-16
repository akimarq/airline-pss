/**
 * OpenAPI 3.0 description of the whole REST API, served at `GET /api/docs` (Swagger UI at `/api/docs/ui`).
 *
 * - Request bodies and query strings are derived from the REAL zod schemas the route handlers validate with
 *   (`z.toJSONSchema`, input side), so they cannot drift from the validation.
 * - Response bodies are hand-written component schemas (the handlers return Mongoose lean documents).
 * - `tests/openapi.test.ts` fails when a `route.ts` under `src/app/api` is missing here (path + method), or when
 *   this spec lists an operation that has no route.
 */
import { z } from "zod";
import { createStaffSchema, loginSchema, registerSchema } from "@/modules/auth/schemas";
import {
  baggageCreateSchema,
  baggageListQuerySchema,
  baggageStatusSchema,
  boardingPassListQuerySchema,
  checkInListQuerySchema,
  checkInSchema,
  loadInputSchema,
  openBoardingSchema,
  scanSchema,
} from "@/modules/dcs/schemas";
import { availabilityQuerySchema, inventoryConfigSchema, patchBucketSchema, rulesSchema } from "@/modules/inventory/schemas";
import {
  aircraftListQuery,
  createAircraftSchema,
  createFareSchema,
  createFlightSchema,
  createPnrSchema,
  fareListQuery,
  flightFaresQuery,
  flightListQuery,
  flightSearchQuery,
  issueTicketsSchema,
  pnrListQuery,
  updateAircraftSchema,
  updateFareSchema,
  updateFlightSchema,
  updatePnrSchema,
} from "@/modules/reservations/schemas";

// ---- types ----------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
/** `public`: no token. `any`: any authenticated user (ownership rules may still apply). `staff`: staff only. */
export type Access = "public" | "any" | "staff";

export interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface OpenApiOperation {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<string, JsonSchema>;
  security: Record<string, string[]>[];
  "x-roles": string[];
}

export interface OpenApiDocument {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
    responses: Record<string, JsonSchema>;
  };
}

// ---- schema helpers -------------------------------------------------------

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
const num = (extra: JsonSchema = {}): JsonSchema => ({ type: "number", ...extra });
const int = (extra: JsonSchema = {}): JsonSchema => ({ type: "integer", ...extra });
const bool = (): JsonSchema => ({ type: "boolean" });
const dateTime = (): JsonSchema => ({ type: "string", format: "date-time" });
const oid = (): JsonSchema => ({ type: "string", pattern: "^[a-f\\d]{24}$", example: "665f1c2e8b3a4d0012a4b5c6" });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const enumOf = (...values: string[]): JsonSchema => ({ type: "string", enum: values });
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const page = (item: JsonSchema): JsonSchema =>
  obj({ data: arr(item), page: int(), limit: int(), total: int(), totalPages: int() });

/** The request-side JSON schema of a zod schema (what a client has to send). */
export function fromZod(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date-time";
      }
      // zod adds the safe-integer bounds to every `.int()`; they are noise for API consumers.
      if (ctx.jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete ctx.jsonSchema.maximum;
      if (ctx.jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete ctx.jsonSchema.minimum;
    },
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

/** Query-string parameters of a zod object schema. */
function queryParameters(schema: z.ZodType): OpenApiParameter[] {
  const json = fromZod(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: "query" as const,
    required: required.has(name),
    schema: s,
  }));
}

// ---- components -----------------------------------------------------------

const CABIN = enumOf("F", "J", "Y");
const FLIGHT_STATUS = enumOf("SCHEDULED", "BOARDING", "CLOSED", "DEPARTED", "CANCELLED");
const PNR_STATUS = enumOf("HELD", "CONFIRMED", "TICKETED", "CANCELLED", "EXPIRED");
const PASSENGER_TYPE = enumOf("ADULT", "CHILD", "INFANT");

const timestamps = { createdAt: dateTime(), updatedAt: dateTime() };

const schemas: Record<string, JsonSchema> = {
  ErrorBody: {
    type: "object",
    description: "The standard error shape returned by every endpoint on failure.",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: str({ example: "VALIDATION_ERROR", description: "Machine readable code, e.g. BAD_REQUEST, VALIDATION_ERROR, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, DUPLICATE_KEY, INTERNAL_ERROR or a specific one such as CHECKIN_CLOSED, SEAT_TAKEN, ALREADY_BOARDED, PAYMENT_FAILED." }),
          message: str(),
          details: { description: "Optional extra information (zod issues for VALIDATION_ERROR, ...)." },
        },
      },
    },
  },
  User: obj({ id: oid(), email: str({ format: "email" }), name: str(), role: enumOf("passenger", "staff") }),
  CabinLayout: obj({ cabin: CABIN, firstRow: int(), lastRow: int(), seatLetters: arr(str()) }),
  Aircraft: obj({
    id: oid(),
    type: str({ example: "A320" }),
    registration: str({ example: "PS-A320" }),
    cabins: arr(ref("CabinLayout")),
    capacity: int(),
    operatingEmptyWeightKg: num(),
    maxZeroFuelWeightKg: num(),
    maxTakeoffWeightKg: num(),
    maxPayloadKg: num(),
    maxCargoWeightKg: num(),
    ...timestamps,
  }),
  Flight: obj(
    {
      id: oid(),
      flightNumber: str({ example: "PS101" }),
      origin: str({ example: "MNL" }),
      destination: str({ example: "CEB" }),
      departure: dateTime(),
      arrival: dateTime(),
      aircraftId: oid(),
      status: FLIGHT_STATUS,
      gate: str(),
      boardingOpen: bool(),
      ...timestamps,
    },
    ["id", "flightNumber", "origin", "destination", "departure", "arrival", "aircraftId", "status", "boardingOpen"],
  ),
  FareRules: obj({ refundable: bool(), changeable: bool(), checkedBaggageKg: num() }),
  Fare: obj(
    {
      id: oid(),
      flightId: oid(),
      origin: str(),
      destination: str(),
      fareBasis: str({ example: "MSAVER" }),
      bookingClass: str({ example: "M" }),
      cabin: CABIN,
      price: num(),
      currency: str({ example: "USD" }),
      rules: ref("FareRules"),
      active: bool(),
      ...timestamps,
    },
    ["id", "fareBasis", "bookingClass", "cabin", "price", "currency", "rules", "active"],
  ),
  OfferedFare: obj({
    fareId: oid(),
    fareBasis: str(),
    bookingClass: str(),
    cabin: CABIN,
    price: num(),
    currency: str(),
    rules: ref("FareRules"),
    scope: enumOf("flight", "route"),
    seatsAvailable: int({ description: "Capped at 9 for display." }),
  }),
  FlightSearchResult: obj({
    id: oid(),
    flightNumber: str(),
    origin: str(),
    destination: str(),
    departure: dateTime(),
    arrival: dateTime(),
    durationMinutes: int(),
    fares: { type: "object", description: "Lowest open fare per cabin (keys F, J, Y).", additionalProperties: ref("OfferedFare") },
    lowestFare: ref("OfferedFare"),
  }),
  Bucket: obj(
    {
      class: str(),
      authorized: int(),
      sold: int(),
      held: int(),
      available: int(),
      open: bool(),
      source: { type: "string", nullable: true, enum: ["manual", "rule", null], description: "Who last set open/closed: a staff override ('manual', which rules never touch) or the rules engine." },
    },
    ["class", "authorized", "sold", "held", "available", "open", "source"],
  ),
  CabinInventory: obj({ cabin: CABIN, capacity: int(), sold: int(), held: int(), loadFactorPct: num(), buckets: arr(ref("Bucket")) }),
  LoadFactorRule: obj({ thresholdPct: num(), closeClasses: arr(str()) }),
  TimeToDepartureRule: obj({ daysBeforeDeparture: num(), closeClasses: arr(str()) }),
  Inventory: obj(
    {
      flightId: oid(),
      capacity: int(),
      sold: int(),
      held: int(),
      loadFactorPct: num(),
      cabins: arr(ref("CabinInventory")),
      holds: arr(obj({ pnrLocator: str(), cabin: CABIN, bucketClass: str(), seats: int(), expiresAt: dateTime() })),
      loadFactorRules: arr(ref("LoadFactorRule")),
      timeToDepartureRules: arr(ref("TimeToDepartureRule")),
      history: arr(obj({ at: dateTime(), actor: str(), action: str(), details: {} }, ["at", "action"])),
    },
    ["flightId", "capacity", "sold", "held", "loadFactorPct", "cabins", "holds", "loadFactorRules", "timeToDepartureRules"],
  ),
  PublicAvailability: obj({
    flightId: oid(),
    cabins: arr(obj({ cabin: CABIN, buckets: arr(obj({ class: str(), available: int() })) })),
  }),
  PnrPassenger: obj({ id: str({ description: "Stable id inside the PNR; tickets and check-ins refer to it." }), firstName: str(), lastName: str(), type: PASSENGER_TYPE, dateOfBirth: dateTime() }, ["id", "firstName", "lastName", "type"]),
  PnrSegment: obj(
    {
      flightId: oid(),
      bookingClass: str(),
      cabin: CABIN,
      fareId: oid(),
      fareAmount: num(),
      flight: {
        type: "object",
        nullable: true,
        properties: {
          flightNumber: str(),
          origin: str(),
          destination: str(),
          departure: dateTime(),
          arrival: dateTime(),
          status: FLIGHT_STATUS,
          gate: str(),
        },
      },
    },
    ["flightId", "bookingClass", "cabin", "fareId", "fareAmount"],
  ),
  Pnr: obj(
    {
      id: oid(),
      recordLocator: str({ example: "K7M2QX", description: "6 characters, no I/O/0/1." }),
      ownerUserId: oid(),
      passengers: arr(ref("PnrPassenger")),
      segments: arr(ref("PnrSegment")),
      contact: obj({ email: str({ format: "email" }), phone: str() }, ["email"]),
      status: PNR_STATUS,
      holdExpiresAt: dateTime(),
      totalAmount: num(),
      currency: str({ example: "USD" }),
      history: arr(obj({ at: dateTime(), actor: str(), action: str(), details: {} }, ["at", "action"])),
      ...timestamps,
    },
    ["id", "recordLocator", "ownerUserId", "passengers", "segments", "contact", "status", "totalAmount", "currency"],
  ),
  Ticket: obj(
    {
      id: oid(),
      ticketNumber: str({ pattern: "^\\d{13}$", example: "1230000000001" }),
      pnrId: oid(),
      pnrLocator: str(),
      passengerId: str(),
      passengerName: str({ example: "DOE/JOHN" }),
      segmentIndex: int(),
      flightId: oid(),
      bookingClass: str(),
      fareId: oid(),
      fareAmount: num(),
      currency: str(),
      status: enumOf("ISSUED", "USED", "REFUNDED", "VOID"),
      issuedAt: dateTime(),
      issuedBy: oid(),
      voidedAt: dateTime(),
      ...timestamps,
    },
    ["id", "ticketNumber", "pnrId", "pnrLocator", "passengerId", "passengerName", "segmentIndex", "flightId", "bookingClass", "fareId", "fareAmount", "currency", "status"],
  ),
  PaymentReceipt: obj({ method: str(), status: enumOf("PAID"), reference: str({ example: "PAY-1A2B3C4D" }), amount: num(), currency: str() }),
  CheckIn: obj(
    {
      _id: oid(),
      pnrId: oid(),
      pnrLocator: str(),
      ticketId: oid(),
      passengerId: str(),
      flightId: oid(),
      seat: str({ example: "12A", description: "Infants get a pseudo seat 'INF-<sequence>'." }),
      boardingSequence: int(),
      status: enumOf("CHECKED_IN", "BOARDED", "NO_SHOW"),
      channel: enumOf("ONLINE", "AIRPORT"),
      checkedInBy: oid(),
      checkedInAt: dateTime(),
      boardedAt: dateTime(),
      passengerName: str({ description: "Only on list responses." }),
      ...timestamps,
    },
    ["_id", "pnrId", "pnrLocator", "ticketId", "passengerId", "flightId", "seat", "boardingSequence", "status", "channel", "checkedInAt"],
  ),
  BoardingPass: obj(
    {
      _id: oid(),
      checkInId: oid(),
      pnrLocator: str(),
      passengerName: str(),
      flightId: oid(),
      flightNumber: str(),
      origin: str(),
      destination: str(),
      departure: dateTime(),
      cabin: CABIN,
      seat: str(),
      boardingSequence: int(),
      gate: str(),
      boardingTime: dateTime(),
      barcode: str({ description: "IATA BCBP-style payload (render it as a QR code)." }),
      checkInStatus: enumOf("CHECKED_IN", "BOARDED", "NO_SHOW"),
      ...timestamps,
    },
    ["_id", "checkInId", "pnrLocator", "passengerName", "flightId", "flightNumber", "origin", "destination", "departure", "cabin", "seat", "boardingSequence", "boardingTime", "barcode"],
  ),
  Baggage: obj(
    {
      _id: oid(),
      tagNumber: str({ example: "PS0123456789" }),
      pnrId: oid(),
      pnrLocator: str(),
      passengerId: str(),
      flightId: oid(),
      weightKg: num(),
      excess: bool(),
      allowanceKg: num(),
      excessKg: num(),
      status: enumOf("CHECKED", "SCREENED", "LOADED", "OFFLOADED"),
      history: arr(obj({ at: dateTime(), status: enumOf("CHECKED", "SCREENED", "LOADED", "OFFLOADED"), actor: str() }, ["at", "status"])),
      ...timestamps,
    },
    ["_id", "tagNumber", "pnrId", "pnrLocator", "passengerId", "flightId", "weightKg", "status", "history"],
  ),
  SeatMap: obj({
    flightId: oid(),
    flightNumber: str(),
    aircraftType: str(),
    cabins: arr(
      obj({
        cabin: CABIN,
        totalSeats: int(),
        availableSeats: int(),
        rows: arr(
          obj({
            row: int(),
            seats: arr(
              obj(
                {
                  seat: str({ example: "12A" }),
                  letter: str(),
                  status: enumOf("AVAILABLE", "OCCUPIED"),
                  occupant: obj({ checkInId: oid(), pnrLocator: str(), passengerId: str(), status: enumOf("CHECKED_IN", "BOARDED", "NO_SHOW") }),
                },
                ["seat", "letter", "status"],
              ),
            ),
          }),
        ),
      }),
    ),
  }),
  LoadLimits: obj({ operatingEmptyWeightKg: num(), maxZeroFuelWeightKg: num(), maxTakeoffWeightKg: num(), maxPayloadKg: num(), maxCargoWeightKg: num() }),
  LoadComputation: obj({
    adults: int(),
    children: int(),
    infants: int(),
    passengerCount: int({ description: "Excludes infants." }),
    passengerWeightKg: num(),
    baggageCount: int(),
    baggageWeightKg: num(),
    cargoWeightKg: num(),
    fuelWeightKg: num(),
    payloadKg: num(),
    zeroFuelWeightKg: num(),
    takeoffWeightKg: num(),
    withinLimits: bool(),
    warnings: arr(str()),
    limits: ref("LoadLimits"),
  }),
  LoadSheet: obj(
    {
      _id: oid(),
      flightId: oid(),
      status: enumOf("DRAFT", "FINAL"),
      passengerCount: int(),
      adults: int(),
      children: int(),
      infants: int(),
      passengerWeightKg: num(),
      baggageCount: int(),
      baggageWeightKg: num(),
      cargoWeightKg: num(),
      fuelWeightKg: num(),
      zeroFuelWeightKg: num(),
      takeoffWeightKg: num(),
      withinLimits: bool(),
      warnings: arr(str()),
      finalizedBy: oid(),
      finalizedAt: dateTime(),
      ...timestamps,
    },
    ["_id", "flightId", "status", "withinLimits"],
  ),
  LoadView: obj({
    flightId: oid(),
    loadSheetStatus: { type: "string", nullable: true, enum: ["DRAFT", "FINAL", null] },
    load: ref("LoadComputation"),
    loadSheet: { allOf: [ref("LoadSheet")], nullable: true },
    outOfDate: bool(),
  }),
  Manifest: obj({
    flight: obj({ id: oid(), flightNumber: str(), status: FLIGHT_STATUS, gate: str(), boardingOpen: bool() }, ["id", "flightNumber", "status", "boardingOpen"]),
    counts: obj({
      ticketed: int(),
      checkedIn: int(),
      boarded: int(),
      notYetBoarded: int(),
      notCheckedIn: int(),
      noShow: int(),
      noShowCandidates: int(),
    }),
    passengers: arr(
      obj(
        {
          checkInId: oid(),
          pnrLocator: str(),
          passengerId: str(),
          passengerName: str(),
          type: PASSENGER_TYPE,
          seat: str(),
          boardingSequence: int(),
          status: enumOf("CHECKED_IN", "BOARDED", "NO_SHOW"),
          channel: enumOf("ONLINE", "AIRPORT"),
          boardedAt: dateTime(),
        },
        ["checkInId", "pnrLocator", "passengerId", "passengerName", "type", "seat", "boardingSequence", "status", "channel"],
      ),
    ),
    noShowCandidates: arr(
      obj(
        {
          kind: enumOf("CHECKED_IN_NOT_BOARDED", "NOT_CHECKED_IN"),
          pnrLocator: str(),
          passengerId: str(),
          passengerName: str(),
          checkInId: oid(),
          ticketId: oid(),
        },
        ["kind", "pnrLocator", "passengerId", "passengerName", "ticketId"],
      ),
    ),
  }),
  ScanResult: obj({
    result: enumOf("BOARDED"),
    checkInId: oid(),
    pnrLocator: str(),
    passengerName: str(),
    seat: str(),
    boardingSequence: int(),
    boardedAt: dateTime(),
  }),
  CloseSummary: obj({
    flightId: oid(),
    status: enumOf("CLOSED"),
    boarded: int(),
    noShows: obj({ checkedInNotBoarded: int(), notCheckedIn: int(), total: int() }),
    seatsReleased: arr(obj({ cabin: CABIN, bucketClass: str(), seats: int() })),
    inventoryReleaseFailures: arr(obj({ cabin: CABIN, bucketClass: str(), seats: int(), error: str() })),
    baggageOffloaded: int(),
    closedAt: dateTime(),
  }),
};

const errorResponse = (description: string): JsonSchema => ({
  description,
  content: { "application/json": { schema: ref("ErrorBody") } },
});

const responses: Record<string, JsonSchema> = {
  BadRequest: errorResponse("Validation failed or malformed request (`VALIDATION_ERROR`, `BAD_REQUEST`)."),
  Unauthorized: errorResponse("Missing, invalid or expired token (`UNAUTHORIZED`)."),
  PaymentRequired: errorResponse("The simulated payment was declined (`PAYMENT_FAILED`); the booking stays held."),
  Forbidden: errorResponse("Authenticated, but the role or ownership does not allow this (`FORBIDDEN`)."),
  NotFound: errorResponse("Resource not found (`NOT_FOUND`)."),
  Conflict: errorResponse("The request conflicts with the current state, e.g. oversold bucket, seat taken, wrong status, window closed (`CONFLICT` or a specific code)."),
};

// ---- operations -----------------------------------------------------------

interface OperationDef {
  method: HttpMethod;
  /** OpenAPI path with `{param}` placeholders that mirror the route folder names. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: Access;
  pathParams?: Record<string, string>;
  query?: z.ZodType;
  body?: z.ZodType | JsonSchema;
  bodyRequired?: boolean;
  /** Success responses by status code. */
  ok: Record<string, { description: string; schema?: JsonSchema; html?: boolean }>;
  /** Extra documented error statuses on top of the automatic ones (400/401/403/404). */
  errors?: (409 | 402 | 401 | 503)[];
}

const ACCESS_TEXT: Record<Access, string> = {
  public: "Public (no token required).",
  any: "Any authenticated user (passenger or staff); passengers only reach their own resources.",
  staff: "Staff only.",
};

const flightIdParam = { id: "Flight id (24-char ObjectId)." };

const OPERATIONS: OperationDef[] = [
  // ---- system / docs
  { method: "get", path: "/api/health", tag: "System", summary: "Health check (pings MongoDB)", access: "public", ok: { "200": { description: "Service and database are up.", schema: obj({ status: enumOf("ok"), db: enumOf("up") }) } }, errors: [503] },
  { method: "get", path: "/api/docs", tag: "System", summary: "This OpenAPI 3.0 document (JSON)", access: "public", ok: { "200": { description: "The OpenAPI document.", schema: { type: "object" } } } },
  { method: "get", path: "/api/docs/ui", tag: "System", summary: "Swagger UI (HTML) for this API", access: "public", ok: { "200": { description: "An HTML page that loads Swagger UI from a CDN.", html: true } } },

  // ---- auth
  { method: "post", path: "/api/auth/register", tag: "Auth", summary: "Register a passenger account", description: "Self-registration always creates a `passenger`.", access: "public", body: registerSchema, ok: { "201": { description: "Created.", schema: obj({ user: ref("User") }) } }, errors: [409] },
  { method: "post", path: "/api/auth/login", tag: "Auth", summary: "Log in", description: "Returns a JWT (use it as `Authorization: Bearer <token>`) and also sets the httpOnly `pss_token` cookie.", access: "public", body: loginSchema, ok: { "200": { description: "Logged in.", schema: obj({ token: str(), user: ref("User") }) } }, errors: [401] },
  { method: "post", path: "/api/auth/logout", tag: "Auth", summary: "Log out (clears the cookie)", access: "public", ok: { "200": { description: "Cookie cleared.", schema: obj({ ok: bool() }) } } },
  { method: "get", path: "/api/auth/me", tag: "Auth", summary: "Current user", access: "any", ok: { "200": { description: "The authenticated user.", schema: obj({ user: ref("User") }) } } },
  { method: "post", path: "/api/auth/staff", tag: "Auth", summary: "Create a staff account", description: "An existing staff member creates another staff account.", access: "staff", body: createStaffSchema, ok: { "201": { description: "Created.", schema: obj({ user: ref("User") }) } }, errors: [409] },

  // ---- aircraft
  { method: "get", path: "/api/aircraft", tag: "Reservations - Aircraft", summary: "List aircraft", access: "staff", query: aircraftListQuery, ok: { "200": { description: "Paginated aircraft.", schema: page(ref("Aircraft")) } } },
  { method: "post", path: "/api/aircraft", tag: "Reservations - Aircraft", summary: "Create an aircraft", description: "Provide `capacity` and/or cabin layouts; when only cabins are given the capacity is derived from them.", access: "staff", body: createAircraftSchema, ok: { "201": { description: "Created.", schema: obj({ aircraft: ref("Aircraft") }) } }, errors: [409] },
  { method: "get", path: "/api/aircraft/{id}", tag: "Reservations - Aircraft", summary: "Get an aircraft", access: "staff", pathParams: { id: "Aircraft id." }, ok: { "200": { description: "The aircraft.", schema: obj({ aircraft: ref("Aircraft") }) } } },
  { method: "patch", path: "/api/aircraft/{id}", tag: "Reservations - Aircraft", summary: "Update an aircraft", access: "staff", pathParams: { id: "Aircraft id." }, body: updateAircraftSchema, ok: { "200": { description: "Updated.", schema: obj({ aircraft: ref("Aircraft") }) } }, errors: [409] },

  // ---- flights
  { method: "get", path: "/api/flights", tag: "Reservations - Flights", summary: "List flights", access: "any", query: flightListQuery, ok: { "200": { description: "Paginated flights ordered by departure.", schema: page(ref("Flight")) } } },
  { method: "post", path: "/api/flights", tag: "Reservations - Flights", summary: "Create a flight", description: "Optionally creates the flight's inventory in the same call through the `inventory` field (defaults come from the aircraft layout).", access: "staff", body: createFlightSchema, ok: { "201": { description: "Created.", schema: obj({ flight: ref("Flight"), inventory: ref("Inventory") }, ["flight"]) } }, errors: [409] },
  { method: "get", path: "/api/flights/search", tag: "Reservations - Flights", summary: "Search flights", description: "Scheduled flights for a route and UTC day that still have an open bucket with enough seats and an active fare. Buckets closed by a revenue rule or a manual override do not appear.", access: "public", query: flightSearchQuery, ok: { "200": { description: "Matching flights with their lowest open fare per cabin.", schema: obj({ flights: arr(ref("FlightSearchResult")), count: int() }) } } },
  { method: "get", path: "/api/flights/{id}", tag: "Reservations - Flights", summary: "Get a flight", access: "any", pathParams: flightIdParam, ok: { "200": { description: "The flight.", schema: obj({ flight: ref("Flight") }) } } },
  { method: "patch", path: "/api/flights/{id}", tag: "Reservations - Flights", summary: "Update or cancel a flight", description: "Only `status` SCHEDULED/CANCELLED may be set here; BOARDING/CLOSED/DEPARTED are driven by departure control. Flight number, route and aircraft cannot change while active PNRs exist (409).", access: "staff", pathParams: flightIdParam, body: updateFlightSchema, ok: { "200": { description: "Updated.", schema: obj({ flight: ref("Flight") }) } }, errors: [409] },
  { method: "delete", path: "/api/flights/{id}", tag: "Reservations - Flights", summary: "Cancel a flight (soft delete)", description: "Sets the status to CANCELLED. 409 while active PNRs exist.", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "The cancelled flight.", schema: obj({ flight: ref("Flight") }) } }, errors: [409] },
  { method: "get", path: "/api/flights/{id}/fares", tag: "Reservations - Flights", summary: "Fares currently on sale for a flight", description: "One cheapest fare per OPEN bucket with enough seats (`?passengers=n`), sorted by price.", access: "public", pathParams: flightIdParam, query: flightFaresQuery, ok: { "200": { description: "Open fares.", schema: obj({ flightId: oid(), fares: arr(ref("OfferedFare")) }) } } },
  { method: "get", path: "/api/flights/{id}/seatmap", tag: "DCS - Check-in", summary: "Seat map with occupancy", description: "Passengers see AVAILABLE/OCCUPIED only; staff additionally get an `occupant` reference per seat.", access: "any", pathParams: flightIdParam, ok: { "200": { description: "The seat map.", schema: obj({ seatMap: ref("SeatMap") }) } }, errors: [409] },

  // ---- fares
  { method: "get", path: "/api/fares", tag: "Reservations - Fares", summary: "List fares", access: "staff", query: fareListQuery, ok: { "200": { description: "Paginated fares.", schema: page(ref("Fare")) } } },
  { method: "post", path: "/api/fares", tag: "Reservations - Fares", summary: "Create a fare", description: "A flight fare (`flightId`) or a route fare (`origin` + `destination`). A flight fare wins over a route fare for the same class.", access: "staff", body: createFareSchema, ok: { "201": { description: "Created.", schema: obj({ fare: ref("Fare") }) } } },
  { method: "get", path: "/api/fares/{id}", tag: "Reservations - Fares", summary: "Get a fare", access: "staff", pathParams: { id: "Fare id." }, ok: { "200": { description: "The fare.", schema: obj({ fare: ref("Fare") }) } } },
  { method: "patch", path: "/api/fares/{id}", tag: "Reservations - Fares", summary: "Update a fare", access: "staff", pathParams: { id: "Fare id." }, body: updateFareSchema, ok: { "200": { description: "Updated.", schema: obj({ fare: ref("Fare") }) } } },
  { method: "delete", path: "/api/fares/{id}", tag: "Reservations - Fares", summary: "Deactivate a fare", description: "Fares referenced by PNRs and tickets are never hard-deleted: this sets `active: false`.", access: "staff", pathParams: { id: "Fare id." }, ok: { "200": { description: "The deactivated fare.", schema: obj({ fare: ref("Fare") }) } } },

  // ---- inventory
  { method: "get", path: "/api/inventory/{flightId}", tag: "Inventory", summary: "Seat availability per bucket", description: "Staff get the full picture (counters, sources, holds, rules, optional `?history=true`) under `inventory`; passengers get only open buckets with seats left under `availability`.", access: "any", pathParams: { flightId: "Flight id." }, query: availabilityQuerySchema, ok: { "200": { description: "Staff: `{ inventory }`, passenger: `{ availability }`.", schema: { oneOf: [obj({ inventory: ref("Inventory") }), obj({ availability: ref("PublicAvailability") })] } } } },
  { method: "post", path: "/api/inventory/{flightId}", tag: "Inventory", summary: "Create the inventory of a flight", description: "The body is optional; cabins and buckets default from the aircraft layout.", access: "staff", pathParams: { flightId: "Flight id." }, body: inventoryConfigSchema, bodyRequired: false, ok: { "201": { description: "Created.", schema: obj({ inventory: ref("Inventory") }) } }, errors: [409] },
  { method: "patch", path: "/api/inventory/{flightId}/buckets/{class}", tag: "Inventory", summary: "Manually open/close a bucket or change its authorization", description: "A manual open/close takes precedence over the revenue rules until `releaseToRules: true` hands the bucket back. `authorized` cannot drop below sold + held (409).", access: "staff", pathParams: { flightId: "Flight id.", class: "Booking class letter, e.g. `Q`." }, body: patchBucketSchema, ok: { "200": { description: "The updated bucket.", schema: obj({ bucket: ref("Bucket") }) } }, errors: [409] },
  { method: "post", path: "/api/inventory/{flightId}/reprice", tag: "Inventory", summary: "Re-run the revenue rules engine", access: "staff", pathParams: { flightId: "Flight id." }, ok: { "200": { description: "Buckets the engine opened or closed, plus the new inventory.", schema: obj({ changes: arr(obj({ cabin: CABIN, class: str(), action: enumOf("CLOSED", "REOPENED"), reason: str() })), inventory: ref("Inventory") }) } } },
  { method: "put", path: "/api/inventory/{flightId}/rules", tag: "Inventory", summary: "Replace the revenue rules", description: "Replaces the load-factor and time-to-departure rules, then re-runs the engine.", access: "staff", pathParams: { flightId: "Flight id." }, body: rulesSchema, ok: { "200": { description: "The inventory with the new rules applied.", schema: obj({ inventory: ref("Inventory") }) } } },

  // ---- PNRs
  { method: "get", path: "/api/pnrs", tag: "Reservations - PNRs", summary: "List PNRs", description: "Passengers see their own PNRs; staff see all (extra filters: status, locator, ownerUserId, email, flightId).", access: "any", query: pnrListQuery, ok: { "200": { description: "Paginated PNRs.", schema: page(ref("Pnr")) } } },
  { method: "post", path: "/api/pnrs", tag: "Reservations - PNRs", summary: "Create a PNR (holds seats)", description: "Validates the itinerary, holds one seat per non-infant passenger per segment atomically (409 instead of overselling) and returns a HELD PNR whose hold expires after 15 minutes. Staff may book for another account with `ownerUserId`/`ownerEmail`.", access: "any", body: createPnrSchema, ok: { "201": { description: "HELD PNR.", schema: obj({ pnr: ref("Pnr") }) } }, errors: [409] },
  { method: "get", path: "/api/pnrs/{locator}", tag: "Reservations - PNRs", summary: "Get a PNR with its tickets", description: "Owner or staff. A lapsed hold is flipped to EXPIRED lazily here.", access: "any", pathParams: { locator: "6-character record locator." }, ok: { "200": { description: "The PNR and its tickets.", schema: obj({ pnr: ref("Pnr"), tickets: arr(ref("Ticket")) }) } } },
  { method: "patch", path: "/api/pnrs/{locator}", tag: "Reservations - PNRs", summary: "Change passenger details, contact or itinerary", description: "Names are locked once TICKETED; rescheduling (`segments`) is only possible while HELD.", access: "any", pathParams: { locator: "6-character record locator." }, body: updatePnrSchema, ok: { "200": { description: "Updated.", schema: obj({ pnr: ref("Pnr") }) } }, errors: [409] },
  { method: "post", path: "/api/pnrs/{locator}/cancel", tag: "Reservations - PNRs", summary: "Cancel a PNR", description: "Owner or staff. Releases held seats, or voids every ticket and releases the sold seats. Idempotent. NOTE: it does not delete DCS check-ins; the gate refuses to board passengers whose ticket is not ISSUED.", access: "any", pathParams: { locator: "6-character record locator." }, ok: { "200": { description: "Result.", schema: obj({ pnr: ref("Pnr"), alreadyCancelled: bool(), heldSeatsReleased: int(), ticketsVoided: int() }) } }, errors: [409] },
  { method: "get", path: "/api/pnrs/{locator}/tickets", tag: "Reservations - Tickets", summary: "List the tickets of a PNR", access: "any", pathParams: { locator: "6-character record locator." }, ok: { "200": { description: "Tickets.", schema: obj({ tickets: arr(ref("Ticket")) }) } } },
  { method: "post", path: "/api/pnrs/{locator}/tickets", tag: "Reservations - Tickets", summary: "Pay and issue tickets", description: "Owner passenger (payment required) or staff (payment optional). The payment is simulated: `{ \"payment\": { \"method\": \"card\", \"simulate\": \"success\" } }` (use `\"fail\"` to see a 402). Idempotent: a repeat call returns the existing tickets with `alreadyIssued: true` (200).", access: "any", pathParams: { locator: "6-character record locator." }, body: issueTicketsSchema, bodyRequired: false, ok: { "201": { description: "Tickets issued; PNR is TICKETED.", schema: obj({ pnr: ref("Pnr"), tickets: arr(ref("Ticket")), payment: { allOf: [ref("PaymentReceipt")], nullable: true }, alreadyIssued: bool() }) }, "200": { description: "Already issued earlier (`alreadyIssued: true`).", schema: obj({ pnr: ref("Pnr"), tickets: arr(ref("Ticket")), payment: { nullable: true, type: "object" }, alreadyIssued: bool() }) } }, errors: [402, 409] },
  { method: "get", path: "/api/tickets/{ticketNumber}", tag: "Reservations - Tickets", summary: "Get a ticket by its 13-digit number", description: "Ticket owner (via the PNR) or staff.", access: "any", pathParams: { ticketNumber: "13-digit ticket number." }, ok: { "200": { description: "The ticket.", schema: obj({ ticket: ref("Ticket") }) } } },
  { method: "post", path: "/api/tickets/{ticketNumber}/void", tag: "Reservations - Tickets", summary: "Void a ticket", description: "Voids the ticket and releases its seat. When every ticket of the PNR is void the PNR becomes CANCELLED. A void ticket cannot be scanned at the gate.", access: "staff", pathParams: { ticketNumber: "13-digit ticket number." }, body: { type: "object", properties: { reason: { type: "string", maxLength: 200 } } }, bodyRequired: false, ok: { "200": { description: "Voided.", schema: obj({ ticket: ref("Ticket"), pnr: ref("Pnr") }) } }, errors: [409] },

  // ---- check-in
  { method: "post", path: "/api/checkin", tag: "DCS - Check-in", summary: "Check a passenger in", description: "Passenger (own PNR, `channel: ONLINE`) or staff (ONLINE/AIRPORT, any PNR). Window: 24 h before departure until 45 min before (staff may set `override: true` after the cut-off). Infants get no seat. Generates the boarding pass and the boarding sequence.", access: "any", body: checkInSchema, ok: { "201": { description: "Checked in.", schema: obj({ checkIn: ref("CheckIn"), boardingPass: ref("BoardingPass") }) } }, errors: [409] },
  { method: "get", path: "/api/checkin", tag: "DCS - Check-in", summary: "List check-ins", description: "Staff: by `flightId` and/or `pnr`. Passengers must pass their own `pnr`.", access: "any", query: checkInListQuerySchema, ok: { "200": { description: "Check-ins.", schema: obj({ checkIns: arr(ref("CheckIn")), total: int(), page: int(), limit: int() }) } } },
  { method: "post", path: "/api/checkin/{id}/cancel", tag: "DCS - Check-in", summary: "Cancel a check-in (before boarding)", description: "Owner or staff. Frees the seat and deletes the boarding pass; refused after boarding or while bags are still checked.", access: "any", pathParams: { id: "Check-in id." }, ok: { "200": { description: "Cancelled.", schema: obj({ cancelled: bool(), checkInId: oid() }) } }, errors: [409] },
  { method: "get", path: "/api/boarding-passes", tag: "DCS - Check-in", summary: "Boarding passes of a PNR", access: "any", query: boardingPassListQuerySchema, ok: { "200": { description: "Boarding passes.", schema: obj({ boardingPasses: arr(ref("BoardingPass")) }) } } },
  { method: "get", path: "/api/boarding-passes/{checkInId}", tag: "DCS - Check-in", summary: "Boarding pass of a check-in", description: "Owner or staff. Includes the BCBP-style `barcode`.", access: "any", pathParams: { checkInId: "Check-in id." }, ok: { "200": { description: "The boarding pass.", schema: obj({ boardingPass: ref("BoardingPass") }) } }, errors: [409] },

  // ---- baggage
  { method: "post", path: "/api/baggage", tag: "DCS - Baggage", summary: "Tag a bag", description: "The passenger must be checked in. The fare's free allowance is a per-passenger total; going over it gives 409 `BAGGAGE_OVER_ALLOWANCE` unless `acceptExcess: true`.", access: "staff", body: baggageCreateSchema, ok: { "201": { description: "Tagged.", schema: obj({ baggage: ref("Baggage") }) } }, errors: [409] },
  { method: "get", path: "/api/baggage", tag: "DCS - Baggage", summary: "List bags", description: "Staff: by `pnr` and/or `flightId`. Passengers only see bags of PNRs they own.", access: "any", query: baggageListQuerySchema, ok: { "200": { description: "Bags.", schema: obj({ baggage: arr(ref("Baggage")), total: int(), page: int(), limit: int() }) } } },
  { method: "get", path: "/api/baggage/{tag}", tag: "DCS - Baggage", summary: "Get a bag by tag number", access: "any", pathParams: { tag: "Bag tag number, e.g. PS0123456789." }, ok: { "200": { description: "The bag.", schema: obj({ baggage: ref("Baggage") }) } } },
  { method: "patch", path: "/api/baggage/{tag}", tag: "DCS - Baggage", summary: "Move a bag through its statuses", description: "CHECKED -> SCREENED -> LOADED, or OFFLOADED from any non-final status (OFFLOADED is final).", access: "staff", pathParams: { tag: "Bag tag number." }, body: baggageStatusSchema, ok: { "200": { description: "Updated.", schema: obj({ baggage: ref("Baggage") }) } }, errors: [409] },

  // ---- load control
  { method: "get", path: "/api/flights/{id}/load", tag: "DCS - Load control", summary: "Live load computation and saved sheet", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Live computation plus the saved load sheet (if any).", schema: ref("LoadView") } } },
  { method: "post", path: "/api/flights/{id}/load", tag: "DCS - Load control", summary: "Save the DRAFT load sheet (cargo and fuel)", access: "staff", pathParams: flightIdParam, body: loadInputSchema, ok: { "200": { description: "Saved.", schema: ref("LoadView") } }, errors: [409] },
  { method: "post", path: "/api/flights/{id}/load/finalize", tag: "DCS - Load control", summary: "Finalize the load sheet", description: "409 `LOAD_LIMITS_EXCEEDED` when an aircraft limit is exceeded, or when no draft exists / already FINAL. A FINAL sheet is required to open and close boarding.", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Finalized.", schema: ref("LoadView") } }, errors: [409] },
  { method: "post", path: "/api/flights/{id}/load/reopen", tag: "DCS - Load control", summary: "Reopen a FINAL load sheet (back to DRAFT)", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Reopened.", schema: ref("LoadView") } }, errors: [409] },

  // ---- gate boarding
  { method: "get", path: "/api/flights/{id}/boarding", tag: "DCS - Boarding", summary: "Boarding manifest and counts", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Manifest.", schema: ref("Manifest") } } },
  { method: "post", path: "/api/flights/{id}/boarding/open", tag: "DCS - Boarding", summary: "Open boarding", description: "SCHEDULED -> BOARDING. Requires a FINAL load sheet (409 `LOAD_SHEET_NOT_FINAL`). The body is optional (`{ gate }`).", access: "staff", pathParams: flightIdParam, body: openBoardingSchema, bodyRequired: false, ok: { "200": { description: "The flight.", schema: obj({ flight: ref("Flight") }) } }, errors: [409] },
  { method: "post", path: "/api/flights/{id}/boarding/scan", tag: "DCS - Boarding", summary: "Scan a boarding pass at the gate", description: "Send exactly one of `barcode` or `checkInId`. Right flight, checked in and an ISSUED ticket are required. A second scan gives 409 `ALREADY_BOARDED`; a void/cancelled ticket gives 409 `TICKET_NOT_VALID`.", access: "staff", pathParams: flightIdParam, body: scanSchema, ok: { "200": { description: "Boarded.", schema: ref("ScanResult") } }, errors: [409] },
  { method: "post", path: "/api/flights/{id}/boarding/close", tag: "DCS - Boarding", summary: "Close boarding", description: "BOARDING -> CLOSED (FINAL load sheet still required). Checked-in-but-not-boarded passengers become NO_SHOW, their bags are offloaded, and the seats of no-shows and never-checked-in passengers return to inventory.", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Summary.", schema: obj({ summary: ref("CloseSummary") }) } }, errors: [409] },
  { method: "post", path: "/api/flights/{id}/boarding/depart", tag: "DCS - Boarding", summary: "Depart the flight", description: "CLOSED -> DEPARTED; the tickets of boarded passengers become USED.", access: "staff", pathParams: flightIdParam, ok: { "200": { description: "Departed.", schema: obj({ result: obj({ flightId: oid(), status: enumOf("DEPARTED"), boarded: int(), ticketsUsed: int() }) }) } }, errors: [409] },
];

// ---- assembly -------------------------------------------------------------

const BEARER_OR_COOKIE: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];

function buildOperation(def: OperationDef): OpenApiOperation {
  const parameters: OpenApiParameter[] = [
    ...Object.entries(def.pathParams ?? {}).map(([name, description]) => ({
      name,
      in: "path" as const,
      required: true,
      description,
      schema: { type: "string" },
    })),
    ...(def.query ? queryParameters(def.query) : []),
  ];

  const statuses: Record<string, JsonSchema> = {};
  for (const [status, r] of Object.entries(def.ok)) {
    statuses[status] = {
      description: r.description,
      ...(r.html
        ? { content: { "text/html": { schema: { type: "string" } } } }
        : r.schema
          ? { content: { "application/json": { schema: r.schema } } }
          : {}),
    };
  }

  const hasInput = Boolean(def.body) || Boolean(def.query) || Boolean(def.pathParams);
  if (hasInput) statuses["400"] = { $ref: "#/components/responses/BadRequest" };
  if (def.access !== "public" || def.errors?.includes(401)) statuses["401"] = { $ref: "#/components/responses/Unauthorized" };
  if (def.errors?.includes(402)) statuses["402"] = { $ref: "#/components/responses/PaymentRequired" };
  if (def.access !== "public") statuses["403"] = { $ref: "#/components/responses/Forbidden" };
  if (def.pathParams) statuses["404"] = { $ref: "#/components/responses/NotFound" };
  if (def.errors?.includes(409)) statuses["409"] = { $ref: "#/components/responses/Conflict" };
  if (def.errors?.includes(503)) {
    statuses["503"] = {
      description: "The database is unreachable.",
      content: { "application/json": { schema: obj({ status: enumOf("error"), db: enumOf("down") }) } },
    };
  }

  const roles = def.access === "public" ? [] : def.access === "staff" ? ["staff"] : ["passenger", "staff"];
  const operation: OpenApiOperation = {
    tags: [def.tag],
    summary: def.summary,
    description: `**Access:** ${ACCESS_TEXT[def.access]}${def.description ? `\n\n${def.description}` : ""}`,
    operationId: `${def.method}${def.path.replace(/[{}]/g, "").replace(/(^|[/-])(\w)/g, (_m, _p, c: string) => c.toUpperCase())}`,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(def.body
      ? {
          requestBody: {
            required: def.bodyRequired ?? true,
            content: { "application/json": { schema: isZod(def.body) ? fromZod(def.body) : def.body } },
          },
        }
      : {}),
    responses: statuses,
    security: def.access === "public" ? [] : BEARER_OR_COOKIE,
    "x-roles": roles,
  };
  return operation;
}

const isZod = (value: unknown): value is z.ZodType => typeof value === "object" && value !== null && "_zod" in value;

export function buildOpenApiSpec(): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const def of OPERATIONS) {
    (paths[def.path] ??= {})[def.method] = buildOperation(def);
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Airline Passenger Service System API",
      version: "1.0.0",
      description:
        "REST API of a Passenger Service System with three modules: Reservations (flights, fares, PNRs, tickets), " +
        "Inventory (fare-class buckets, atomic holds, revenue rules) and Departure Control (check-in, baggage, boarding passes, " +
        "load control, gate boarding).\n\n" +
        "**Authentication:** log in with `POST /api/auth/login`, then send the token as `Authorization: Bearer <token>` " +
        "(or rely on the `pss_token` httpOnly cookie that login sets). Roles: `passenger` and `staff`.\n\n" +
        "**Errors:** every failure uses `{ \"error\": { \"code\", \"message\", \"details?\" } }` with 400 (validation), 401, 402 (declined payment), 403, 404, 409 (conflict / business rule) or 500.\n\n" +
        "Payment is simulated; there is a single airline and a single currency.",
    },
    servers: [{ url: "/", description: "This server" }],
    tags: [
      { name: "System", description: "Health and documentation." },
      { name: "Auth", description: "Registration, login and accounts." },
      { name: "Reservations - Aircraft", description: "Aircraft types and cabin layouts (staff)." },
      { name: "Reservations - Flights", description: "Flight schedules and search." },
      { name: "Reservations - Fares", description: "Fare management (staff)." },
      { name: "Reservations - PNRs", description: "Passenger name records." },
      { name: "Reservations - Tickets", description: "Simulated payment, ticket issuance and voiding." },
      { name: "Inventory", description: "Fare-class buckets, availability and revenue rules." },
      { name: "DCS - Check-in", description: "Check-in, seat map and boarding passes." },
      { name: "DCS - Baggage", description: "Bag tags and baggage tracking." },
      { name: "DCS - Load control", description: "Weight and balance, load sheet." },
      { name: "DCS - Boarding", description: "Gate boarding, no-shows and departure." },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Token from POST /api/auth/login." },
        cookieAuth: { type: "apiKey", in: "cookie", name: "pss_token", description: "httpOnly cookie set by POST /api/auth/login." },
      },
      schemas,
      responses,
    },
  };
}

/** The documented operations as `METHOD path` keys (used by the drift test). */
export function listOperations(spec: OpenApiDocument = buildOpenApiSpec()): string[] {
  return Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`));
}
