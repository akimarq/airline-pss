import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { finalizeLoad } from "@/modules/dcs/load";

// Staff only. 409 when aircraft limits are exceeded or the sheet is already FINAL.
export const POST = withAuth<{ id: string }>(["staff"], async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json(await finalizeLoad(user, id));
});
