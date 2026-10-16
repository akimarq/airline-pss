import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { deactivateFare, getFare, updateFare } from "@/modules/reservations/fares.service";
import { updateFareSchema } from "@/modules/reservations/schemas";

type Params = { id: string };

export const GET = withAuth<Params>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ fare: await getFare(id) });
});

export const PATCH = withAuth<Params>(["staff"], async (req, { params }) => {
  const { id } = await params;
  const patch = await parseBody(req, updateFareSchema);
  await connectDB();
  return NextResponse.json({ fare: await updateFare(id, patch) });
});

// Deactivates the fare (kept for existing PNRs/tickets that reference it).
export const DELETE = withAuth<Params>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ fare: await deactivateFare(id) });
});
