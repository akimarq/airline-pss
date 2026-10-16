import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseQuery } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { listBoardingPasses } from "@/modules/dcs/boardingPass";
import { boardingPassListQuerySchema } from "@/modules/dcs/schemas";

// Owner of the PNR or staff.
export const GET = withAuth("any", async (req, { user }) => {
  const { pnr } = parseQuery(req, boardingPassListQuerySchema);
  await connectDB();
  return NextResponse.json({ boardingPasses: await listBoardingPasses(user, pnr) });
});
