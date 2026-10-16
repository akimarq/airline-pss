import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { connectDB, disconnectDB } from "@/lib/db";

let mongod: MongoMemoryServer | null = null;

/**
 * Start an in-memory MongoDB and connect mongoose to it (via the shared `connectDB`).
 * Call in `beforeAll`. Set TEST_MONGODB_URI to use an existing Mongo instead.
 */
export async function startTestDB(): Promise<string> {
  const uri = process.env.TEST_MONGODB_URI ?? (mongod = await MongoMemoryServer.create()).getUri("pss_test");
  process.env.MONGODB_URI = uri;
  await connectDB(uri);
  return uri;
}

/** Drop all documents but keep indexes. Call in `beforeEach`/`afterEach`. */
export async function clearTestDB(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/** Call in `afterAll`. */
export async function stopTestDB(): Promise<void> {
  await disconnectDB();
  await mongod?.stop();
  mongod = null;
}
