import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { getSeatMap } from "@/modules/dcs/seatmap";

// Any authenticated user. Passengers get no passenger identities; staff get an `occupant` reference.
export const GET = withAuth<{ id: string }>("any", async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ seatMap: await getSeatMap(user, id) });
});
