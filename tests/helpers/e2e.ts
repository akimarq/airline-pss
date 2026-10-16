/**
 * Helpers for the end-to-end API tests: every call goes through the REAL route handlers with real `Request`
 * objects and real JWTs obtained from `POST /api/auth/login`, against the in-memory MongoDB.
 */
import * as aircraftRoute from "@/app/api/aircraft/route";
import * as baggageRoute from "@/app/api/baggage/route";
import * as baggageTagRoute from "@/app/api/baggage/[tag]/route";
import * as boardingRoute from "@/app/api/flights/[id]/boarding/route";
import * as boardingCloseRoute from "@/app/api/flights/[id]/boarding/close/route";
import * as boardingDepartRoute from "@/app/api/flights/[id]/boarding/depart/route";
import * as boardingOpenRoute from "@/app/api/flights/[id]/boarding/open/route";
import * as boardingScanRoute from "@/app/api/flights/[id]/boarding/scan/route";
import * as bpListRoute from "@/app/api/boarding-passes/route";
import * as bpRoute from "@/app/api/boarding-passes/[checkInId]/route";
import * as checkinRoute from "@/app/api/checkin/route";
import * as checkinCancelRoute from "@/app/api/checkin/[id]/cancel/route";
import * as faresRoute from "@/app/api/fares/route";
import * as flightFaresRoute from "@/app/api/flights/[id]/fares/route";
import * as flightRoute from "@/app/api/flights/[id]/route";
import * as flightsRoute from "@/app/api/flights/route";
import * as inventoryRoute from "@/app/api/inventory/[flightId]/route";
import * as inventoryBucketRoute from "@/app/api/inventory/[flightId]/buckets/[class]/route";
import * as inventoryRepriceRoute from "@/app/api/inventory/[flightId]/reprice/route";
import * as inventoryRulesRoute from "@/app/api/inventory/[flightId]/rules/route";
import * as loadRoute from "@/app/api/flights/[id]/load/route";
import * as loadFinalizeRoute from "@/app/api/flights/[id]/load/finalize/route";
import * as loadReopenRoute from "@/app/api/flights/[id]/load/reopen/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as pnrCancelRoute from "@/app/api/pnrs/[locator]/cancel/route";
import * as pnrRoute from "@/app/api/pnrs/[locator]/route";
import * as pnrTicketsRoute from "@/app/api/pnrs/[locator]/tickets/route";
import * as pnrsRoute from "@/app/api/pnrs/route";
import * as registerRoute from "@/app/api/auth/register/route";
import * as searchRoute from "@/app/api/flights/search/route";
import * as seatmapRoute from "@/app/api/flights/[id]/seatmap/route";
import * as staffRoute from "@/app/api/auth/staff/route";
import * as ticketRoute from "@/app/api/tickets/[ticketNumber]/route";
import * as ticketVoidRoute from "@/app/api/tickets/[ticketNumber]/void/route";
import { createUser } from "@/modules/auth/service";
import { call } from "./booking";

export const routes = {
  aircraftRoute,
  baggageRoute,
  baggageTagRoute,
  boardingRoute,
  boardingCloseRoute,
  boardingDepartRoute,
  boardingOpenRoute,
  boardingScanRoute,
  bpListRoute,
  bpRoute,
  checkinRoute,
  checkinCancelRoute,
  faresRoute,
  flightFaresRoute,
  flightRoute,
  flightsRoute,
  inventoryRoute,
  inventoryBucketRoute,
  inventoryRepriceRoute,
  inventoryRulesRoute,
  loadRoute,
  loadFinalizeRoute,
  loadReopenRoute,
  loginRoute,
  meRoute,
  pnrCancelRoute,
  pnrRoute,
  pnrTicketsRoute,
  pnrsRoute,
  registerRoute,
  searchRoute,
  seatmapRoute,
  staffRoute,
  ticketRoute,
  ticketVoidRoute,
};
export const r = routes;

type Params = Record<string, string>;
type Methods = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type RouteModule = Partial<Record<Methods, unknown>>;

/** `/api/pnrs/:locator/cancel` + `{ locator }` -> real path; the same params become the route context. */
const fill = (template: string, params: Params = {}) =>
  template.replace(/:(\w+)/g, (_m, key: string) => encodeURIComponent(params[key] ?? `MISSING_${key}`));

/** A caller (anonymous when `token` is omitted) that talks to the route handlers. */
export function client(token?: string) {
  const send = (method: Methods, route: RouteModule, template: string, body?: unknown, params?: Params) =>
    call(route[method], method, fill(template, params), { token, body, params });
  return {
    get: (route: RouteModule, template: string, params?: Params) => send("GET", route, template, undefined, params),
    post: (route: RouteModule, template: string, body?: unknown, params?: Params) => send("POST", route, template, body, params),
    patch: (route: RouteModule, template: string, body?: unknown, params?: Params) => send("PATCH", route, template, body, params),
    put: (route: RouteModule, template: string, body?: unknown, params?: Params) => send("PUT", route, template, body, params),
    del: (route: RouteModule, template: string, params?: Params) => send("DELETE", route, template, undefined, params),
  };
}
export type Client = ReturnType<typeof client>;

export interface Actor {
  id: string;
  email: string;
  token: string;
  api: Client;
}

async function login(email: string, password: string): Promise<Actor> {
  const res = await client().post(loginRoute, "/api/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.json)}`);
  return { id: res.json.user.id, email, token: res.json.token, api: client(res.json.token) };
}

/** Staff accounts cannot self-register: create it through the service, then log in through the API. */
export async function makeStaff(email = "staff@e2e.test"): Promise<Actor> {
  await createUser({ email, password: "Staff123!", name: "E2E Staff", role: "staff" });
  return login(email, "Staff123!");
}

/** A passenger that registers and logs in through the API like a real user. */
export async function makePassenger(email: string, name = "E2E Passenger"): Promise<Actor> {
  const res = await client().post(registerRoute, "/api/auth/register", { email, password: "Passenger123!", name });
  if (res.status !== 201) throw new Error(`register failed for ${email}: ${JSON.stringify(res.json)}`);
  return login(email, "Passenger123!");
}

export const HOUR = 3_600_000;
export const DAY_HOURS = 24;
let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`.toUpperCase();

export interface FlightOptions {
  hoursAhead?: number;
  flightNumber?: string;
  origin?: string;
  destination?: string;
  /** Request body `inventory` of POST /api/flights. */
  inventory?: unknown;
  /** Flight fares to create through POST /api/fares (default: Y 200, M 120, Q 80, J 500). */
  fares?: { fareBasis: string; bookingClass: string; cabin: "F" | "J" | "Y"; price: number; rules?: Record<string, unknown> }[];
  aircraftBody?: Record<string, unknown>;
}

export const DEFAULT_FARES: NonNullable<FlightOptions["fares"]> = [
  { fareBasis: "YFLEX", bookingClass: "Y", cabin: "Y", price: 200 },
  { fareBasis: "MSAVER", bookingClass: "M", cabin: "Y", price: 120 },
  { fareBasis: "QDEEP", bookingClass: "Q", cabin: "Y", price: 80 },
  { fareBasis: "JBIZ", bookingClass: "J", cabin: "J", price: 500 },
];

export const AIRCRAFT_BODY = {
  type: "A320",
  cabins: [
    { cabin: "J", firstRow: 1, lastRow: 1, seatLetters: ["A", "C", "D", "F"] },
    { cabin: "Y", firstRow: 2, lastRow: 5, seatLetters: ["A", "B", "C", "D"] },
  ],
  operatingEmptyWeightKg: 42_000,
  maxZeroFuelWeightKg: 62_500,
  maxTakeoffWeightKg: 78_000,
  maxPayloadKg: 20_000,
  maxCargoWeightKg: 3_000,
};

export interface FlightFixture {
  aircraftId: string;
  flightId: string;
  flightNumber: string;
  departure: Date;
  /** UTC calendar day of the departure, as used by the search endpoint. */
  date: string;
}

/** Staff creates an aircraft, a flight (with inventory) and fares, all through the API. */
export async function createFlightViaApi(staff: Actor, opts: FlightOptions = {}): Promise<FlightFixture> {
  const aircraft = await staff.api.post(aircraftRoute, "/api/aircraft", {
    ...AIRCRAFT_BODY,
    registration: `PS-${uniq()}`.slice(0, 12),
    ...opts.aircraftBody,
  });
  if (aircraft.status !== 201) throw new Error(`aircraft: ${JSON.stringify(aircraft.json)}`);

  const departure = new Date(Date.now() + (opts.hoursAhead ?? 10) * HOUR);
  const flightNumber = opts.flightNumber ?? `PS${100 + (seq++ % 800)}`;
  const flight = await staff.api.post(flightsRoute, "/api/flights", {
    flightNumber,
    origin: opts.origin ?? "MNL",
    destination: opts.destination ?? "CEB",
    departure: departure.toISOString(),
    arrival: new Date(departure.getTime() + 90 * 60_000).toISOString(),
    aircraftId: aircraft.json.aircraft.id,
    inventory: opts.inventory ?? {
      cabins: [
        { cabin: "J", buckets: [{ class: "J", authorized: 4 }] },
        {
          cabin: "Y",
          buckets: [
            { class: "Y", authorized: 16 },
            { class: "M", authorized: 10 },
            { class: "Q", authorized: 4 },
          ],
        },
      ],
    },
  });
  if (flight.status !== 201) throw new Error(`flight: ${JSON.stringify(flight.json)}`);
  const flightId: string = flight.json.flight.id;

  for (const fare of opts.fares ?? DEFAULT_FARES) {
    const res = await staff.api.post(faresRoute, "/api/fares", { flightId, ...fare });
    if (res.status !== 201) throw new Error(`fare: ${JSON.stringify(res.json)}`);
  }
  return { aircraftId: aircraft.json.aircraft.id, flightId, flightNumber, departure, date: departure.toISOString().slice(0, 10) };
}

export const CONTACT = { email: "contact@e2e.test", phone: "+639170000001" };
export const adult = (firstName = "Juan", lastName = "Dela Cruz") => ({ firstName, lastName, type: "ADULT" });

/** Create a PNR through the API; returns the raw response. */
export function book(actor: Actor, flightId: string, bookingClass: string, passengers: unknown[] = [adult()], extra: Record<string, unknown> = {}) {
  return actor.api.post(pnrsRoute, "/api/pnrs", { passengers, segments: [{ flightId, bookingClass }], contact: CONTACT, ...extra });
}

export const payOk = { payment: { method: "card", simulate: "success" } };

/** Book and pay; returns locator and the PNR view (passenger ids). */
export async function bookAndTicket(actor: Actor, flightId: string, bookingClass: string, passengers: unknown[] = [adult()], extra: Record<string, unknown> = {}) {
  const created = await book(actor, flightId, bookingClass, passengers, extra);
  if (created.status !== 201) throw new Error(`book: ${JSON.stringify(created.json)}`);
  const locator: string = created.json.pnr.recordLocator;
  const paid = await actor.api.post(pnrTicketsRoute, "/api/pnrs/:locator/tickets", payOk, { locator });
  if (paid.status !== 201) throw new Error(`ticket: ${JSON.stringify(paid.json)}`);
  return {
    locator,
    pnr: paid.json.pnr,
    tickets: paid.json.tickets as { id: string; ticketNumber: string; passengerId: string; status: string }[],
    passengerIds: (paid.json.pnr.passengers as { id: string }[]).map((p) => p.id),
  };
}

/** Staff finalizes a load sheet (cargo 0 / fuel 5000 unless given). */
export async function finalizeLoadSheet(staff: Actor, flightId: string, input = { cargoWeightKg: 0, fuelWeightKg: 5000 }) {
  const draft = await staff.api.post(loadRoute, "/api/flights/:id/load", input, { id: flightId });
  if (draft.status !== 200) throw new Error(`load draft: ${JSON.stringify(draft.json)}`);
  return staff.api.post(loadFinalizeRoute, "/api/flights/:id/load/finalize", undefined, { id: flightId });
}

/** Staff-side bucket counters of a flight, keyed by booking class. */
export async function bucketCounters(staff: Actor, flightId: string) {
  const res = await staff.api.get(inventoryRoute, "/api/inventory/:flightId", { flightId });
  const out: Record<string, { sold: number; held: number; available: number; open: boolean; source: string | null }> = {};
  for (const cabin of res.json.inventory.cabins) for (const b of cabin.buckets) out[b.class] = b;
  return { buckets: out, inventory: res.json.inventory };
}

