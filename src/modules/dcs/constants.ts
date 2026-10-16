/** DCS tunables. Kept in one place so tests and docs can reference them. */

/** Online/airport check-in opens this many hours before scheduled departure. */
export const CHECKIN_OPEN_HOURS_BEFORE = 24;
/** Check-in closes this many minutes before scheduled departure. */
export const CHECKIN_CLOSE_MINUTES_BEFORE = 45;
/** Boarding time printed on the pass = departure minus this many minutes. */
export const BOARDING_MINUTES_BEFORE = 40;

/** Free checked-baggage allowance (kg) used when the ticket's fare cannot be resolved. */
export const DEFAULT_BAGGAGE_ALLOWANCE_KG = 23;
/** Sanity cap for a single bag (kg). */
export const MAX_SINGLE_BAG_KG = 50;

/** Standard passenger weights (kg) used for load control. */
export const STANDARD_WEIGHTS_KG = { ADULT: 84, CHILD: 35, INFANT: 0 } as const;

/** A computed total at or above this fraction of a limit produces a "near limit" warning. */
export const NEAR_LIMIT_RATIO = 0.95;

export function airlineCode(): string {
  return (process.env.AIRLINE_CODE || "PS").toUpperCase();
}
