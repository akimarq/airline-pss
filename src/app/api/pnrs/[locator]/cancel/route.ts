import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { cancelPnr } from "@/modules/reservations/pnrs.service";

// Owner or staff: releases held/sold seats and voids tickets.
export const POST = withAuth<{ locator: string }>("any", async (_req, { user, params }) => {
  const { locator } = await params;
  await connectDB();
  return NextResponse.json(await cancelPnr(locator, user));
});
