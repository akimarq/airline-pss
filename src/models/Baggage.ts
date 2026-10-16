import { Schema, model, models, type Model, type Types } from "mongoose";

export const BAGGAGE_STATUSES = ["CHECKED", "SCREENED", "LOADED", "OFFLOADED"] as const;
export type BaggageStatus = (typeof BAGGAGE_STATUSES)[number];

export interface IBaggageHistory {
  at: Date;
  status: BaggageStatus;
  actor?: string;
}

export interface IBaggage {
  _id: Types.ObjectId;
  tagNumber: string; // unique bag tag
  pnrId: Types.ObjectId;
  pnrLocator: string;
  passengerId: string; // IPnrPassenger.id
  flightId: Types.ObjectId;
  weightKg: number;
  // Added by DCS: set when the passenger's total checked weight exceeded the fare allowance.
  excess?: boolean;
  allowanceKg?: number; // allowance that applied when the bag was accepted
  excessKg?: number; // kg over the allowance contributed by this bag
  status: BaggageStatus;
  history: IBaggageHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<IBaggageHistory>(
  {
    at: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: BAGGAGE_STATUSES, required: true },
    actor: String,
  },
  { _id: false },
);

const baggageSchema = new Schema<IBaggage>(
  {
    tagNumber: { type: String, required: true, unique: true, trim: true },
    pnrId: { type: Schema.Types.ObjectId, ref: "PNR", required: true },
    pnrLocator: { type: String, required: true, uppercase: true, index: true },
    passengerId: { type: String, required: true },
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true, index: true },
    weightKg: { type: Number, required: true, min: 0 },
    excess: { type: Boolean, default: false },
    allowanceKg: { type: Number, min: 0 },
    excessKg: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: BAGGAGE_STATUSES, required: true, default: "CHECKED" },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

export const Baggage = (models.Baggage as Model<IBaggage>) || model<IBaggage>("Baggage", baggageSchema);
