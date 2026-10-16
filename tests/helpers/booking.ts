import { NextRequest } from "next/server";
import { signToken } from "@/lib/auth";
import { Aircraft, Fare, Flight, type IFlight } from "@/models";
import { createUser } from "@/modules/auth/service";
import { createInventoryForFlight } from "@/modules/inventory/service";
import type { InventoryConfig } from "@/modules/inventory/schemas";
import type { Role } from "@/lib/roles";

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function makeUser(role: Role, email: string): Promise<TestUser> {
  const user = await createUser({ email, password: "Passw0rd!", name: email.split("@")[0], role });
  return { id: user.id, email, token: await signToken({ sub: user.id, role, email }) };
}

export function request(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** Route handler context with awaited-able params. */
export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) }) as never;

export type Handler = (req: NextRequest, ctx: never) => Promise<Response>;

export async function call(
  handler: unknown,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; params?: Record<string, string> } = {},
) {
  const res = await (handler as Handler)(request(method, path, opts), ctx(opts.params ?? {}));
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export const DAY = 86_400_000;

export async function makeAircraft(registration = "PS-TST1") {
  return Aircraft.create({
    type: "A320",
    registration,
    capacity: 20,
    cabins: [
      { cabin: "J", firstRow: 1, lastRow: 1, seatLetters: ["A", "C", "D", "F"] },
      { cabin: "Y", firstRow: 2, lastRow: 5, seatLetters: ["A", "B", "C", "D"] },
    ],
    operatingEmptyWeightKg: 42000,
    maxZeroFuelWeightKg: 62500,
    maxTakeoffWeightKg: 78000,
    maxPayloadKg: 20000,
    maxCargoWeightKg: 3000,
  });
}

export interface FlightFixture {
  flight: IFlight;
  flightId: string;
}

/** Create a flight (default MNL-CEB, `daysAhead` days out) with inventory and (by default) route + flight fares. */
export async function makeFlight(
  opts: {
    flightNumber?: string;
    origin?: string;
    destination?: string;
    daysAhead?: number;
    inventory?: InventoryConfig | false;
    aircraftId?: IFlight["aircraftId"];
    fares?: boolean;
  } = {},
): Promise<FlightFixture> {
  const aircraftId = opts.aircraftId ?? (await makeAircraft(`PS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`))._id;
  const departure = new Date(Date.now() + (opts.daysAhead ?? 10) * DAY);
  const flight = await Flight.create({
    flightNumber: opts.flightNumber ?? "PS101",
    origin: opts.origin ?? "MNL",
    destination: opts.destination ?? "CEB",
    departure,
    arrival: new Date(departure.getTime() + 90 * 60_000),
    aircraftId,
  });
  if (opts.inventory !== false) await createInventoryForFlight(flight._id, opts.inventory ?? {});
  if (opts.fares !== false) {
    const base = { flightId: flight._id, currency: "USD" };
    await Fare.create([
      { ...base, fareBasis: "YFLEX", bookingClass: "Y", cabin: "Y", price: 200 },
      { ...base, fareBasis: "MSAVER", bookingClass: "M", cabin: "Y", price: 120 },
      { ...base, fareBasis: "QDEEP", bookingClass: "Q", cabin: "Y", price: 80 },
      { ...base, fareBasis: "JBIZ", bookingClass: "J", cabin: "J", price: 500 },
    ]);
  }
  return { flight: flight.toObject(), flightId: flight._id.toString() };
}

/** Single-cabin inventory with explicit bucket sizes: handy for capacity tests. */
export const yConfig = (capacity: number, buckets: { class: string; authorized?: number }[], extra: Partial<InventoryConfig> = {}): InventoryConfig => ({
  cabins: [{ cabin: "Y", capacity, buckets }],
  ...extra,
});

export const adult = (firstName = "Juan", lastName = "Dela Cruz") => ({ firstName, lastName, type: "ADULT" as const });
