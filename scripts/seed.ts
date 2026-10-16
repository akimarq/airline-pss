/**
 * Seed script. Run with `npm run seed` (or `npm run seed -- --reset`). Idempotent.
 *
 *   npm run seed                    users + aircraft/flights/fares/inventory + demo bookings (if missing)
 *   npm run seed -- --reset         remove the DEMO data only (demo bookings + demo flight PS900), then recreate it
 *   npm run seed -- --reset-only    remove the demo data and stop
 *
 * `--reset` never drops the database or touches other users' bookings: demo data is identified by the
 * contact e-mail `demo-seed@airline.test` and the flight number PS900.
 */
import { existsSync } from "node:fs";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import { DEMO_MARKER_EMAIL, SEED_USERS, parseSeedArgs, resetDemoData, seedDemoBookings, seedUsers } from "./seed-data/demo";
import { seedReservationsData } from "./seed-data/reservations";

// tsx does not load Next's env files, so load .env.local manually (Node >= 20.12).
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** `host/db` of the target, never the credentials. */
function describeTarget(uri: string | undefined): string {
  if (!uri) return "(MONGODB_URI not set)";
  try {
    const url = new URL(uri);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(unparseable MONGODB_URI)";
  }
}

async function main() {
  const args = parseSeedArgs(process.argv.slice(2));
  console.log(`Target database: ${describeTarget(process.env.MONGODB_URI)}`);
  await connectDB();
  const log = (message: string) => console.log(message);

  // Build collections and indexes (unique/partial ones included) before writing anything, instead of racing
  // Mongoose's background index builds against the first inserts.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

  if (args.reset) {
    console.log("Resetting demo data (only demo bookings and the demo flight)...");
    await resetDemoData(log);
    if (args.resetOnly) {
      console.log("Done.");
      return;
    }
  }

  console.log("Seeding users...");
  await seedUsers(log);

  console.log("Seeding aircraft, fares, flights and inventory...");
  const reservations = await seedReservationsData({ log });

  console.log("Seeding demo bookings...");
  const demo = await seedDemoBookings(log);

  console.log("\n=== Seed summary ===");
  console.log(
    `Aircraft: ${reservations.aircraft} | Flights: ${reservations.flights} (${reservations.flightsCreated} new) | ` +
      `Fares: ${reservations.fares} | New inventories: ${reservations.inventoriesCreated}`,
  );
  console.log(demo.created ? `Demo bookings created: ${demo.bookings.length} (contact ${DEMO_MARKER_EMAIL})` : "Demo bookings: already present");
  console.log("\nDemo credentials:");
  for (const u of SEED_USERS) console.log(`  ${u.role.padEnd(9)} ${u.email} / ${u.password}`);
  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDB());


