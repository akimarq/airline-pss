import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody, parseQuery } from "@/lib/validate";
import { createPnr, listPnrs } from "@/modules/reservations/pnrs.service";
import { createPnrSchema, pnrListQuery } from "@/modules/reservations/schemas";

// Passengers see their own PNRs; staff see all (filters: status, locator, ownerUserId, email, flightId).
export const GET = withAuth("any", async (req, { user }) => {
  const query = parseQuery(req, pnrListQuery);
  await connectDB();
  return NextResponse.json(await listPnrs(user, query));
});

// Passenger (books for self) or staff (optionally for ownerUserId / ownerEmail). Seats are held atomically.
export const POST = withAuth("any", async (req, { user }) => {
  const input = await parseBody(req, createPnrSchema);
  await connectDB();
  return NextResponse.json({ pnr: await createPnr(user, input) }, { status: 201 });
});
