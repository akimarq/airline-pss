import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { withAuth } from "@/lib/withAuth";
import { toPublicUser } from "@/modules/auth/service";
import { User } from "@/models";

export const GET = withAuth("any", async (_req, { user }) => {
  await connectDB();
  const doc = await User.findById(user.id);
  if (!doc) throw AppError.unauthorized("User no longer exists");
  return NextResponse.json({ user: toPublicUser(doc) });
});
