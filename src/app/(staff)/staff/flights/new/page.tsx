"use client";

import { FlightForm } from "@/components/flights/FlightForm";
import { LinkButton, PageHeader } from "@/components/ui";

export default function NewFlightPage() {
  return (
    <>
      <PageHeader title="New flight" actions={<LinkButton href="/staff/flights" variant="secondary">Back to flights</LinkButton>} />
      <FlightForm />
    </>
  );
}
