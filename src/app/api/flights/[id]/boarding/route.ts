import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { getBoardingManifest } from "@/modules/dcs/boarding";

// Staff only: manifest and counts.
export const GET = withAuth<{ id: string }>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json(await getBoardingManifest(id));
});
