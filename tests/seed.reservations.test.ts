import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as searchRoute } from "@/app/api/flights/search/route";
import { Aircraft, Fare, Flight, Inventory } from "@/models";
import { getAvailability, holdSeats } from "@/modules/inventory/service";
import { seedReservationsData } from "../scripts/seed-data/reservations";
import { clearTestDB, startTestDB, stopTestDB } from "./helpers/db";
import { call } from "./helpers/booking";

beforeAll(startTestDB);
afterAll(stopTestDB);
beforeEach(clearTestDB);

describe("seedReservationsData", () => {
  it("is idempotent and produces searchable flights without resetting inventory", async () => {
    const first = await seedReservationsData({ days: 3 });
    expect(first).toMatchObject({ aircraft: 2, flights: 18, flightsCreated: 18, inventoriesCreated: 18 });
    const counts = async () => [await Aircraft.countDocuments(), await Flight.countDocuments(), await Fare.countDocuments(), await Inventory.countDocuments()];
    const before = await counts();
    expect(before).toEqual([2, 18, 48, 18]);

    const flight = (await Flight.findOne({ flightNumber: "PS101" }).sort({ departure: -1 }))!; // furthest out: all classes open
    await holdSeats(flight._id, "Y", "M", 3, "SEED01");

    const second = await seedReservationsData({ days: 3 });
    expect(second).toMatchObject({ flightsCreated: 0, inventoriesCreated: 0 });
    expect(await counts()).toEqual(before);
    const bucket = (await getAvailability(flight._id)).cabins.flatMap((c) => c.buckets).find((b) => b.class === "M")!;
    expect(bucket.held).toBe(3);

    const date = flight.departure.toISOString().slice(0, 10);
    const search = await call(searchRoute, "GET", `/api/flights/search?from=MNL&to=CEB&date=${date}`);
    expect(search.json.count).toBe(1);
    expect(search.json.flights[0].fares.Y.price).toBeGreaterThan(0);
  });
});
