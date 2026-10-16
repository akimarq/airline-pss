import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { handleError } from "@/lib/errors";
import { parseQuery } from "@/lib/validate";
import { searchFlights } from "@/modules/reservations/flights.service";
import { flightSearchQuery } from "@/modules/reservations/schemas";

// Public (no auth): flights with available fares for a route and UTC day.
export async function GET(req: Request) {
  try {
    const query = parseQuery(req, flightSearchQuery);
    await connectDB();
    const flights = await searchFlights(query);
    return NextResponse.json({ flights, count: flights.length });
  } catch (err) {
    return handleError(err);
  }
}
