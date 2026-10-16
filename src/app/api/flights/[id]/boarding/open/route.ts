import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { openBoarding } from "@/modules/dcs/boarding";
import { openBoardingSchema } from "@/modules/dcs/schemas";

// Staff only. Requires a FINAL load sheet (no bypass). The body is optional: { gate? }.
export const POST = withAuth<{ id: string }>(["staff"], async (req, { user, params }) => {
  const { id } = await params;
  const text = await req.text();
  const { gate } = openBoardingSchema.parse(text.trim() ? JSON.parse(text) : {});
  await connectDB();
  const flight = await openBoarding(user, id, { gate });
  return NextResponse.json({ flight });
});
