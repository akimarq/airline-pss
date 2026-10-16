import { AppError } from "@/lib/errors";
import { Aircraft } from "@/models";
import { toObjectId } from "@/modules/inventory/helpers";
import { toPage, withId } from "./common";
import type { CreateAircraftInput, UpdateAircraftInput } from "./schemas";

function layoutCapacity(cabins: { firstRow: number; lastRow: number; seatLetters: string[] }[]): number {
  return cabins.reduce((sum, c) => sum + (c.lastRow - c.firstRow + 1) * c.seatLetters.length, 0);
}

export async function createAircraft(input: CreateAircraftInput) {
  const capacity = input.capacity ?? layoutCapacity(input.cabins);
  const doc = await Aircraft.create({ ...input, capacity });
  return withId(doc.toObject());
}

export async function listAircraft(query: { type?: string; registration?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (query.type) filter.type = query.type;
  if (query.registration) filter.registration = query.registration.toUpperCase();
  const [items, total] = await Promise.all([
    Aircraft.find(filter)
      .sort({ registration: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Aircraft.countDocuments(filter),
  ]);
  return toPage(items.map(withId), query.page, query.limit, total);
}

export async function getAircraft(id: string) {
  const doc = await Aircraft.findById(toObjectId(id, "aircraft id")).lean();
  if (!doc) throw AppError.notFound("Aircraft not found");
  return withId(doc);
}

export async function updateAircraft(id: string, patch: UpdateAircraftInput) {
  const existing = await Aircraft.findById(toObjectId(id, "aircraft id"));
  if (!existing) throw AppError.notFound("Aircraft not found");
  const update: Record<string, unknown> = { ...patch };
  if (patch.cabins && patch.capacity === undefined && patch.cabins.length > 0) {
    update.capacity = layoutCapacity(patch.cabins);
  }
  existing.set(update);
  await existing.save();
  return withId(existing.toObject());
}
