import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseBody, parseQuery } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { createBaggage, listBaggage } from "@/modules/dcs/baggage";
import { baggageCreateSchema, baggageListQuerySchema } from "@/modules/dcs/schemas";

// Staff only.
export const POST = withAuth(["staff"], async (req, { user }) => {
  const input = await parseBody(req, baggageCreateSchema);
  await connectDB();
  return NextResponse.json({ baggage: await createBaggage(user, input) }, { status: 201 });
});

// Passengers see only bags of their own PNRs; staff see everything.
export const GET = withAuth("any", async (req, { user }) => {
  const q = parseQuery(req, baggageListQuerySchema);
  await connectDB();
  return NextResponse.json(await listBaggage(user, q));
});
