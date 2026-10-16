"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use } from "react";
import { RequireAuth } from "@/components/layout/Guards";
import { PnrDetail } from "@/components/pnr/PnrDetail";
import { LoadingBlock, PageHeader } from "@/components/ui";

function Inner({ locator }: { locator: string }) {
  const confirmed = useSearchParams().get("confirmed") === "1";
  return <PnrDetail locator={locator} confirmed={confirmed} />;
}

export default function BookingDetailPage({ params }: { params: Promise<{ locator: string }> }) {
  const { locator } = use(params);
  return (
    <RequireAuth>
      <PageHeader
        title="Booking details"
        actions={
          <Link href="/bookings" className="text-sm font-medium text-sky-700 hover:underline">
            ← All bookings
          </Link>
        }
      />
      <Suspense fallback={<LoadingBlock />}>
        <Inner locator={locator.toUpperCase()} />
      </Suspense>
    </RequireAuth>
  );
}
