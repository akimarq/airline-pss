import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { cancelCheckIn } from "@/modules/dcs/checkin";

// Owner of the PNR or staff. Only before boarding.
export const POST = withAuth<{ id: string }>("any", async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json(await cancelCheckIn(user, id));
});
