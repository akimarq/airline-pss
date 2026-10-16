/** Formatting helpers. All times in the UI are shown and entered in UTC (the API treats search days as UTC days). */

import type { CabinCode } from "./types";

export const CABIN_NAMES: Record<CabinCode, string> = { F: "First", J: "Business", Y: "Economy" };
export const CABIN_CODES: CabinCode[] = ["F", "J", "Y"];

export function fmtMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtDate = (iso?: string | null) => (iso ? dateFmt.format(new Date(iso)) : "–");
export const fmtTime = (iso?: string | null) => (iso ? `${timeFmt.format(new Date(iso))}Z` : "–");
export const fmtDateTime = (iso?: string | null) => (iso ? `${dateFmt.format(new Date(iso))} ${fmtTime(iso)}` : "–");

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** `YYYY-MM-DD` (UTC) for an ISO string or Date; defaults to now. */
export function utcDate(d: Date | string = new Date(), plusDays = 0): string {
  const date = typeof d === "string" ? new Date(d) : new Date(d.getTime());
  date.setUTCDate(date.getUTCDate() + plusDays);
  return date.toISOString().slice(0, 10);
}

/** ISO -> value for `<input type="datetime-local">` (UTC wall clock). */
export const toDateTimeInput = (iso: string) => iso.slice(0, 16);
/** `<input type="datetime-local">` value (interpreted as UTC) -> ISO string. */
export const fromDateTimeInput = (v: string) => new Date(`${v}:00.000Z`).toISOString();

export const fmtCountdown = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const PASSENGER_TYPE_LABELS = { ADULT: "Adult", CHILD: "Child", INFANT: "Infant (lap)" } as const;

export const isObjectId = (s: string) => /^[a-f\d]{24}$/i.test(s.trim());
