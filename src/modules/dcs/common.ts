import { Types } from "mongoose";
import { AppError } from "@/lib/errors";
import { Aircraft, Flight, PNR, type IAircraft, type IFlight, type IPNR } from "@/models";

export function toObjectId(value: string | Types.ObjectId, label = "id"): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  if (!Types.ObjectId.isValid(value) || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw AppError.badRequest(`Invalid ${label}`);
  }
  return new Types.ObjectId(value);
}

export async function getFlightOrThrow(flightId: string | Types.ObjectId): Promise<IFlight> {
  const flight = await Flight.findById(toObjectId(flightId, "flight id")).lean<IFlight>();
  if (!flight) throw AppError.notFound("Flight not found");
  return flight;
}

export async function getAircraftOrThrow(aircraftId: Types.ObjectId): Promise<IAircraft> {
  const aircraft = await Aircraft.findById(aircraftId).lean<IAircraft>();
  if (!aircraft) throw AppError.notFound("Aircraft for this flight not found");
  return aircraft;
}

export async function getPnrByLocator(locator: string): Promise<IPNR> {
  const pnr = await PNR.findOne({ recordLocator: locator.toUpperCase() }).lean<IPNR>();
  if (!pnr) throw AppError.notFound("PNR not found");
  return pnr;
}

export const passengerDisplayName = (p: { lastName: string; firstName: string }) =>
  `${p.lastName}/${p.firstName}`.toUpperCase();

export function isDuplicateKey(err: unknown): err is { code: number; keyPattern?: Record<string, unknown> } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

export function dupKeyFields(err: { keyPattern?: Record<string, unknown>; message?: string }): string[] {
  if (err.keyPattern) return Object.keys(err.keyPattern);
  const m = /index: (\S+)/.exec(err.message ?? "");
  return m ? [m[1]] : [];
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Page {
  page: number;
  limit: number;
}
