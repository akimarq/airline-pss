import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody, parseQuery } from "@/lib/validate";
import { createAircraft, listAircraft } from "@/modules/reservations/aircraft.service";
import { aircraftListQuery, createAircraftSchema } from "@/modules/reservations/schemas";

export const GET = withAuth(["staff"], async (req) => {
  const query = parseQuery(req, aircraftListQuery);
  await connectDB();
  return NextResponse.json(await listAircraft(query));
});

export const POST = withAuth(["staff"], async (req) => {
  const input = await parseBody(req, createAircraftSchema);
  await connectDB();
  return NextResponse.json({ aircraft: await createAircraft(input) }, { status: 201 });
});
