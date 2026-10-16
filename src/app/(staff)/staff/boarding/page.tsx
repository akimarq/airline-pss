"use client";

import { FlightPicker } from "@/components/flights/FlightPicker";
import { PageHeader } from "@/components/ui";

export default function BoardingIndexPage() {
  return (
    <>
      <PageHeader title="Gate boarding" subtitle="Choose a flight to open boarding, scan passengers and depart" />
      <FlightPicker hrefFor={(f) => `/staff/boarding/${f.id}`} actionLabel="Gate" />
    </>
  );
}
