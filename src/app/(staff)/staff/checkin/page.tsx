"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CheckInPanel } from "@/components/checkin/CheckInPanel";
import { LoadingBlock, PageHeader } from "@/components/ui";

function Inner() {
  const locator = useSearchParams().get("locator") ?? "";
  return <CheckInPanel mode="staff" initialLocator={locator} />;
}

export default function StaffCheckInPage() {
  return (
    <>
      <PageHeader title="Check-in desk" subtitle="Airport check-in (AIRPORT channel) · opens 24 h before departure, closes 45 min before (override available)" />
      <Suspense fallback={<LoadingBlock />}>
        <Inner />
      </Suspense>
    </>
  );
}
