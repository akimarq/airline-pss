import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { cancelFlight, getFlight, updateFlight } from "@/modules/reservations/flights.service";
import { updateFlightSchema } from "@/modules/reservations/schemas";

type Params = { id: string };

export const GET = withAuth<Params>("any", async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ flight: await getFlight(id) });
});

export const PATCH = withAuth<Params>(["staff"], async (req, { user, params }) => {
  const { id } = await params;
  const patch = await parseBody(req, updateFlightSchema);
  await connectDB();
  return NextResponse.json({ flight: await updateFlight(id, patch, user.id) });
});

// Soft cancel; 409 while active PNRs exist (cancel those first).
export const DELETE = withAuth<Params>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ flight: await cancelFlight(id) });
});
