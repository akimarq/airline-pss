import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { getAircraft, updateAircraft } from "@/modules/reservations/aircraft.service";
import { updateAircraftSchema } from "@/modules/reservations/schemas";

type Params = { id: string };

export const GET = withAuth<Params>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ aircraft: await getAircraft(id) });
});

export const PATCH = withAuth<Params>(["staff"], async (req, { params }) => {
  const { id } = await params;
  const patch = await parseBody(req, updateAircraftSchema);
  await connectDB();
  return NextResponse.json({ aircraft: await updateAircraft(id, patch) });
});
