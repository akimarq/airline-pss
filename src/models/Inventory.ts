import { Schema, model, models, type Model, type Types } from "mongoose";
import { CABIN_CODES, type CabinCode } from "./Aircraft";

/** Who last changed a bucket's open/closed state: a staff override or the revenue rules engine. */
export const BUCKET_SOURCES = ["manual", "rule"] as const;
export type BucketSource = (typeof BUCKET_SOURCES)[number];

/** Seats available to sell in a bucket: `authorized - sold - held` (only sellable while `open`). */
export interface IBucket {
  class: string; // booking class letter (RBD)
  authorized: number;
  sold: number;
  held: number;
  open: boolean;
  /**
   * Source of the current open/closed state. The rules engine never touches a bucket whose source is
   * "manual" and only reopens buckets it closed itself ("rule"). Absent = never changed (rules may close it;
   * a closed bucket with no source is treated as manual, i.e. left alone).
   */
  source?: BucketSource;
}

export interface IInventoryCabin {
  cabin: CabinCode;
  capacity: number; // physical seats in this cabin
  buckets: IBucket[]; // ordered cheapest-last or by price; engine should not rely on order
}

/** Temporary seat hold created by a HELD PNR; released on expiry/cancel, converted to sold on confirm. */
export interface IHold {
  pnrLocator: string;
  cabin: CabinCode;
  bucketClass: string;
  seats: number;
  expiresAt: Date;
}

/** Close `closeClasses` when load factor (sold+held / capacity, in %) is above `thresholdPct`. */
export interface ILoadFactorRule {
  thresholdPct: number;
  closeClasses: string[];
}

/** Close `closeClasses` when departure is within `daysBeforeDeparture` days. */
export interface ITimeToDepartureRule {
  daysBeforeDeparture: number;
  closeClasses: string[];
}

export interface IInventoryHistory {
  at: Date;
  actor?: string; // user id or "system"
  action: string; // e.g. "HOLD", "SELL", "RELEASE", "BUCKET_OVERRIDE", "RULE_CLOSE"
  details?: unknown;
}

export interface IInventory {
  _id: Types.ObjectId;
  flightId: Types.ObjectId;
  cabins: IInventoryCabin[];
  holds: IHold[];
  loadFactorRules: ILoadFactorRule[];
  timeToDepartureRules: ITimeToDepartureRule[];
  history: IInventoryHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const bucketSchema = new Schema<IBucket>(
  {
    class: { type: String, required: true, uppercase: true, trim: true },
    authorized: { type: Number, required: true, min: 0, default: 0 },
    sold: { type: Number, required: true, min: 0, default: 0 },
    held: { type: Number, required: true, min: 0, default: 0 },
    open: { type: Boolean, required: true, default: true },
    source: { type: String, enum: BUCKET_SOURCES },
  },
  { _id: false },
);

const cabinSchema = new Schema<IInventoryCabin>(
  {
    cabin: { type: String, enum: CABIN_CODES, required: true },
    capacity: { type: Number, required: true, min: 0 },
    buckets: { type: [bucketSchema], default: [] },
  },
  { _id: false },
);

const holdSchema = new Schema<IHold>(
  {
    pnrLocator: { type: String, required: true },
    cabin: { type: String, enum: CABIN_CODES, required: true },
    bucketClass: { type: String, required: true },
    seats: { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const loadFactorRuleSchema = new Schema<ILoadFactorRule>(
  {
    thresholdPct: { type: Number, required: true, min: 0, max: 100 },
    closeClasses: { type: [String], required: true },
  },
  { _id: false },
);

const timeToDepartureRuleSchema = new Schema<ITimeToDepartureRule>(
  {
    daysBeforeDeparture: { type: Number, required: true, min: 0 },
    closeClasses: { type: [String], required: true },
  },
  { _id: false },
);

const historySchema = new Schema<IInventoryHistory>(
  {
    at: { type: Date, required: true, default: Date.now },
    actor: String,
    action: { type: String, required: true },
    details: Schema.Types.Mixed,
  },
  { _id: false },
);

const inventorySchema = new Schema<IInventory>(
  {
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true, unique: true },
    cabins: { type: [cabinSchema], default: [] },
    holds: { type: [holdSchema], default: [] },
    loadFactorRules: { type: [loadFactorRuleSchema], default: [] },
    timeToDepartureRules: { type: [timeToDepartureRuleSchema], default: [] },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

inventorySchema.index({ "holds.expiresAt": 1 }); // expired-hold sweeps

export const Inventory = (models.Inventory as Model<IInventory>) || model<IInventory>("Inventory", inventorySchema);
