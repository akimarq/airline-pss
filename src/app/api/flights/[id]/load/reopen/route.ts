import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { reopenLoad } from "@/modules/dcs/load";

// Staff only. FINAL -> DRAFT.
export const POST = withAuth<{ id: string }>(["staff"], async (_req, { user, params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json(await reopenLoad(user, id));
});
