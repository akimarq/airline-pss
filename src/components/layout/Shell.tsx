import type { ReactNode } from "react";
import { Navbar } from "./Navbar";

/** Page chrome shared by both route groups: nav bar, centred container, footer. */
export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <Navbar />
      <main className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6 sm:py-8 ${wide ? "max-w-7xl" : "max-w-6xl"}`}>{children}</main>
      <footer className="no-print border-t border-slate-200 py-4 text-center text-xs text-slate-400">SkyPSS demo · all times shown in UTC · payments are simulated</footer>
    </>
  );
}
