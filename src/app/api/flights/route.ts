import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody, parseQuery } from "@/lib/validate";
import { createFlight, listFlights } from "@/modules/reservations/flights.service";
import { createFlightSchema, flightListQuery } from "@/modules/reservations/schemas";

// Any authenticated user: paginated, filterable list.
export const GET = withAuth("any", async (req) => {
  const query = parseQuery(req, flightListQuery);
  await connectDB();
  return NextResponse.json(await listFlights(query));
});

// Staff: create a flight (optionally with its inventory via the `inventory` field).
export const POST = withAuth(["staff"], async (req, { user }) => {
  const input = await parseBody(req, createFlightSchema);
  await connectDB();
  return NextResponse.json(await createFlight(input, user.id), { status: 201 });
});
