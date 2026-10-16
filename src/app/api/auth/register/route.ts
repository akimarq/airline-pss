import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { handleError } from "@/lib/errors";
import { parseBody } from "@/lib/validate";
import { registerSchema } from "@/modules/auth/schemas";
import { createUser } from "@/modules/auth/service";

// Public self-registration: always creates a passenger. Staff are created via POST /api/auth/staff.
export async function POST(req: Request) {
  try {
    const { email, password, name } = await parseBody(req, registerSchema);
    await connectDB();
    const user = await createUser({ email, password, name, role: "passenger" });
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
