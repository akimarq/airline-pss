import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { getBoardingPass } from "@/modules/dcs/boardingPass";

// Owner of the PNR or staff. Generated on demand if missing.
export const GET = withAuth<{ checkInId: string }>("any", async (_req, { user, params }) => {
  const { checkInId } = await params;
  await connectDB();
  return NextResponse.json({ boardingPass: await getBoardingPass(user, checkInId) });
});
