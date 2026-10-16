import { Schema, model, models, type Model, type Types } from "mongoose";

export const CHECKIN_STATUSES = ["CHECKED_IN", "BOARDED", "NO_SHOW"] as const;
export type CheckInStatus = (typeof CHECKIN_STATUSES)[number];

export const CHECKIN_CHANNELS = ["ONLINE", "AIRPORT"] as const;
export type CheckInChannel = (typeof CHECKIN_CHANNELS)[number];

export interface ICheckIn {
  _id: Types.ObjectId;
  pnrId: Types.ObjectId;
  pnrLocator: string;
  ticketId: Types.ObjectId;
  passengerId: string; // IPnrPassenger.id
  flightId: Types.ObjectId;
  seat: string; // e.g. "12A"
  boardingSequence: number; // 1..n per flight
  status: CheckInStatus;
  channel: CheckInChannel;
  checkedInBy?: Types.ObjectId;
  checkedInAt: Date;
  boardedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const checkInSchema = new Schema<ICheckIn>(
  {
    pnrId: { type: Schema.Types.ObjectId, ref: "PNR", required: true },
    pnrLocator: { type: String, required: true, uppercase: true },
    ticketId: { type: Schema.Types.ObjectId, ref: "Ticket", required: true, unique: true },
    passengerId: { type: String, required: true },
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true },
    seat: { type: String, required: true, uppercase: true },
    boardingSequence: { type: Number, required: true, min: 1 },
    status: { type: String, enum: CHECKIN_STATUSES, required: true, default: "CHECKED_IN" },
    channel: { type: String, enum: CHECKIN_CHANNELS, required: true, default: "ONLINE" },
    checkedInBy: { type: Schema.Types.ObjectId, ref: "User" },
    checkedInAt: { type: Date, required: true, default: Date.now },
    boardedAt: Date,
  },
  { timestamps: true },
);

// A seat can only be held by one active check-in per flight (prevents double seat assignment).
checkInSchema.index(
  { flightId: 1, seat: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["CHECKED_IN", "BOARDED"] } } },
);
checkInSchema.index({ flightId: 1, boardingSequence: 1 }, { unique: true });
checkInSchema.index({ pnrId: 1 });

export const CheckIn = (models.CheckIn as Model<ICheckIn>) || model<ICheckIn>("CheckIn", checkInSchema);
