import { Schema, model, models, type Model, type Types } from "mongoose";

export const FLIGHT_STATUSES = ["SCHEDULED", "BOARDING", "CLOSED", "DEPARTED", "CANCELLED"] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

export interface IFlight {
  _id: Types.ObjectId;
  flightNumber: string; // e.g. "PS101"
  origin: string; // IATA airport code
  destination: string; // IATA airport code
  departure: Date;
  arrival: Date;
  aircraftId: Types.ObjectId;
  status: FlightStatus;
  gate?: string;
  boardingOpen: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const flightSchema = new Schema<IFlight>(
  {
    flightNumber: { type: String, required: true, uppercase: true, trim: true },
    origin: { type: String, required: true, uppercase: true, trim: true, minlength: 3, maxlength: 3 },
    destination: { type: String, required: true, uppercase: true, trim: true, minlength: 3, maxlength: 3 },
    departure: { type: Date, required: true },
    arrival: { type: Date, required: true },
    aircraftId: { type: Schema.Types.ObjectId, ref: "Aircraft", required: true },
    status: { type: String, enum: FLIGHT_STATUSES, required: true, default: "SCHEDULED" },
    gate: { type: String, trim: true },
    boardingOpen: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

flightSchema.index({ flightNumber: 1, departure: 1 }, { unique: true });
flightSchema.index({ origin: 1, destination: 1, departure: 1 }); // flight search

export const Flight = (models.Flight as Model<IFlight>) || model<IFlight>("Flight", flightSchema);
