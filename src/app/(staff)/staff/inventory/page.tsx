"use client";

import { FlightPicker } from "@/components/flights/FlightPicker";
import { PageHeader } from "@/components/ui";

export default function InventoryIndexPage() {
  return (
    <>
      <PageHeader title="Inventory control" subtitle="Choose a flight to manage buckets, load factor and revenue rules" />
      <FlightPicker hrefFor={(f) => `/staff/inventory/${f.id}`} actionLabel="Manage" />
    </>
  );
}
