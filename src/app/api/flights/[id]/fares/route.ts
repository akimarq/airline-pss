import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { handleError } from "@/lib/errors";
import { parseQuery } from "@/lib/validate";
import { getFlightFares } from "@/modules/reservations/fares.service";
import { flightFaresQuery } from "@/modules/reservations/schemas";

// Public: fares whose bucket is currently open with seats left (`?passengers=n` requires n seats).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { passengers } = parseQuery(req, flightFaresQuery);
    await connectDB();
    const fares = await getFlightFares(id, passengers);
    return NextResponse.json({ flightId: id, fares });
  } catch (err) {
    return handleError(err);
  }
}
