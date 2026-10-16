import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { createStaffSchema } from "@/modules/auth/schemas";
import { createUser } from "@/modules/auth/service";

// Staff-only: an existing staff member creates another staff account.
export const POST = withAuth(["staff"], async (req) => {
  const { email, password, name } = await parseBody(req, createStaffSchema);
  await connectDB();
  const user = await createUser({ email, password, name, role: "staff" });
  return NextResponse.json({ user }, { status: 201 });
});
