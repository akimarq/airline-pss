import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/withAuth";
import { parseBody } from "@/lib/validate";
import { patchBucketSchema } from "@/modules/inventory/schemas";
import { setBucket } from "@/modules/inventory/service";

// Staff: manually open/close a bucket or change its authorization.
export const PATCH = withAuth<{ flightId: string; class: string }>(["staff"], async (req, { user, params }) => {
  const { flightId, class: bucketClass } = await params;
  const patch = await parseBody(req, patchBucketSchema);
  await connectDB();
  const bucket = await setBucket(flightId, bucketClass, patch, user.id);
  return NextResponse.json({ bucket });
});
