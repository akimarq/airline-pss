import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("No database handle");
    await db.admin().ping();
    return NextResponse.json({ status: "ok", db: "up" });
  } catch (err) {
    console.error("Health check failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ status: "error", db: "down" }, { status: 503 });
  }
}
