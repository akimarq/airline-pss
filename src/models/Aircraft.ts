import { Schema, model, models, type Model, type Types } from "mongoose";

export const CABIN_CODES = ["F", "J", "Y"] as const; // First, Business, Economy
export type CabinCode = (typeof CABIN_CODES)[number];

export interface ICabinLayout {
  cabin: CabinCode;
  firstRow: number;
  lastRow: number;
  seatLetters: string[]; // e.g. ["A","B","C","D","E","F"]
}

export interface IAircraft {
  _id: Types.ObjectId;
  type: string; // e.g. "A320"
  registration: string; // tail number, unique
  cabins: ICabinLayout[];
  capacity: number; // total seats
  // Simplified weight & balance limits (kg)
  operatingEmptyWeightKg: number;
  maxZeroFuelWeightKg: number;
  maxTakeoffWeightKg: number;
  maxPayloadKg: number;
  maxCargoWeightKg: number;
  createdAt: Date;
  updatedAt: Date;
}

const cabinLayoutSchema = new Schema<ICabinLayout>(
  {
    cabin: { type: String, enum: CABIN_CODES, required: true },
    firstRow: { type: Number, required: true, min: 1 },
    lastRow: { type: Number, required: true, min: 1 },
    seatLetters: { type: [String], required: true },
  },
  { _id: false },
);

const aircraftSchema = new Schema<IAircraft>(
  {
    type: { type: String, required: true, trim: true },
    registration: { type: String, required: true, unique: true, uppercase: true, trim: true },
    cabins: { type: [cabinLayoutSchema], default: [] },
    capacity: { type: Number, required: true, min: 1 },
    operatingEmptyWeightKg: { type: Number, required: true, min: 0 },
    maxZeroFuelWeightKg: { type: Number, required: true, min: 0 },
    maxTakeoffWeightKg: { type: Number, required: true, min: 0 },
    maxPayloadKg: { type: Number, required: true, min: 0 },
    maxCargoWeightKg: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

export const Aircraft = (models.Aircraft as Model<IAircraft>) || model<IAircraft>("Aircraft", aircraftSchema);
