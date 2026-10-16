import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { parseBody } from "@/lib/validate";
import { withAuth } from "@/lib/withAuth";
import { getLoad, saveLoadDraft } from "@/modules/dcs/load";
import { loadInputSchema } from "@/modules/dcs/schemas";

// Staff only. Live draft computation.
export const GET = withAuth<{ id: string }>(["staff"], async (_req, { params }) => {
  const { id } = await params;
  await connectDB();
  return NextResponse.json(await getLoad(id));
});

// Staff only. Save/update the DRAFT with cargo and fuel inputs.
export const POST = withAuth<{ id: string }>(["staff"], async (req, { user, params }) => {
  const { id } = await params;
  const input = await parseBody(req, loadInputSchema);
  await connectDB();
  return NextResponse.json(await saveLoadDraft(user, id, input));
});
