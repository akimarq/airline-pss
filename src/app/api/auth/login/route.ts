import { NextResponse } from "next/server";
import { setAuthCookie } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { handleError } from "@/lib/errors";
import { parseBody } from "@/lib/validate";
import { loginSchema } from "@/modules/auth/schemas";
import { authenticate } from "@/modules/auth/service";

export async function POST(req: Request) {
  try {
    const { email, password } = await parseBody(req, loginSchema);
    await connectDB();
    const { token, user } = await authenticate(email, password);
    const res = NextResponse.json({ token, user });
    setAuthCookie(res, token);
    return res;
  } catch (err) {
    return handleError(err);
  }
}
