import type { ReactNode } from "react";

export type Tone = "gray" | "green" | "red" | "amber" | "blue" | "purple";

const tones: Record<Tone, string> = {
  gray: "bg-slate-100 text-slate-700 ring-slate-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  purple: "bg-violet-50 text-violet-700 ring-violet-200",
};

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  // PNR
  HELD: "amber",
  CONFIRMED: "blue",
  TICKETED: "green",
  CANCELLED: "red",
  EXPIRED: "gray",
  // tickets
  ISSUED: "green",
  USED: "gray",
  REFUNDED: "amber",
  VOID: "red",
  // flights
  SCHEDULED: "blue",
  BOARDING: "amber",
  CLOSED: "purple",
  DEPARTED: "gray",
  // check-in
  CHECKED_IN: "blue",
  BOARDED: "green",
  NO_SHOW: "red",
  // baggage
  CHECKED: "blue",
  SCREENED: "purple",
  LOADED: "green",
  OFFLOADED: "red",
  // load sheet / buckets
  DRAFT: "amber",
  FINAL: "green",
  OPEN: "green",
  CLOSED_BUCKET: "red",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "gray"}>{status.replace(/_/g, " ")}</Badge>;
}
