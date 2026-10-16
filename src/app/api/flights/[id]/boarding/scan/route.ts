import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseBody } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { scanBoardingPass } from "@/modules/dcs/boarding";
import { scanSchema } from "@/modules/dcs/schemas";

// Staff only. Body: { barcode } or { checkInId }.
export const POST = withAuth<{ id: string }>(["staff"], async (req, { user, params }) => {
  const { id } = await params;
  const input = await parseBody(req, scanSchema);
  await connectDB();
  return NextResponse.json(await scanBoardingPass(user, id, input));
});
