import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody, parseQuery } from "@/lib/validate";
import { createFare, listFares } from "@/modules/reservations/fares.service";
import { createFareSchema, fareListQuery } from "@/modules/reservations/schemas";

export const GET = withAuth(["staff"], async (req) => {
  const query = parseQuery(req, fareListQuery);
  await connectDB();
  return NextResponse.json(await listFares(query));
});

export const POST = withAuth(["staff"], async (req) => {
  const input = await parseBody(req, createFareSchema);
  await connectDB();
  return NextResponse.json({ fare: await createFare(input) }, { status: 201 });
});
