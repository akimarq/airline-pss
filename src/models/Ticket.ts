import { Schema, model, models, type Model, type Types } from "mongoose";

export const TICKET_STATUSES = ["ISSUED", "USED", "REFUNDED", "VOID"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** One ticket per passenger per PNR segment (so each flight leg has its own ticket/coupon). */
export interface ITicket {
  _id: Types.ObjectId;
  ticketNumber: string; // 13 digits: 3-digit airline prefix + 10-digit serial, unique
  pnrId: Types.ObjectId;
  pnrLocator: string;
  passengerId: string; // IPnrPassenger.id
  passengerName: string; // "LAST/FIRST"
  segmentIndex: number; // index into PNR.segments
  flightId: Types.ObjectId;
  bookingClass: string;
  fareId: Types.ObjectId;
  fareAmount: number;
  currency: string;
  status: TicketStatus;
  issuedAt: Date;
  issuedBy?: Types.ObjectId;
  voidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ticketSchema = new Schema<ITicket>(
  {
    ticketNumber: { type: String, required: true, unique: true, match: /^\d{13}$/ },
    pnrId: { type: Schema.Types.ObjectId, ref: "PNR", required: true, index: true },
    pnrLocator: { type: String, required: true, uppercase: true, index: true },
    passengerId: { type: String, required: true },
    passengerName: { type: String, required: true },
    segmentIndex: { type: Number, required: true, min: 0 },
    flightId: { type: Schema.Types.ObjectId, ref: "Flight", required: true, index: true },
    bookingClass: { type: String, required: true, uppercase: true },
    fareId: { type: Schema.Types.ObjectId, ref: "Fare", required: true },
    fareAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "USD", uppercase: true },
    status: { type: String, enum: TICKET_STATUSES, required: true, default: "ISSUED" },
    issuedAt: { type: Date, required: true, default: Date.now },
    issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
    voidedAt: Date,
  },
  { timestamps: true },
);

export const Ticket = (models.Ticket as Model<ITicket>) || model<ITicket>("Ticket", ticketSchema);
