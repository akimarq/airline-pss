import type { Types } from "mongoose";

/**
 * Port to the Inventory module, isolating the one cross-module dependency of DCS: releasing the
 * sold seats of no-show passengers when boarding closes.
 *
 * The real implementation lives in `@/modules/inventory/service` (built by the Inventory worker):
 *   releaseSoldSeats(flightId, cabin, bucketClass, seats, actor): Promise<void>
 *
 * TODO: once `@/modules/inventory/service` is merged and stable, replace the dynamic import with a
 * plain static import and delete the fallback below.
 *
 * The import is typed loosely (local interface + cast, with a non-literal-typed specifier) so
 * `tsc` passes whether or not the module exists yet. If the module cannot be loaded we log a
 * warning and no-op instead of crashing the gate flow.
 */

interface InventoryServiceModule {
  releaseSoldSeats(
    flightId: string | Types.ObjectId,
    cabin: string,
    bucketClass: string,
    seats: number,
    actor: string,
  ): Promise<void>;
}

let warned = false;

async function loadInventoryService(): Promise<InventoryServiceModule | null> {
  try {
    const mod = (await import("@/modules/inventory/service" as string)) as unknown as Partial<InventoryServiceModule>;
    if (typeof mod.releaseSoldSeats === "function") return mod as InventoryServiceModule;
  } catch {
    // module not present yet: fall through to the no-op
  }
  return null;
}

export async function releaseSoldSeats(
  flightId: string | Types.ObjectId,
  cabin: string,
  bucketClass: string,
  seats: number,
  actor: string,
): Promise<void> {
  const inventory = await loadInventoryService();
  if (!inventory) {
    if (!warned) {
      warned = true;
      console.warn(
        "[dcs] @/modules/inventory/service.releaseSoldSeats is not available yet; no-show seat release skipped (no-op).",
      );
    }
    return;
  }
  await inventory.releaseSoldSeats(flightId, cabin, bucketClass, seats, actor);
}
