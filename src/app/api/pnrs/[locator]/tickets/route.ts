import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { readJsonOrEmpty } from "@/modules/inventory/helpers";
import { withId } from "@/modules/reservations/common";
import { buildPnrView } from "@/modules/reservations/pnrs.service";
import { issueTicketsSchema } from "@/modules/reservations/schemas";
import { issueTickets, listPnrTickets } from "@/modules/reservations/tickets.service";

type Params = { locator: string };

export const GET = withAuth<Params>("any", async (_req, { user, params }) => {
  const { locator } = await params;
  await connectDB();
  const tickets = await listPnrTickets(locator, user);
  return NextResponse.json({ tickets: tickets.map(withId) });
});

// Staff (payment optional) or the owner passenger (payment required): `{ payment: { method, simulate } }`.
// 201 when issued, 200 with `alreadyIssued: true` on a repeat call, 402 when the simulated payment fails.
export const POST = withAuth<Params>("any", async (req, { user, params }) => {
  const { locator } = await params;
  const input = issueTicketsSchema.parse(await readJsonOrEmpty(req));
  await connectDB();
  const result = await issueTickets(locator, user, input);
  return NextResponse.json(
    {
      pnr: await buildPnrView(result.pnr),
      tickets: result.tickets.map(withId),
      payment: result.payment,
      alreadyIssued: result.alreadyIssued,
    },
    { status: result.alreadyIssued ? 200 : 201 },
  );
});
