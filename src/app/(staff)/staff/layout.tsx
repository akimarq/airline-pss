import type { ReactNode } from "react";
import { RequireAuth } from "@/components/layout/Guards";
import { Shell } from "@/components/layout/Shell";
import { StaffNav } from "@/components/layout/StaffNav";

export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <Shell wide>
      <RequireAuth role="staff">
        <StaffNav />
        {children}
      </RequireAuth>
    </Shell>
  );
}
