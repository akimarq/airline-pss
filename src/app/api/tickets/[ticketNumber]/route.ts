import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { withId } from "@/modules/reservations/common";
import { getTicketForUser } from "@/modules/reservations/tickets.service";

// Ticket owner (via the PNR) or staff.
export const GET = withAuth<{ ticketNumber: string }>("any", async (_req, { user, params }) => {
  const { ticketNumber } = await params;
  await connectDB();
  const { ticket } = await getTicketForUser(ticketNumber, user);
  return NextResponse.json({ ticket: withId(ticket) });
});
