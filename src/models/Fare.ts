import { Schema, model, models, type Model, type Types } from "mongoose";
import { CABIN_CODES, type CabinCode } from "./Aircraft";

export interface IFareRules {
  refundable: boolean;
  changeable: boolean;
  checkedBaggageKg: number; // free allowance per passenger
}

export interface IFare {
  _id: Types.ObjectId;
  // A fare applies to one specific flight, or to a route (origin+destination) when flightId is absent.
  flightId?: Types.ObjectId;
  origin?: string;
  destination?: string;
  fareBasis: string; // e.g. "YLOW1"
  bookingClass: string; // RBD letter, e.g. "Y", "B", "M", "K", "Q"
  cabin: CabinCode;
  price: number; // per passenger, single currency
  currency: string;
  rules: IFareRules;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const fareSchema = new Schema<IFare>(
  {
    flightId: { type: Schema.Types.ObjectId, ref: "Flight" },
    origin: { type: String, uppercase: true, trim: true },
    destination: { type: String, uppercase: true, trim: true },
    fareBasis: { type: String, required: true, uppercase: true, trim: true },
    bookingClass: { type: String, required: true, uppercase: true, trim: true, minlength: 1, maxlength: 1 },
    cabin: { type: String, enum: CABIN_CODES, required: true, default: "Y" },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "USD", uppercase: true },
    rules: {
      refundable: { type: Boolean, default: false },
      changeable: { type: Boolean, default: false },
      checkedBaggageKg: { type: Number, default: 20, min: 0 },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

fareSchema.index({ flightId: 1, bookingClass: 1 });
fareSchema.index({ origin: 1, destination: 1, bookingClass: 1 });

export const Fare = (models.Fare as Model<IFare>) || model<IFare>("Fare", fareSchema);
