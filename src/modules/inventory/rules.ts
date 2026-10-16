import { Flight, Inventory, type CabinCode } from "@/models";
import { DAY_MS, bucketArrayFilters, bucketPath, cabinLoadFactorPct, historyEntry, pushHistory, toObjectId, type ObjectIdLike } from "./helpers";

export interface RuleChange {
  cabin: CabinCode;
  class: string;
  action: "CLOSED" | "REOPENED";
  reason: string;
}

export interface RuleResult {
  flightId: string;
  changes: RuleChange[];
}

/**
 * Revenue management rules engine. Idempotent; safe to call after every sell/hold/release/cancel.
 *
 * - Load-factor rule: close `closeClasses` while the load factor (sold + held) / capacity of the cabin
 *   that contains those classes is >= `thresholdPct` percent.
 * - Time-to-departure rule: close `closeClasses` once departure is within `daysBeforeDeparture` days.
 *
 * Precedence: a bucket whose open/closed state was set manually (`source === "manual"`) is never
 * touched. Buckets closed by a rule (`source === "rule"`) are reopened when no rule wants them closed.
 * Every change is appended to `Inventory.history`.
 */
export async function applyRevenueRules(flightId: ObjectIdLike, now: Date = new Date()): Promise<RuleResult> {
  const id = toObjectId(flightId, "flightId");
  const result: RuleResult = { flightId: id.toString(), changes: [] };

  const inv = await Inventory.findOne({ flightId: id }).lean();
  if (!inv) return result;
  if (inv.loadFactorRules.length === 0 && inv.timeToDepartureRules.length === 0) {
    // No rules: still reopen anything a (since removed) rule closed.
    if (!inv.cabins.some((c) => c.buckets.some((b) => !b.open && b.source === "rule"))) return result;
  }
  const flight = await Flight.findById(id).select("departure").lean();
  const daysToDeparture = flight ? (flight.departure.getTime() - now.getTime()) / DAY_MS : Number.POSITIVE_INFINITY;

  // class -> reason it should be closed
  const shouldClose = new Map<string, string>();
  for (const rule of inv.loadFactorRules) {
    for (const cabin of inv.cabins) {
      const classes = rule.closeClasses.filter((cls) => cabin.buckets.some((b) => b.class === cls));
      if (classes.length === 0) continue;
      const lf = cabinLoadFactorPct(cabin);
      if (lf >= rule.thresholdPct) {
        for (const cls of classes) {
          if (!shouldClose.has(cls)) {
            shouldClose.set(cls, `Load factor ${lf.toFixed(1)}% >= ${rule.thresholdPct}%`);
          }
        }
      }
    }
  }
  for (const rule of inv.timeToDepartureRules) {
    if (daysToDeparture <= rule.daysBeforeDeparture) {
      for (const cls of rule.closeClasses) {
        if (!shouldClose.has(cls)) {
          shouldClose.set(cls, `Departure within ${rule.daysBeforeDeparture} day(s)`);
        }
      }
    }
  }

  for (const cabin of inv.cabins) {
    for (const bucket of cabin.buckets) {
      const reason = shouldClose.get(bucket.class);
      let change: RuleChange | null = null;
      let from: { open: boolean; source: unknown } | null = null;
      if (reason && bucket.open && bucket.source !== "manual") {
        change = { cabin: cabin.cabin, class: bucket.class, action: "CLOSED", reason };
        from = { open: true, source: { $ne: "manual" } };
      } else if (!reason && !bucket.open && bucket.source === "rule") {
        change = { cabin: cabin.cabin, class: bucket.class, action: "REOPENED", reason: "Rule conditions no longer apply" };
        from = { open: false, source: "rule" };
      }
      if (!change || !from) continue;

      // The doc-level $elemMatch guarantees the bucket is still in the state we read (so a concurrent manual
      // override wins), and keeps the history entry from being appended when nothing matched.
      const updated = await Inventory.updateOne(
        {
          _id: inv._id,
          cabins: { $elemMatch: { cabin: cabin.cabin, buckets: { $elemMatch: { class: bucket.class, ...from } } } },
        } as never,
        {
          $set: { [bucketPath("open")]: change.action === "REOPENED", [bucketPath("source")]: "rule" },
          $push: pushHistory(
            historyEntry("system", change.action === "CLOSED" ? "RULE_CLOSE" : "RULE_OPEN", {
              cabin: cabin.cabin,
              class: bucket.class,
              reason: change.reason,
            }),
          ),
        },
        { arrayFilters: bucketArrayFilters(cabin.cabin, bucket.class) },
      );
      if (updated.modifiedCount > 0) result.changes.push(change);
    }
  }
  return result;
}
