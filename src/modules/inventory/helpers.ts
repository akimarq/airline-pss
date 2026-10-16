import { Types } from "mongoose";
import { AppError } from "@/lib/errors";
import type { IBucket, IInventoryCabin, IInventoryHistory } from "@/models";

export const DAY_MS = 86_400_000;
export const MAX_HISTORY = 500;

export type ObjectIdLike = string | Types.ObjectId;

/** Convert a string id to an ObjectId, throwing a 400 (not a 500) for malformed ids. */
export function toObjectId(id: ObjectIdLike, label = "id"): Types.ObjectId {
  if (id instanceof Types.ObjectId) return id;
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw AppError.badRequest(`Invalid ${label}`);
  }
  return new Types.ObjectId(id);
}

/** Read a JSON body that may legitimately be empty (treated as `{}`). Malformed JSON throws SyntaxError (-> 400). */
export async function readJsonOrEmpty(req: Request): Promise<unknown> {
  const text = await req.text();
  return text.trim() ? JSON.parse(text) : {};
}

export function normalizeClass(cls: string): string {
  const c = cls?.trim().toUpperCase();
  if (!c || !/^[A-Z]$/.test(c)) throw AppError.badRequest("Booking class must be a single letter A-Z");
  return c;
}

/** Seats still sellable in a bucket (ignores whether it is open). */
export function bucketAvailable(b: Pick<IBucket, "authorized" | "sold" | "held">): number {
  return Math.max(0, b.authorized - b.sold - b.held);
}

/** Load factor of a cabin in percent: (sold + held) / capacity. */
export function cabinLoadFactorPct(cabin: Pick<IInventoryCabin, "capacity" | "buckets">): number {
  if (cabin.capacity <= 0) return 0;
  const used = cabin.buckets.reduce((sum, b) => sum + b.sold + b.held, 0);
  return (used / cabin.capacity) * 100;
}

export function historyEntry(actor: string, action: string, details?: unknown): IInventoryHistory {
  return { at: new Date(), actor, action, details };
}

/** `$push` fragment appending to `history`, keeping only the newest `MAX_HISTORY` entries. */
export function pushHistory(entry: IInventoryHistory) {
  return { history: { $each: [entry], $slice: -MAX_HISTORY } };
}

// ---------------------------------------------------------------------------
// Atomic-update building blocks.
//
// All seat-count changes are single-document `findOneAndUpdate` calls whose filter contains the
// capacity condition, so MongoDB evaluates "is there room?" and applies the `$inc` atomically
// (a conflicting concurrent write makes the server retry the match). `$elemMatch` cannot compare two
// fields of the same element, so the condition is built with `$expr` over the cabins/buckets arrays.
// ---------------------------------------------------------------------------

/** Expression (inside a `$map` over buckets with `as: "b"`) for the seats still free in a bucket. */
export const AVAILABLE_EXPR = { $subtract: ["$$b.authorized", { $add: ["$$b.sold", "$$b.held"] }] };

/**
 * `$expr` filter: true when the inventory has a bucket `cls` in `cabin` for which every given
 * condition (expressions over `$$b`) holds.
 */
export function bucketExpr(cabin: string, cls: string, ...conditions: unknown[]) {
  return {
    $expr: {
      $anyElementTrue: [
        {
          $map: {
            input: "$cabins",
            as: "c",
            in: {
              $and: [
                { $eq: ["$$c.cabin", { $literal: cabin }] },
                {
                  $anyElementTrue: [
                    {
                      $map: {
                        input: "$$c.buckets",
                        as: "b",
                        in: { $and: [{ $eq: ["$$b.class", { $literal: cls }] }, ...conditions] },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
  };
}

/** arrayFilters targeting one bucket via `cabins.$[c].buckets.$[b].<field>`. */
export function bucketArrayFilters(cabin: string, cls: string) {
  return [{ "c.cabin": cabin }, { "b.class": cls }];
}

export function bucketPath(field: keyof IBucket): string {
  return `cabins.$[c].buckets.$[b].${field}`;
}
