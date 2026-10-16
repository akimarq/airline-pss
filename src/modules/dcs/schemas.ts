import { z } from "zod";
import { CHECKIN_CHANNELS } from "@/models";
import { MAX_SINGLE_BAG_KG } from "./constants";

export const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a 24-character hex ObjectId");
const locatorSchema = z
  .string()
  .trim()
  .length(6, "Record locator must be 6 characters")
  .transform((s) => s.toUpperCase());

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

export const checkInSchema = z
  .object({
    pnrLocator: locatorSchema,
    passengerId: z.string().min(1).optional(),
    ticketId: objectIdSchema.optional(),
    segmentIndex: z.number().int().min(0).optional(),
    seat: z
      .string()
      .trim()
      .regex(/^\d{1,3}[A-Za-z]$/, "Seat must look like 12A")
      .optional(),
    channel: z.enum(CHECKIN_CHANNELS),
    override: z.boolean().optional(),
  })
  .refine((v) => v.ticketId !== undefined || v.segmentIndex !== undefined, {
    message: "Provide ticketId or segmentIndex",
    path: ["ticketId"],
  });
export type CheckInInput = z.infer<typeof checkInSchema>;

export const checkInListQuerySchema = z.object({
  flightId: objectIdSchema.optional(),
  pnr: locatorSchema.optional(),
  ...pagination,
});

export const boardingPassListQuerySchema = z.object({ pnr: locatorSchema });

export const baggageCreateSchema = z
  .object({
    checkInId: objectIdSchema.optional(),
    pnrLocator: locatorSchema.optional(),
    passengerId: z.string().min(1).optional(),
    flightId: objectIdSchema.optional(),
    weightKg: z.number().positive().max(MAX_SINGLE_BAG_KG),
    acceptExcess: z.boolean().optional(),
  })
  .refine((v) => v.checkInId !== undefined || v.pnrLocator !== undefined, {
    message: "Provide checkInId, or pnrLocator (with passengerId/flightId as needed)",
    path: ["checkInId"],
  });
export type BaggageCreateInput = z.infer<typeof baggageCreateSchema>;

export const baggageStatusSchema = z.object({
  status: z.enum(["SCREENED", "LOADED", "OFFLOADED"]),
});

export const baggageListQuerySchema = z.object({
  pnr: locatorSchema.optional(),
  flightId: objectIdSchema.optional(),
  ...pagination,
});

export const loadInputSchema = z.object({
  cargoWeightKg: z.number().min(0),
  fuelWeightKg: z.number().min(0),
});

export const openBoardingSchema = z.object({
  gate: z.string().trim().min(1).max(10).optional(),
});

export const scanSchema = z
  .object({
    barcode: z.string().min(1).optional(),
    checkInId: objectIdSchema.optional(),
  })
  .refine((v) => (v.barcode === undefined) !== (v.checkInId === undefined), {
    message: "Provide exactly one of barcode or checkInId",
    path: ["barcode"],
  });
