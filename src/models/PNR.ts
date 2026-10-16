import { randomUUID } from "node:crypto";
import { Schema, model, models, type Model, type Types } from "mongoose";
import { CABIN_CODES, type CabinCode } from "./Aircraft";

export const PNR_STATUSES = ["HELD", "CONFIRMED", "TICKETED", "CANCELLED", "EXPIRED"] as const;
export type PnrStatus = (typeof PNR_STATUSES)[number];

export const PASSENGER_TYPES = ["ADULT", "CHILD", "INFANT"] as const;
export type PassengerType = (typeof PASSENGER_TYPES)[number];

export interface IPnrPassenger {
  id: string; // stable id within the PNR (uuid); tickets/check-ins refer to this
  firstName: string;
  lastName: string;
  type: PassengerType;
  dateOfBirth?: Date;
}

export interface IPnrSegment {
  flightId: Types.ObjectId;
  bookingClass: string;
  cabin: CabinCode;
  fareId: Types.ObjectId;
  fareAmount: number; // per passenger
}

export interface IPnrContact {
  email: string;
  phone?: string;
}

export interface IPnrHistory {
  at: Date;
  actor?: string; // user id or "system"
  action: string; // e.g. "CREATED", "TICKETED", "CANCELLED", "EXPIRED"
  details?: unknown;
}

export interface IPNR {
  _id: Types.ObjectId;
  recordLocator: string; // 6 chars, unique
  ownerUserId: Types.ObjectId;
  passengers: IPnrPassenger[];
  segments: IPnrSegment[];
  contact: IPnrContact;
  status: PnrStatus;
  holdExpiresAt?: Date; // set while HELD
  totalAmount: number;
  currency: string;
  history: IPnrHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const passengerSchema = new Schema<IPnrPassenger>(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    type: { type: String, enum: PASSENGER_TYPES, required: true, default: "ADULT" },
    dateOfBirth: Date,
  },
  { _id: false },
);

const segmentSchema = new Schema<IPnrSegment>(
  {
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true },
    bookingClass: { type: String, required: true, uppercase: true },
    cabin: { type: String, enum: CABIN_CODES, required: true },
    fareId: { type: Schema.Types.ObjectId, ref: "Fare", required: true },
    fareAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const historySchema = new Schema<IPnrHistory>(
  {
    at: { type: Date, required: true, default: Date.now },
    actor: String,
    action: { type: String, required: true },
    details: Schema.Types.Mixed,
  },
  { _id: false },
);

const pnrSchema = new Schema<IPNR>(
  {
    recordLocator: { type: String, required: true, unique: true, uppercase: true, minlength: 6, maxlength: 6 },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    passengers: {
      type: [passengerSchema],
      validate: [(v: unknown[]) => v.length > 0, "A PNR needs at least one passenger"],
    },
    segments: {
      type: [segmentSchema],
      validate: [(v: unknown[]) => v.length > 0, "A PNR needs at least one segment"],
    },
    contact: {
      email: { type: String, required: true, lowercase: true, trim: true },
      phone: { type: String, trim: true },
    },
    status: { type: String, enum: PNR_STATUSES, required: true, default: "HELD" },
    holdExpiresAt: Date,
    totalAmount: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, required: true, default: "USD", uppercase: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

pnrSchema.index({ "segments.flightId": 1, status: 1 });
pnrSchema.index({ status: 1, holdExpiresAt: 1 }); // expiring held PNRs

export const PNR = (models.PNR as Model<IPNR>) || model<IPNR>("PNR", pnrSchema);
