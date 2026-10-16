import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseBody } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { getBaggage, updateBaggageStatus } from "@/modules/dcs/baggage";
import { baggageStatusSchema } from "@/modules/dcs/schemas";

// Owner of the PNR or staff.
export const GET = withAuth<{ tag: string }>("any", async (_req, { user, params }) => {
  const { tag } = await params;
  await connectDB();
  return NextResponse.json({ baggage: await getBaggage(user, tag) });
});

// Staff only: CHECKED -> SCREENED -> LOADED, or OFFLOADED.
export const PATCH = withAuth<{ tag: string }>(["staff"], async (req, { user, params }) => {
  const { tag } = await params;
  const { status } = await parseBody(req, baggageStatusSchema);
  await connectDB();
  return NextResponse.json({ baggage: await updateBaggageStatus(user, tag, status) });
});
