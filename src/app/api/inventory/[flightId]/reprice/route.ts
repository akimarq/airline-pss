import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { reprice } from "@/modules/inventory/service";

// Staff: re-run the revenue rules engine for a flight.
export const POST = withAuth<{ flightId: string }>(["staff"], async (_req, { params }) => {
  const { flightId } = await params;
  await connectDB();
  const { changes, availability } = await reprice(flightId);
  return NextResponse.json({ changes, inventory: availability });
});
