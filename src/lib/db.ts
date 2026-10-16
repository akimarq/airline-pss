import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
}

// Cached on globalThis so Next.js hot reload doesn't open a new connection per reload.
const globalWithCache = globalThis as typeof globalThis & {
  _mongooseCache?: MongooseCache;
};
const cache: MongooseCache = (globalWithCache._mongooseCache ??= {
  conn: null,
  promise: null,
  uri: null,
});

/**
 * Connect (or reuse the existing connection) to MongoDB.
 * @param uri Optional override (used by tests); defaults to `process.env.MONGODB_URI`.
 */
export async function connectDB(uri?: string): Promise<typeof mongoose> {
  const target = uri ?? process.env.MONGODB_URI;
  if (!target) {
    throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local.");
  }

  // A different URI was requested than the cached one: drop the old connection.
  if (cache.uri && cache.uri !== target) {
    await disconnectDB();
  }

  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;

  if (!cache.promise) {
    cache.uri = target;
    cache.promise = mongoose
      .connect(target, { bufferCommands: false, serverSelectionTimeoutMS: 5000 })
      .catch((err) => {
        cache.promise = null; // allow retry on the next call
        cache.uri = null;
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectDB(): Promise<void> {
  cache.promise = null;
  cache.conn = null;
  cache.uri = null;
  await mongoose.disconnect();
}
