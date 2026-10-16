import { AppError } from "@/lib/errors";

/**
 * Simplified IATA BCBP (Resolution 792, "Bar Coded Boarding Pass") for ONE leg.
 *
 * Fixed-width, 60 characters, following the mandatory section of BCBP:
 *
 *   pos  len  field
 *   0    1    format code                 "M"
 *   1    1    number of legs              "1"
 *   2    20   passenger name              "LAST/FIRST", upper-case, space padded / truncated
 *   22   1    electronic ticket indicator "E"
 *   23   7    operating carrier PNR code  record locator, space padded
 *   30   3    from airport                IATA code
 *   33   3    to airport                  IATA code
 *   36   3    operating carrier           "PS ", space padded
 *   39   5    flight number               4 digits zero padded + 1 suffix char (space), e.g. "0101 "
 *   44   3    date of flight              Julian day-of-year (UTC) of departure, zero padded
 *   47   1    compartment code            F / J / Y
 *   48   4    seat number                 3-digit row + letter ("012A"); "INF " for lap infants
 *   52   5    check-in sequence number    4 digits + 1 space, e.g. "0007 "
 *   57   1    passenger status            "1" (checked in)
 *   58   2    conditional-section size    "00" (hex length; we carry no conditional/airline data)
 *
 * Differences from the real standard: single leg only, no conditional or security sections,
 * Julian date uses the UTC day of year (no year digit), and no signature.
 */

export interface BcbpInput {
  passengerName: string; // "LAST/FIRST"
  pnrLocator: string;
  origin: string;
  destination: string;
  flightNumber: string; // e.g. "PS101" or "PS101A"
  departure: Date;
  cabin: string; // F | J | Y
  seat: string; // "12A" or "INF"
  sequence: number; // check-in / boarding sequence
}

export interface BcbpParsed {
  passengerName: string;
  pnrLocator: string;
  origin: string;
  destination: string;
  carrier: string;
  flightNumber: string; // digits without leading zeros, plus suffix, e.g. "101"
  julianDate: number;
  cabin: string;
  seat: string;
  sequence: number;
}

export const BCBP_LENGTH = 60;

const padRight = (value: string, len: number) => value.slice(0, len).padEnd(len, " ");
const padLeftZero = (value: number, len: number) => String(value).padStart(len, "0");

/** Day of year (1-366) of a date, computed in UTC. */
export function julianDay(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((day - start) / 86_400_000);
}

function formatSeat(seat: string): string {
  const s = seat.trim().toUpperCase();
  const m = /^(\d{1,3})([A-Z])$/.exec(s);
  if (m) return `${m[1].padStart(3, "0")}${m[2]}`;
  return padRight(s.slice(0, 3), 4); // "INF" -> "INF "
}

export function buildBcbp(input: BcbpInput): string {
  const fn = /^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(input.flightNumber.trim().toUpperCase());
  if (!fn) throw AppError.badRequest(`Cannot build a boarding pass barcode for flight number '${input.flightNumber}'`);
  const [, carrier, digits, suffix] = fn;
  if (!Number.isInteger(input.sequence) || input.sequence < 1 || input.sequence > 9999) {
    throw AppError.badRequest("Check-in sequence must be an integer between 1 and 9999");
  }

  const out =
    "M" +
    "1" +
    padRight(input.passengerName.toUpperCase(), 20) +
    "E" +
    padRight(input.pnrLocator.toUpperCase(), 7) +
    padRight(input.origin.toUpperCase(), 3) +
    padRight(input.destination.toUpperCase(), 3) +
    padRight(carrier, 3) +
    padLeftZero(Number(digits), 4) +
    (suffix || " ") +
    padLeftZero(julianDay(input.departure), 3) +
    input.cabin.toUpperCase().slice(0, 1) +
    formatSeat(input.seat) +
    padLeftZero(input.sequence, 4) +
    " " +
    "1" +
    "00";

  if (out.length !== BCBP_LENGTH) throw new Error(`BCBP length ${out.length}, expected ${BCBP_LENGTH}`);
  return out;
}

/** Parse a payload produced by `buildBcbp`. Throws a 400 AppError when malformed. */
export function parseBcbp(barcode: string): BcbpParsed {
  if (typeof barcode !== "string" || barcode.length !== BCBP_LENGTH || !barcode.startsWith("M1")) {
    throw AppError.badRequest("Malformed boarding pass barcode");
  }
  const seq = Number(barcode.slice(52, 56));
  const julian = Number(barcode.slice(44, 47));
  const flightDigits = Number(barcode.slice(39, 43));
  if (!Number.isInteger(seq) || !Number.isInteger(julian) || !Number.isInteger(flightDigits)) {
    throw AppError.badRequest("Malformed boarding pass barcode");
  }
  const rawSeat = barcode.slice(48, 52);
  const seatMatch = /^0*(\d{1,3})([A-Z])$/.exec(rawSeat);
  return {
    passengerName: barcode.slice(2, 22).trim(),
    pnrLocator: barcode.slice(23, 30).trim(),
    origin: barcode.slice(30, 33),
    destination: barcode.slice(33, 36),
    carrier: barcode.slice(36, 39).trim(),
    flightNumber: `${flightDigits}${barcode.slice(43, 44).trim()}`,
    julianDate: julian,
    cabin: barcode.slice(47, 48),
    seat: seatMatch ? `${seatMatch[1]}${seatMatch[2]}` : rawSeat.trim(),
    sequence: seq,
  };
}
