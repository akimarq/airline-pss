import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseBody, parseQuery } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { checkInListQuerySchema, checkInSchema } from "@/modules/dcs/schemas";
import { checkInPassenger, listCheckIns } from "@/modules/dcs/checkin";

// Passenger (own PNR, ONLINE channel) or staff (ONLINE/AIRPORT, any PNR).
export const POST = withAuth("any", async (req, { user }) => {
  const input = await parseBody(req, checkInSchema);
  await connectDB();
  const { checkIn, boardingPass } = await checkInPassenger(user, input);
  return NextResponse.json({ checkIn, boardingPass }, { status: 201 });
});

// Staff (any) or passenger (must pass their own `pnr`).
export const GET = withAuth("any", async (req, { user }) => {
  const q = parseQuery(req, checkInListQuerySchema);
  await connectDB();
  return NextResponse.json(await listCheckIns(user, q));
});
