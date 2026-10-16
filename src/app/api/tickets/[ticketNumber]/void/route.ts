import { NextResponse } from "next/server";
import { z } from "zod";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { readJsonOrEmpty } from "@/modules/inventory/helpers";
import { withId } from "@/modules/reservations/common";
import { buildPnrView } from "@/modules/reservations/pnrs.service";
import { voidTicket } from "@/modules/reservations/tickets.service";

const voidSchema = z.object({ reason: z.string().trim().max(200).optional() });

// Staff: voids the ticket and releases its seat. If every ticket of the PNR is void, the PNR becomes CANCELLED.
export const POST = withAuth<{ ticketNumber: string }>(["staff"], async (req, { user, params }) => {
  const { ticketNumber } = await params;
  const { reason } = voidSchema.parse(await readJsonOrEmpty(req));
  await connectDB();
  const { ticket, pnr } = await voidTicket(ticketNumber, user, reason);
  return NextResponse.json({ ticket: withId(ticket), pnr: await buildPnrView(pnr) });
});
