import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { getPnrForUser, updatePnr } from "@/modules/reservations/pnrs.service";
import { updatePnrSchema } from "@/modules/reservations/schemas";

type Params = { locator: string };

// Owner or staff. A lapsed hold is flipped to EXPIRED lazily here.
export const GET = withAuth<Params>("any", async (_req, { user, params }) => {
  const { locator } = await params;
  await connectDB();
  return NextResponse.json(await getPnrForUser(locator, user));
});

export const PATCH = withAuth<Params>("any", async (req, { user, params }) => {
  const { locator } = await params;
  const patch = await parseBody(req, updatePnrSchema);
  await connectDB();
  return NextResponse.json({ pnr: await updatePnr(locator, user, patch) });
});
