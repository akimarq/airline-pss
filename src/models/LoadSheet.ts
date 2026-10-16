import { Schema, model, models, type Model, type Types } from "mongoose";

export const LOADSHEET_STATUSES = ["DRAFT", "FINAL"] as const;
export type LoadSheetStatus = (typeof LOADSHEET_STATUSES)[number];

export interface ILoadSheet {
  _id: Types.ObjectId;
  flightId: Types.ObjectId; // one load sheet per flight
  status: LoadSheetStatus;
  passengerCount: number; // excludes infants
  adults: number;
  children: number;
  infants: number;
  passengerWeightKg: number;
  baggageCount: number;
  baggageWeightKg: number;
  cargoWeightKg: number;
  fuelWeightKg: number;
  zeroFuelWeightKg: number;
  takeoffWeightKg: number;
  withinLimits: boolean; // result of the simplified weight & balance check
  warnings: string[];
  finalizedBy?: Types.ObjectId;
  finalizedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const num = { type: Number, required: true, min: 0, default: 0 };

const loadSheetSchema = new Schema<ILoadSheet>(
  {
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true, unique: true },
    status: { type: String, enum: LOADSHEET_STATUSES, required: true, default: "DRAFT" },
    passengerCount: num,
    adults: num,
    children: num,
    infants: num,
    passengerWeightKg: num,
    baggageCount: num,
    baggageWeightKg: num,
    cargoWeightKg: num,
    fuelWeightKg: num,
    zeroFuelWeightKg: num,
    takeoffWeightKg: num,
    withinLimits: { type: Boolean, required: true, default: true },
    warnings: { type: [String], default: [] },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User" },
    finalizedAt: Date,
  },
  { timestamps: true },
);

export const LoadSheet = (models.LoadSheet as Model<ILoadSheet>) || model<ILoadSheet>("LoadSheet", loadSheetSchema);
