import { Schema, model, models, type Model, type Types } from "mongoose";
import { CABIN_CODES, type CabinCode } from "./Aircraft";

export interface IBoardingPass {
  _id: Types.ObjectId;
  checkInId: Types.ObjectId; // one pass per check-in
  pnrLocator: string;
  passengerName: string; // "LAST/FIRST"
  flightId: Types.ObjectId;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: Date;
  cabin: CabinCode;
  seat: string;
  boardingSequence: number;
  gate?: string;
  boardingTime: Date;
  barcode: string; // IATA BCBP-style payload; UI renders it as a QR code
  createdAt: Date;
  updatedAt: Date;
}

const boardingPassSchema = new Schema<IBoardingPass>(
  {
    checkInId: { type: Schema.Types.ObjectId, ref: "CheckIn", required: true, unique: true },
    pnrLocator: { type: String, required: true, uppercase: true, index: true },
    passengerName: { type: String, required: true },
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true, index: true },
    flightNumber: { type: String, required: true },
    origin: { type: String, required: true },
    destination: { type: String, required: true },
    departure: { type: Date, required: true },
    cabin: { type: String, enum: CABIN_CODES, required: true },
    seat: { type: String, required: true },
    boardingSequence: { type: Number, required: true },
    gate: String,
    boardingTime: { type: Date, required: true },
    barcode: { type: String, required: true },
  },
  { timestamps: true },
);

export const BoardingPass =
  (models.BoardingPass as Model<IBoardingPass>) || model<IBoardingPass>("BoardingPass", boardingPassSchema);
