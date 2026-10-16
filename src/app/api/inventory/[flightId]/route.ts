import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseQuery } from "@/lib/validate";
import { readJsonOrEmpty } from "@/modules/inventory/helpers";
import { availabilityQuerySchema, inventoryConfigSchema } from "@/modules/inventory/schemas";
import { createInventoryForFlight, getAvailability, toPublicAvailability } from "@/modules/inventory/service";

type Params = { flightId: string };

// Any authenticated user. Staff get the full picture (counters, sources, rules, holds); passengers only
// see open buckets with seats left.
export const GET = withAuth<Params>("any", async (req, { user, params }) => {
  const { flightId } = await params;
  await connectDB();
  if (user.role === "staff") {
    const { history } = parseQuery(req, availabilityQuerySchema);
    const view = await getAvailability(flightId, { includeHistory: history === "true" });
    return NextResponse.json({ inventory: view });
  }
  const view = await getAvailability(flightId);
  return NextResponse.json({ availability: toPublicAvailability(view) });
});

// Staff: create the inventory for a flight (cabins default from the aircraft layout).
export const POST = withAuth<Params>(["staff"], async (req, { user, params }) => {
  const { flightId } = await params;
  const config = inventoryConfigSchema.parse(await readJsonOrEmpty(req));
  await connectDB();
  const view = await createInventoryForFlight(flightId, config, user.id);
  return NextResponse.json({ inventory: view }, { status: 201 });
});
