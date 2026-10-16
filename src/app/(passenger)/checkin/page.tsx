"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CheckInPanel } from "@/components/checkin/CheckInPanel";
import { RequireAuth } from "@/components/layout/Guards";
import { LoadingBlock, PageHeader } from "@/components/ui";

function Inner() {
  const locator = useSearchParams().get("locator") ?? "";
  return <CheckInPanel mode="passenger" initialLocator={locator} />;
}

export default function CheckInPage() {
  return (
    <RequireAuth>
      <PageHeader title="Online check-in" subtitle="Opens 24 hours before departure and closes 45 minutes before" />
      <Suspense fallback={<LoadingBlock />}>
        <Inner />
      </Suspense>
    </RequireAuth>
  );
}
