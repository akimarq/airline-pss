"use client";

import { FlightPicker } from "@/components/flights/FlightPicker";
import { PageHeader } from "@/components/ui";

export default function LoadIndexPage() {
  return (
    <>
      <PageHeader title="Load control" subtitle="Choose a flight to compute weight & balance and finalize its load sheet" />
      <FlightPicker hrefFor={(f) => `/staff/load/${f.id}`} actionLabel="Load sheet" />
    </>
  );
}
