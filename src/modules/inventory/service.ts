import { AppError } from "@/lib/errors";
import {
  Aircraft,
  Flight,
  Inventory,
  PNR,
  type BucketSource,
  type CabinCode,
  type IBucket,
  type IHold,
  type IInventory,
  type IInventoryCabin,
  type ILoadFactorRule,
  type ITimeToDepartureRule,
} from "@/models";
import {
  AVAILABLE_EXPR,
  bucketArrayFilters,
  bucketAvailable,
  bucketExpr,
  bucketPath,
  cabinLoadFactorPct,
  historyEntry,
  normalizeClass,
  pushHistory,
  toObjectId,
  type ObjectIdLike,
} from "./helpers";
import { applyRevenueRules } from "./rules";
import type { InventoryConfig, PatchBucketInput, RulesInput } from "./schemas";

export { applyRevenueRules } from "./rules";
export type { RuleChange, RuleResult } from "./rules";
export { toObjectId } from "./helpers";

/** Default seat hold lifetime. */
export const HOLD_TTL_MINUTES = 15;

/** Passengers never see more than this many seats of availability (standard "9" display cap). */
export const MAX_DISPLAY_AVAILABILITY = 9;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface BucketView {
  class: string;
  authorized: number;
  sold: number;
  held: number;
  available: number; // max(0, authorized - sold - held); regardless of `open`
  open: boolean;
  source: BucketSource | null; // who last set open/closed
}

export interface CabinView {
  cabin: CabinCode;
  capacity: number;
  sold: number;
  held: number;
  loadFactorPct: number;
  buckets: BucketView[];
}

export interface InventoryView {
  flightId: string;
  capacity: number;
  sold: number;
  held: number;
  loadFactorPct: number;
  cabins: CabinView[];
  holds: { pnrLocator: string; cabin: CabinCode; bucketClass: string; seats: number; expiresAt: Date }[];
  loadFactorRules: ILoadFactorRule[];
  timeToDepartureRules: ITimeToDepartureRule[];
  history?: IInventory["history"];
}

/** What passengers (and public search) may see: only open, sellable buckets, no rules/holds/counters. */
export interface PublicAvailability {
  flightId: string;
  cabins: { cabin: CabinCode; buckets: { class: string; available: number }[] }[];
}

function bucketView(b: IBucket): BucketView {
  return {
    class: b.class,
    authorized: b.authorized,
    sold: b.sold,
    held: b.held,
    available: bucketAvailable(b),
    open: b.open,
    source: b.source ?? null,
  };
}

function cabinView(c: IInventoryCabin): CabinView {
  return {
    cabin: c.cabin,
    capacity: c.capacity,
    sold: c.buckets.reduce((s, b) => s + b.sold, 0),
    held: c.buckets.reduce((s, b) => s + b.held, 0),
    loadFactorPct: round1(cabinLoadFactorPct(c)),
    buckets: c.buckets.map(bucketView),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function toInventoryView(inv: IInventory, opts: { includeHistory?: boolean } = {}): InventoryView {
  const cabins = inv.cabins.map(cabinView);
  const capacity = cabins.reduce((s, c) => s + c.capacity, 0);
  const sold = cabins.reduce((s, c) => s + c.sold, 0);
  const held = cabins.reduce((s, c) => s + c.held, 0);
  return {
    flightId: inv.flightId.toString(),
    capacity,
    sold,
    held,
    loadFactorPct: capacity > 0 ? round1(((sold + held) / capacity) * 100) : 0,
    cabins,
    holds: inv.holds.map((h: IHold) => ({
      pnrLocator: h.pnrLocator,
      cabin: h.cabin,
      bucketClass: h.bucketClass,
      seats: h.seats,
      expiresAt: h.expiresAt,
    })),
    loadFactorRules: inv.loadFactorRules,
    timeToDepartureRules: inv.timeToDepartureRules,
    ...(opts.includeHistory ? { history: inv.history.slice(-100) } : {}),
  };
}

export function toPublicAvailability(view: InventoryView): PublicAvailability {
  return {
    flightId: view.flightId,
    cabins: view.cabins.map((c) => ({
      cabin: c.cabin,
      buckets: c.buckets
        .filter((b) => b.open && b.available > 0)
        .map((b) => ({ class: b.class, available: Math.min(b.available, MAX_DISPLAY_AVAILABILITY) })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Default buckets per cabin (highest fare first) with authorization as a share of cabin capacity. */
export const DEFAULT_BUCKETS: Record<CabinCode, { class: string; share: number }[]> = {
  Y: [
    { class: "Y", share: 1 },
    { class: "B", share: 0.9 },
    { class: "M", share: 0.75 },
    { class: "K", share: 0.55 },
    { class: "Q", share: 0.35 },
  ],
  J: [
    { class: "J", share: 1 },
    { class: "C", share: 0.8 },
    { class: "D", share: 0.5 },
  ],
  F: [
    { class: "F", share: 1 },
    { class: "A", share: 0.7 },
  ],
};

/**
 * Create the inventory record for a flight. With no config, cabins/capacities come from the aircraft layout
 * (or a single Y cabin sized to the aircraft capacity) and each cabin gets its default buckets.
 */
export async function createInventoryForFlight(
  flightId: ObjectIdLike,
  config: InventoryConfig = {},
  actor = "system",
): Promise<InventoryView> {
  const id = toObjectId(flightId, "flightId");
  const flight = await Flight.findById(id).lean();
  if (!flight) throw AppError.notFound("Flight not found");
  if (await Inventory.exists({ flightId: id })) throw AppError.conflict("Inventory already exists for this flight");

  const aircraft = await Aircraft.findById(flight.aircraftId).lean();
  const layoutCapacity = new Map<CabinCode, number>();
  for (const c of aircraft?.cabins ?? []) {
    layoutCapacity.set(c.cabin, (layoutCapacity.get(c.cabin) ?? 0) + (c.lastRow - c.firstRow + 1) * c.seatLetters.length);
  }
  if (layoutCapacity.size === 0 && aircraft) layoutCapacity.set("Y", aircraft.capacity);

  const cabinConfigs =
    config.cabins ?? [...layoutCapacity.entries()].map(([cabin, capacity]) => ({ cabin, capacity, buckets: undefined }));
  if (cabinConfigs.length === 0) throw AppError.badRequest("No cabin configuration given and the aircraft has no cabin layout");

  const seenCabins = new Set<string>();
  const seenClasses = new Set<string>();
  const cabins: IInventoryCabin[] = cabinConfigs.map((cc) => {
    if (seenCabins.has(cc.cabin)) throw AppError.badRequest(`Duplicate cabin ${cc.cabin}`);
    seenCabins.add(cc.cabin);
    const capacity = cc.capacity ?? layoutCapacity.get(cc.cabin);
    if (!capacity) throw AppError.badRequest(`Capacity for cabin ${cc.cabin} is required (the aircraft has no such cabin)`);
    const buckets: IBucket[] = (cc.buckets ?? DEFAULT_BUCKETS[cc.cabin].map((d) => ({ class: d.class, authorized: Math.ceil(d.share * capacity) }))).map(
      (b) => {
        const cls = normalizeClass(b.class);
        if (seenClasses.has(cls)) throw AppError.badRequest(`Booking class ${cls} is used more than once`);
        seenClasses.add(cls);
        const authorized = b.authorized ?? capacity;
        if (authorized > capacity) {
          throw AppError.badRequest(`Bucket ${cls} authorization ${authorized} exceeds cabin ${cc.cabin} capacity ${capacity}`);
        }
        return { class: cls, authorized, sold: 0, held: 0, open: true };
      },
    );
    return { cabin: cc.cabin, capacity, buckets };
  });

  for (const rule of [...(config.loadFactorRules ?? []), ...(config.timeToDepartureRules ?? [])]) {
    for (const cls of rule.closeClasses) {
      if (!seenClasses.has(cls)) throw AppError.badRequest(`Rule references unknown booking class ${cls}`);
    }
  }

  const created = await Inventory.create({
    flightId: id,
    cabins,
    holds: [],
    loadFactorRules: config.loadFactorRules ?? [],
    timeToDepartureRules: config.timeToDepartureRules ?? [],
    history: [historyEntry(actor, "CREATED", { cabins: cabins.map((c) => ({ cabin: c.cabin, capacity: c.capacity })) })],
  });
  await applyRevenueRules(id);
  const fresh = await Inventory.findById(created._id).lean();
  return toInventoryView(fresh!);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadInventory(flightId: ObjectIdLike) {
  const inv = await Inventory.findOne({ flightId: toObjectId(flightId, "flightId") }).lean();
  if (!inv) throw AppError.notFound("No inventory exists for this flight");
  return inv;
}

/** Real-time availability. Lazily expires stale holds and applies the revenue rules first. */
export async function getAvailability(flightId: ObjectIdLike, opts: { includeHistory?: boolean } = {}): Promise<InventoryView> {
  const id = toObjectId(flightId, "flightId");
  const now = new Date();
  await expireHolds(now, { flightId: id });
  await applyRevenueRules(id, now);
  return toInventoryView(await loadInventory(id), opts);
}

function findBucket(inv: Pick<IInventory, "cabins">, cls: string, cabin?: CabinCode) {
  for (const c of inv.cabins) {
    if (cabin && c.cabin !== cabin) continue;
    const bucket = c.buckets.find((b) => b.class === cls);
    if (bucket) return { cabin: c, bucket };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hold / confirm / release
// ---------------------------------------------------------------------------

export interface HoldResult {
  flightId: string;
  pnrLocator: string;
  cabin: CabinCode;
  bucketClass: string;
  seats: number;
  expiresAt: Date;
}

/** Re-run the rules engine after a mutation; a rules failure must never undo a completed seat change. */
async function repriceQuietly(flightId: ObjectIdLike, now?: Date) {
  try {
    await applyRevenueRules(flightId, now);
  } catch (err) {
    console.error("applyRevenueRules failed:", err);
  }
}

function assertSeats(seats: number) {
  if (!Number.isInteger(seats) || seats < 1) throw AppError.badRequest("seats must be a positive integer");
}

/**
 * Atomically hold `seats` in a bucket for a PNR. The capacity check (`authorized - sold - held >= seats` and
 * bucket open) is part of the update filter, so concurrent callers can never oversell.
 * Throws 409 when the bucket is closed or lacks seats.
 */
export async function holdSeats(
  flightId: ObjectIdLike,
  cabin: CabinCode,
  bucketClass: string,
  seats: number,
  pnrLocator: string,
  ttlMinutes: number = HOLD_TTL_MINUTES,
): Promise<HoldResult> {
  assertSeats(seats);
  const id = toObjectId(flightId, "flightId");
  const cls = normalizeClass(bucketClass);
  const locator = pnrLocator.trim().toUpperCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  await expireHolds(now, { flightId: id });
  await applyRevenueRules(id, now); // so time-to-departure rules are enforced at sale time

  const updated = await Inventory.findOneAndUpdate(
    {
      flightId: id,
      holds: { $not: { $elemMatch: { pnrLocator: locator, cabin, bucketClass: cls } } },
      ...bucketExpr(cabin, cls, "$$b.open", { $gte: [AVAILABLE_EXPR, seats] }),
    } as never,
    {
      $inc: { [bucketPath("held")]: seats },
      $push: {
        holds: { pnrLocator: locator, cabin, bucketClass: cls, seats, expiresAt },
        ...pushHistory(historyEntry(`pnr:${locator}`, "HOLD", { cabin, class: cls, seats, expiresAt })),
      },
    },
    { arrayFilters: bucketArrayFilters(cabin, cls), returnDocument: "after" },
  );

  if (!updated) {
    // Diagnose why the guarded update did not match.
    const inv = await loadInventory(id);
    const found = findBucket(inv, cls, cabin);
    if (!found) throw AppError.badRequest(`Class ${cls} does not exist in cabin ${cabin} on this flight`);
    if (inv.holds.some((h) => h.pnrLocator === locator && h.cabin === cabin && h.bucketClass === cls)) {
      throw AppError.conflict(`PNR ${locator} already holds seats in class ${cls}`);
    }
    if (!found.bucket.open) throw AppError.conflict(`Class ${cls} is closed for sale`, { class: cls, reason: "CLOSED" });
    throw AppError.conflict(`Only ${bucketAvailable(found.bucket)} seat(s) left in class ${cls}`, {
      class: cls,
      reason: "INSUFFICIENT_SEATS",
      available: bucketAvailable(found.bucket),
    });
  }

  await repriceQuietly(id, now);
  return { flightId: id.toString(), pnrLocator: locator, cabin, bucketClass: cls, seats, expiresAt };
}

export interface ConfirmedHold {
  flightId: string;
  cabin: CabinCode;
  bucketClass: string;
  seats: number;
}

/**
 * Convert every unexpired hold of a PNR into sold seats (held -> sold), atomically per hold.
 * Returns the holds that were confirmed (empty when there are none, which makes retries idempotent).
 */
export async function confirmHold(pnrLocator: string, now: Date = new Date()): Promise<ConfirmedHold[]> {
  const locator = pnrLocator.trim().toUpperCase();
  const invs = await Inventory.find({ holds: { $elemMatch: { pnrLocator: locator } } })
    .select("flightId holds")
    .lean();
  const confirmed: ConfirmedHold[] = [];
  for (const inv of invs) {
    for (const hold of inv.holds.filter((h) => h.pnrLocator === locator)) {
      const updated = await Inventory.findOneAndUpdate(
        {
          _id: inv._id,
          holds: {
            $elemMatch: {
              pnrLocator: locator,
              cabin: hold.cabin,
              bucketClass: hold.bucketClass,
              seats: hold.seats,
              expiresAt: { $gt: now },
            },
          },
        },
        {
          $pull: { holds: { pnrLocator: locator, cabin: hold.cabin, bucketClass: hold.bucketClass } },
          $inc: { [bucketPath("held")]: -hold.seats, [bucketPath("sold")]: hold.seats },
          $push: pushHistory(historyEntry(`pnr:${locator}`, "SELL", { cabin: hold.cabin, class: hold.bucketClass, seats: hold.seats })),
        },
        { arrayFilters: bucketArrayFilters(hold.cabin, hold.bucketClass), returnDocument: "after" },
      );
      if (updated) {
        confirmed.push({ flightId: inv.flightId.toString(), cabin: hold.cabin, bucketClass: hold.bucketClass, seats: hold.seats });
        await repriceQuietly(inv.flightId, now);
      }
    }
  }
  return confirmed;
}

/**
 * Release every hold of a PNR (optionally only on one flight) back to the bucket(s).
 * Returns the number of seats released. No-op (0) when there is nothing held.
 */
export async function releaseHold(
  pnrLocator: string,
  scope: { flightId?: ObjectIdLike; cabin?: CabinCode; bucketClass?: string } = {},
): Promise<number> {
  const locator = pnrLocator.trim().toUpperCase();
  const scopeClass = scope.bucketClass ? normalizeClass(scope.bucketClass) : undefined;
  const inScope = (h: IHold) =>
    h.pnrLocator === locator && (!scope.cabin || h.cabin === scope.cabin) && (!scopeClass || h.bucketClass === scopeClass);
  const invs = await Inventory.find({
    holds: { $elemMatch: { pnrLocator: locator } },
    ...(scope.flightId ? { flightId: toObjectId(scope.flightId, "flightId") } : {}),
  })
    .select("flightId holds")
    .lean();
  let released = 0;
  for (const inv of invs) {
    for (const hold of inv.holds.filter(inScope)) {
      const updated = await Inventory.findOneAndUpdate(
        {
          _id: inv._id,
          holds: { $elemMatch: { pnrLocator: locator, cabin: hold.cabin, bucketClass: hold.bucketClass, seats: hold.seats } },
        },
        {
          $pull: { holds: { pnrLocator: locator, cabin: hold.cabin, bucketClass: hold.bucketClass } },
          $inc: { [bucketPath("held")]: -hold.seats },
          $push: pushHistory(historyEntry(`pnr:${locator}`, "RELEASE_HOLD", { cabin: hold.cabin, class: hold.bucketClass, seats: hold.seats })),
        },
        { arrayFilters: bucketArrayFilters(hold.cabin, hold.bucketClass), returnDocument: "after" },
      );
      if (updated) {
        released += hold.seats;
        await repriceQuietly(inv.flightId);
      }
    }
  }
  return released;
}

/**
 * Return sold seats to a bucket (cancellation, ticket void, no-show). Atomic and guarded so `sold` can never
 * go negative. `actor` is a user id or "system" and is recorded in the inventory history.
 */
export async function releaseSoldSeats(
  flightId: ObjectIdLike,
  cabin: CabinCode,
  bucketClass: string,
  seats: number,
  actor: string,
): Promise<void> {
  assertSeats(seats);
  const id = toObjectId(flightId, "flightId");
  const cls = normalizeClass(bucketClass);
  const updated = await Inventory.findOneAndUpdate(
    {
      flightId: id,
      cabins: { $elemMatch: { cabin, buckets: { $elemMatch: { class: cls, sold: { $gte: seats } } } } },
    },
    {
      $inc: { [bucketPath("sold")]: -seats },
      $push: pushHistory(historyEntry(actor, "RELEASE_SOLD", { cabin, class: cls, seats })),
    },
    { arrayFilters: bucketArrayFilters(cabin, cls), returnDocument: "after" },
  );
  if (!updated) {
    const inv = await loadInventory(id);
    const found = findBucket(inv, cls, cabin);
    if (!found) throw AppError.badRequest(`Class ${cls} does not exist in cabin ${cabin} on this flight`);
    throw AppError.conflict(`Cannot release ${seats} seat(s): only ${found.bucket.sold} sold in class ${cls}`);
  }
  await repriceQuietly(id);
}

export interface ExpireResult {
  expiredHolds: number;
  seatsReleased: number;
  locators: string[];
}

/**
 * Sweep holds whose `expiresAt <= now`: give the seats back to their buckets and mark the owning HELD PNRs
 * EXPIRED. Restrict to one flight with `opts.flightId`. Safe to run concurrently (each hold is removed by an
 * atomic update that only one sweeper can win).
 */
export async function expireHolds(now: Date = new Date(), opts: { flightId?: ObjectIdLike } = {}): Promise<ExpireResult> {
  const result: ExpireResult = { expiredHolds: 0, seatsReleased: 0, locators: [] };
  const invs = await Inventory.find({
    holds: { $elemMatch: { expiresAt: { $lte: now } } },
    ...(opts.flightId ? { flightId: toObjectId(opts.flightId, "flightId") } : {}),
  })
    .select("flightId holds")
    .lean();

  for (const inv of invs) {
    let changed = false;
    for (const hold of inv.holds.filter((h) => h.expiresAt <= now)) {
      const updated = await Inventory.findOneAndUpdate(
        {
          _id: inv._id,
          holds: {
            $elemMatch: {
              pnrLocator: hold.pnrLocator,
              cabin: hold.cabin,
              bucketClass: hold.bucketClass,
              seats: hold.seats,
              expiresAt: { $lte: now },
            },
          },
        },
        {
          $pull: { holds: { pnrLocator: hold.pnrLocator, cabin: hold.cabin, bucketClass: hold.bucketClass } },
          $inc: { [bucketPath("held")]: -hold.seats },
          $push: pushHistory(historyEntry("system", "HOLD_EXPIRED", { pnr: hold.pnrLocator, cabin: hold.cabin, class: hold.bucketClass, seats: hold.seats })),
        },
        { arrayFilters: bucketArrayFilters(hold.cabin, hold.bucketClass), returnDocument: "after" },
      );
      if (updated) {
        changed = true;
        result.expiredHolds += 1;
        result.seatsReleased += hold.seats;
        if (!result.locators.includes(hold.pnrLocator)) result.locators.push(hold.pnrLocator);
      }
    }
    if (changed) await repriceQuietly(inv.flightId, now);
  }

  if (result.locators.length > 0) {
    await PNR.updateMany(
      { recordLocator: { $in: result.locators }, status: "HELD" },
      {
        $set: { status: "EXPIRED" },
        $unset: { holdExpiresAt: "" },
        $push: { history: { at: now, actor: "system", action: "EXPIRED", details: { reason: "Seat hold expired" } } },
      },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Staff overrides
// ---------------------------------------------------------------------------

/**
 * Staff override of a bucket. `open` closes/opens it and marks it as manually controlled (rules will not touch
 * it). `releaseToRules` clears that override so the engine controls the bucket again. `authorized` cannot be set
 * below `sold + held` (checked atomically) or above the cabin capacity.
 */
export async function setBucket(
  flightId: ObjectIdLike,
  bucketClass: string,
  patch: PatchBucketInput | { open?: boolean; authorized?: number; releaseToRules?: boolean },
  actor = "system",
): Promise<BucketView> {
  const id = toObjectId(flightId, "flightId");
  const cls = normalizeClass(bucketClass);
  if (patch.open !== undefined && patch.releaseToRules) {
    throw AppError.badRequest("open and releaseToRules cannot be combined");
  }
  if (patch.authorized !== undefined && (!Number.isInteger(patch.authorized) || patch.authorized < 0)) {
    throw AppError.badRequest("authorized must be a non-negative integer");
  }
  if (patch.open === undefined && patch.authorized === undefined && !patch.releaseToRules) {
    throw AppError.badRequest("Nothing to change");
  }

  const inv = await loadInventory(id);
  const found = findBucket(inv, cls);
  if (!found) throw AppError.notFound(`Class ${cls} does not exist on this flight`);
  const { cabin } = found.cabin;
  if (patch.authorized !== undefined && patch.authorized > found.cabin.capacity) {
    throw AppError.badRequest(`Authorization ${patch.authorized} exceeds cabin ${cabin} capacity ${found.cabin.capacity}`);
  }

  const $set: Record<string, unknown> = {};
  if (patch.open !== undefined) {
    $set[bucketPath("open")] = patch.open;
    $set[bucketPath("source")] = "manual";
  }
  if (patch.releaseToRules) $set[bucketPath("source")] = "rule";
  if (patch.authorized !== undefined) $set[bucketPath("authorized")] = patch.authorized;

  const conditions: unknown[] = [];
  if (patch.authorized !== undefined) {
    conditions.push({ $gte: [patch.authorized, { $add: ["$$b.sold", "$$b.held"] }] });
  }

  const updated = await Inventory.findOneAndUpdate(
    { _id: inv._id, ...bucketExpr(cabin, cls, ...conditions) } as never,
    {
      $set,
      $push: pushHistory(
        historyEntry(actor, "BUCKET_OVERRIDE", {
          cabin,
          class: cls,
          ...(patch.open !== undefined ? { open: patch.open } : {}),
          ...(patch.authorized !== undefined ? { authorized: patch.authorized, previousAuthorized: found.bucket.authorized } : {}),
          ...(patch.releaseToRules ? { releasedToRules: true } : {}),
        }),
      ),
    },
    { arrayFilters: bucketArrayFilters(cabin, cls), returnDocument: "after" },
  );
  if (!updated) {
    const current = findBucket(await loadInventory(id), cls)!.bucket;
    throw AppError.conflict(
      `Authorization cannot be lower than seats already sold or held (${current.sold + current.held})`,
      { sold: current.sold, held: current.held },
    );
  }
  await applyRevenueRules(id);
  const final = await loadInventory(id);
  return bucketView(findBucket(final, cls)!.bucket);
}

/** Replace the load-factor and time-to-departure rules of a flight, then re-run the engine. */
export async function setRules(flightId: ObjectIdLike, rules: RulesInput, actor = "system"): Promise<InventoryView> {
  const id = toObjectId(flightId, "flightId");
  const inv = await loadInventory(id);
  const known = new Set(inv.cabins.flatMap((c) => c.buckets.map((b) => b.class)));
  for (const rule of [...rules.loadFactorRules, ...rules.timeToDepartureRules]) {
    for (const cls of rule.closeClasses) {
      if (!known.has(cls)) throw AppError.badRequest(`Rule references unknown booking class ${cls}`);
    }
  }
  await Inventory.updateOne(
    { _id: inv._id },
    {
      $set: { loadFactorRules: rules.loadFactorRules, timeToDepartureRules: rules.timeToDepartureRules },
      $push: pushHistory(historyEntry(actor, "RULES_UPDATED", rules)),
    },
  );
  await applyRevenueRules(id);
  return toInventoryView(await loadInventory(id), { includeHistory: false });
}

/** Staff-triggered re-evaluation of the rules; returns what changed plus the new view. */
export async function reprice(flightId: ObjectIdLike, now: Date = new Date()) {
  const id = toObjectId(flightId, "flightId");
  await loadInventory(id); // 404 if missing
  await expireHolds(now, { flightId: id });
  const result = await applyRevenueRules(id, now);
  return { changes: result.changes, availability: toInventoryView(await loadInventory(id)) };
}
