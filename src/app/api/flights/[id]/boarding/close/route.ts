import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { closeBoarding } from "@/modules/dcs/boarding";

// Staff only. Marks no-shows, releases their seats, offloads their bags, closes the flight.
export const POST = withAuth<{ id: string }>(["staff"], async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ summary: await closeBoarding(user, id) });
});
