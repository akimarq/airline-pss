import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { rulesSchema } from "@/modules/inventory/schemas";
import { setRules } from "@/modules/inventory/service";

// Staff: replace the load-factor and time-to-departure rules, then re-run the engine.
export const PUT = withAuth<{ flightId: string }>(["staff"], async (req, { user, params }) => {
  const { flightId } = await params;
  const rules = await parseBody(req, rulesSchema);
  await connectDB();
  const inventory = await setRules(flightId, rules, user.id);
  return NextResponse.json({ inventory });
});
