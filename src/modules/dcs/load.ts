import { AppError } from "@/lib/errors";
import type { AuthUser } from "@/lib/withAuth";
import {
  Baggage,
  CheckIn,
  LoadSheet,
  PNR,
  type IAircraft,
  type ICheckIn,
  type ILoadSheet,
  type IPNR,
  type PassengerType,
} from "@/models";
import { NEAR_LIMIT_RATIO, STANDARD_WEIGHTS_KG } from "./constants";
import { getAircraftOrThrow, getFlightOrThrow, isDuplicateKey, toObjectId } from "./common";

/**
 * Load control (simplified weight & balance)
 * ------------------------------------------
 *   passenger weight = adults * 84 + children * 35 + infants * 0   (standard weights, infants are lap infants)
 *   payload          = passenger weight + baggage weight (non-offloaded bags) + cargo
 *   zero-fuel weight = operating empty weight + payload
 *   takeoff weight   = zero-fuel weight + fuel
 * Checked against Aircraft: maxZeroFuelWeightKg, maxTakeoffWeightKg, maxPayloadKg, maxCargoWeightKg.
 * Passengers counted = check-ins in CHECKED_IN or BOARDED (NO_SHOW excluded). `passengerCount` excludes infants.
 * A total above a limit is an error (blocks finalize); at or above 95% of a limit is a warning only.
 * Cargo and fuel are staff inputs saved on the DRAFT; everything else is recomputed live.
 */

export interface LoadLimits {
  operatingEmptyWeightKg: number;
  maxZeroFuelWeightKg: number;
  maxTakeoffWeightKg: number;
  maxPayloadKg: number;
  maxCargoWeightKg: number;
}

export interface LoadComputation {
  adults: number;
  children: number;
  infants: number;
  passengerCount: number;
  passengerWeightKg: number;
  baggageCount: number;
  baggageWeightKg: number;
  cargoWeightKg: number;
  fuelWeightKg: number;
  payloadKg: number;
  zeroFuelWeightKg: number;
  takeoffWeightKg: number;
  withinLimits: boolean;
  /** Human readable: limit violations first ("EXCEEDS"), then near-limit and missing-input notes. */
  warnings: string[];
  limits: LoadLimits;
}

export interface LoadInputs {
  cargoWeightKg: number;
  fuelWeightKg: number;
}

export interface PassengerCounts {
  adults: number;
  children: number;
  infants: number;
}

/** Pure weight & balance calculation. */
export function computeLoad(
  counts: PassengerCounts,
  baggage: { count: number; weightKg: number },
  inputs: LoadInputs,
  limits: LoadLimits,
): LoadComputation {
  const passengerWeightKg =
    counts.adults * STANDARD_WEIGHTS_KG.ADULT +
    counts.children * STANDARD_WEIGHTS_KG.CHILD +
    counts.infants * STANDARD_WEIGHTS_KG.INFANT;
  const baggageWeightKg = baggage.weightKg;
  const payloadKg = passengerWeightKg + baggageWeightKg + inputs.cargoWeightKg;
  const zeroFuelWeightKg = limits.operatingEmptyWeightKg + payloadKg;
  const takeoffWeightKg = zeroFuelWeightKg + inputs.fuelWeightKg;

  const warnings: string[] = [];
  const checks: [string, number, number][] = [
    ["Zero-fuel weight", zeroFuelWeightKg, limits.maxZeroFuelWeightKg],
    ["Takeoff weight", takeoffWeightKg, limits.maxTakeoffWeightKg],
    ["Payload", payloadKg, limits.maxPayloadKg],
    ["Cargo weight", inputs.cargoWeightKg, limits.maxCargoWeightKg],
  ];
  let withinLimits = true;
  const near: string[] = [];
  for (const [label, value, max] of checks) {
    if (value > max) {
      withinLimits = false;
      warnings.push(`EXCEEDS: ${label} ${value}kg is above the maximum ${max}kg`);
    } else if (max > 0 && value >= max * NEAR_LIMIT_RATIO) {
      near.push(`NEAR LIMIT: ${label} ${value}kg is within 5% of the maximum ${max}kg`);
    }
  }
  warnings.push(...near);
  if (inputs.fuelWeightKg === 0) warnings.push("NOTE: fuel weight has not been entered (0kg)");

  return {
    ...counts,
    passengerCount: counts.adults + counts.children,
    passengerWeightKg,
    baggageCount: baggage.count,
    baggageWeightKg,
    cargoWeightKg: inputs.cargoWeightKg,
    fuelWeightKg: inputs.fuelWeightKg,
    payloadKg,
    zeroFuelWeightKg,
    takeoffWeightKg,
    withinLimits,
    warnings,
    limits,
  };
}

const limitsOf = (a: IAircraft): LoadLimits => ({
  operatingEmptyWeightKg: a.operatingEmptyWeightKg,
  maxZeroFuelWeightKg: a.maxZeroFuelWeightKg,
  maxTakeoffWeightKg: a.maxTakeoffWeightKg,
  maxPayloadKg: a.maxPayloadKg,
  maxCargoWeightKg: a.maxCargoWeightKg,
});

async function gatherCounts(flightId: ICheckIn["flightId"]): Promise<{ counts: PassengerCounts; baggage: { count: number; weightKg: number } }> {
  const checkIns = await CheckIn.find({ flightId, status: { $in: ["CHECKED_IN", "BOARDED"] } })
    .select("pnrId passengerId")
    .lean<Pick<ICheckIn, "pnrId" | "passengerId">[]>();
  const pnrs = await PNR.find({ _id: { $in: [...new Set(checkIns.map((c) => c.pnrId.toString()))] } })
    .select("passengers")
    .lean<Pick<IPNR, "_id" | "passengers">[]>();
  const types = new Map<string, PassengerType>();
  for (const p of pnrs) for (const pax of p.passengers) types.set(`${p._id}:${pax.id}`, pax.type);

  const counts: PassengerCounts = { adults: 0, children: 0, infants: 0 };
  for (const c of checkIns) {
    const t = types.get(`${c.pnrId}:${c.passengerId}`) ?? "ADULT";
    if (t === "INFANT") counts.infants++;
    else if (t === "CHILD") counts.children++;
    else counts.adults++;
  }

  const [agg] = await Baggage.aggregate<{ count: number; weightKg: number }>([
    { $match: { flightId, status: { $ne: "OFFLOADED" } } },
    { $group: { _id: null, count: { $sum: 1 }, weightKg: { $sum: "$weightKg" } } },
  ]);
  return { counts, baggage: { count: agg?.count ?? 0, weightKg: agg?.weightKg ?? 0 } };
}

async function computeForFlight(flightId: string, inputs?: LoadInputs) {
  const flight = await getFlightOrThrow(flightId);
  const aircraft = await getAircraftOrThrow(flight.aircraftId);
  const saved = await LoadSheet.findOne({ flightId: flight._id }).lean<ILoadSheet>();
  const effective = inputs ?? {
    cargoWeightKg: saved?.cargoWeightKg ?? 0,
    fuelWeightKg: saved?.fuelWeightKg ?? 0,
  };
  const { counts, baggage } = await gatherCounts(flight._id);
  return { flight, saved, computation: computeLoad(counts, baggage, effective, limitsOf(aircraft)) };
}

const sheetFields = (c: LoadComputation) => ({
  adults: c.adults,
  children: c.children,
  infants: c.infants,
  passengerCount: c.passengerCount,
  passengerWeightKg: c.passengerWeightKg,
  baggageCount: c.baggageCount,
  baggageWeightKg: c.baggageWeightKg,
  cargoWeightKg: c.cargoWeightKg,
  fuelWeightKg: c.fuelWeightKg,
  zeroFuelWeightKg: c.zeroFuelWeightKg,
  takeoffWeightKg: c.takeoffWeightKg,
  withinLimits: c.withinLimits,
  warnings: c.warnings,
});

export interface LoadView {
  flightId: string;
  /** Status of the saved load sheet, or null when none has been saved yet. */
  loadSheetStatus: ILoadSheet["status"] | null;
  /** Live computation (uses the saved cargo/fuel inputs, or 0 when nothing is saved). */
  load: LoadComputation;
  loadSheet: ILoadSheet | null;
  /** FINAL sheet whose totals no longer match the live data (late check-in / bag after finalize). */
  outOfDate: boolean;
}

export async function getLoad(flightId: string): Promise<LoadView> {
  const { flight, saved, computation } = await computeForFlight(flightId);
  const outOfDate =
    saved?.status === "FINAL" &&
    (saved.takeoffWeightKg !== computation.takeoffWeightKg || saved.zeroFuelWeightKg !== computation.zeroFuelWeightKg);
  return {
    flightId: flight._id.toString(),
    loadSheetStatus: saved?.status ?? null,
    load: computation,
    loadSheet: saved,
    outOfDate: Boolean(outOfDate),
  };
}

function assertEditable(status: string) {
  if (status !== "SCHEDULED" && status !== "BOARDING") {
    throw AppError.conflict(`Load sheet cannot be changed: flight is ${status}`);
  }
}

/** Save or update the DRAFT load sheet with the cargo and fuel inputs. 409 when already FINAL (reopen first). */
export async function saveLoadDraft(_user: AuthUser, flightId: string, inputs: LoadInputs): Promise<LoadView> {
  const { flight, saved, computation } = await computeForFlight(flightId, inputs);
  assertEditable(flight.status);
  if (saved?.status === "FINAL") throw AppError.conflict("Load sheet is FINAL; reopen it before editing");
  try {
    await LoadSheet.findOneAndUpdate(
      { flightId: flight._id, status: { $ne: "FINAL" } },
      { $set: { ...sheetFields(computation), status: "DRAFT", flightId: flight._id } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw AppError.conflict("Load sheet is FINAL; reopen it before editing");
    throw err;
  }
  return getLoad(flightId);
}

/** Finalize the DRAFT. 409 when limits are exceeded, when no draft exists, or when already FINAL. */
export async function finalizeLoad(user: AuthUser, flightId: string): Promise<LoadView> {
  const { flight, saved, computation } = await computeForFlight(flightId);
  assertEditable(flight.status);
  if (!saved) throw AppError.conflict("No load sheet draft exists; save cargo and fuel first");
  if (saved.status === "FINAL") throw AppError.conflict("Load sheet is already FINAL; reopen it first");
  if (!computation.withinLimits) {
    throw new AppError(409, "LOAD_LIMITS_EXCEEDED", "Aircraft limits exceeded; cannot finalize", {
      warnings: computation.warnings,
      load: computation,
    });
  }
  const res = await LoadSheet.findOneAndUpdate(
    { _id: saved._id, status: "DRAFT" },
    { $set: { ...sheetFields(computation), status: "FINAL", finalizedBy: toObjectId(user.id, "user id"), finalizedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!res) throw AppError.conflict("Load sheet changed concurrently");
  return getLoad(flightId);
}

/** Reopen a FINAL load sheet (back to DRAFT). Not possible once the flight is closed or departed. */
export async function reopenLoad(_user: AuthUser, flightId: string): Promise<LoadView> {
  const flight = await getFlightOrThrow(flightId);
  assertEditable(flight.status);
  const res = await LoadSheet.findOneAndUpdate(
    { flightId: flight._id, status: "FINAL" },
    { $set: { status: "DRAFT" }, $unset: { finalizedBy: "", finalizedAt: "" } },
    { returnDocument: "after" },
  );
  if (!res) throw AppError.conflict("Load sheet is not FINAL");
  return getLoad(flightId);
}
