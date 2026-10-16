import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { departFlight } from "@/modules/dcs/boarding";

// Staff only. CLOSED -> DEPARTED; boarded passengers' tickets become USED.
export const POST = withAuth<{ id: string }>(["staff"], async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json({ result: await departFlight(user, id) });
});
