"use client";

import Link from "next/link";
import { use } from "react";
import { PnrDetail } from "@/components/pnr/PnrDetail";
import { PageHeader } from "@/components/ui";

export default function StaffPnrDetailPage({ params }: { params: Promise<{ locator: string }> }) {
  const { locator } = use(params);
  return (
    <>
      <PageHeader
        title="PNR"
        actions={
          <Link href="/staff/pnr" className="text-sm font-medium text-sky-700 hover:underline">
            ← PNR desk
          </Link>
        }
      />
      <PnrDetail locator={locator.toUpperCase()} staff />
    </>
  );
}
