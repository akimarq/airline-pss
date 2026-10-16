/** Client-side shapes of the API responses (dates arrive as ISO strings). */

export type Role = "passenger" | "staff";
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type CabinCode = "F" | "J" | "Y";
export type PassengerType = "ADULT" | "CHILD" | "INFANT";
export type FlightStatus = "SCHEDULED" | "BOARDING" | "CLOSED" | "DEPARTED" | "CANCELLED";
export type PnrStatus = "HELD" | "CONFIRMED" | "TICKETED" | "CANCELLED" | "EXPIRED";

export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Flight {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  aircraftId: string;
  status: FlightStatus;
  gate?: string;
  boardingOpen: boolean;
}

export interface FareRules {
  refundable: boolean;
  changeable: boolean;
  checkedBaggageKg: number;
}

export interface OfferedFare {
  fareId: string;
  fareBasis: string;
  bookingClass: string;
  cabin: CabinCode;
  price: number;
  currency: string;
  rules: FareRules;
  scope: "flight" | "route";
  seatsAvailable: number;
}

export interface FlightSearchResult {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  fares: Partial<Record<CabinCode, OfferedFare>>;
  lowestFare: OfferedFare;
}

export interface Fare {
  id: string;
  flightId?: string;
  origin?: string;
  destination?: string;
  fareBasis: string;
  bookingClass: string;
  cabin: CabinCode;
  price: number;
  currency: string;
  rules: FareRules;
  active: boolean;
}

export interface CabinLayout {
  cabin: CabinCode;
  firstRow: number;
  lastRow: number;
  seatLetters: string[];
}

export interface Aircraft {
  id: string;
  type: string;
  registration: string;
  cabins: CabinLayout[];
  capacity: number;
}

export interface PnrPassenger {
  id: string;
  firstName: string;
  lastName: string;
  type: PassengerType;
  dateOfBirth?: string;
}

export interface PnrSegment {
  flightId: string;
  bookingClass: string;
  cabin: CabinCode;
  fareId: string;
  fareAmount: number;
  flight: Pick<Flight, "flightNumber" | "origin" | "destination" | "departure" | "arrival" | "status" | "gate"> | null;
}

export interface PnrHistoryEntry {
  at: string;
  actor?: string;
  action: string;
  details?: unknown;
}

export interface Pnr {
  id: string;
  recordLocator: string;
  ownerUserId: string;
  passengers: PnrPassenger[];
  segments: PnrSegment[];
  contact: { email: string; phone?: string };
  status: PnrStatus;
  holdExpiresAt?: string;
  totalAmount: number;
  currency: string;
  history: PnrHistoryEntry[];
  createdAt: string;
}

export type TicketStatus = "ISSUED" | "USED" | "REFUNDED" | "VOID";
export interface Ticket {
  id: string;
  ticketNumber: string;
  pnrId: string;
  pnrLocator: string;
  passengerId: string;
  passengerName: string;
  segmentIndex: number;
  flightId: string;
  bookingClass: string;
  fareAmount: number;
  currency: string;
  status: TicketStatus;
  issuedAt: string;
}

// ---- inventory ------------------------------------------------------------

export interface Bucket {
  class: string;
  authorized: number;
  sold: number;
  held: number;
  available: number;
  open: boolean;
  source: "manual" | "rule" | null;
}
export interface InventoryCabin {
  cabin: CabinCode;
  capacity: number;
  sold: number;
  held: number;
  loadFactorPct: number;
  buckets: Bucket[];
}
export interface LoadFactorRule {
  thresholdPct: number;
  closeClasses: string[];
}
export interface TimeToDepartureRule {
  daysBeforeDeparture: number;
  closeClasses: string[];
}
export interface InventoryHold {
  pnrLocator: string;
  cabin: CabinCode;
  bucketClass: string;
  seats: number;
  expiresAt: string;
}
export interface Inventory {
  flightId: string;
  capacity: number;
  sold: number;
  held: number;
  loadFactorPct: number;
  cabins: InventoryCabin[];
  holds: InventoryHold[];
  loadFactorRules: LoadFactorRule[];
  timeToDepartureRules: TimeToDepartureRule[];
}
export interface RuleChange {
  cabin: CabinCode;
  class: string;
  action: "CLOSED" | "REOPENED";
  reason: string;
}

// ---- DCS ------------------------------------------------------------------

export interface SeatMapSeat {
  seat: string;
  letter: string;
  status: "AVAILABLE" | "OCCUPIED";
  occupant?: { checkInId: string; pnrLocator: string; passengerId: string; status: string };
}
export interface SeatMap {
  flightId: string;
  flightNumber: string;
  aircraftType: string;
  cabins: {
    cabin: CabinCode;
    rows: { row: number; seats: SeatMapSeat[] }[];
    totalSeats: number;
    availableSeats: number;
  }[];
}

export type CheckInStatus = "CHECKED_IN" | "BOARDED" | "NO_SHOW";
/** Raw Mongo documents from the DCS endpoints carry `_id` (not `id`). */
export interface CheckIn {
  _id: string;
  pnrLocator: string;
  ticketId: string;
  passengerId: string;
  passengerName?: string;
  flightId: string;
  seat: string;
  boardingSequence: number;
  status: CheckInStatus;
  channel: "ONLINE" | "AIRPORT";
  checkedInAt: string;
  boardedAt?: string;
}

export interface BoardingPass {
  _id: string;
  checkInId: string;
  pnrLocator: string;
  passengerName: string;
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  cabin: CabinCode;
  seat: string;
  boardingSequence: number;
  gate?: string;
  boardingTime: string;
  barcode: string;
  checkInStatus?: CheckInStatus;
}

export type BaggageStatus = "CHECKED" | "SCREENED" | "LOADED" | "OFFLOADED";
export interface Baggage {
  _id: string;
  tagNumber: string;
  pnrLocator: string;
  passengerId: string;
  flightId: string;
  weightKg: number;
  excess?: boolean;
  excessKg?: number;
  allowanceKg?: number;
  status: BaggageStatus;
  history: { at: string; status: BaggageStatus }[];
}

export interface LoadLimits {
  operatingEmptyWeightKg: number;
  maxZeroFuelWeightKg: number;
  maxTakeoffWeightKg: number;
  maxPayloadKg: number;
  maxCargoWeightKg: number;
}
export interface LoadComputation {
  adults: number;
  children: number;
  infants: number;
  passengerCount: number;
  passengerWeightKg: number;
  baggageCount: number;
  baggageWeightKg: number;
  cargoWeightKg: number;
  fuelWeightKg: number;
  payloadKg: number;
  zeroFuelWeightKg: number;
  takeoffWeightKg: number;
  withinLimits: boolean;
  warnings: string[];
  limits: LoadLimits;
}
export interface LoadView {
  flightId: string;
  loadSheetStatus: "DRAFT" | "FINAL" | null;
  load: LoadComputation;
  loadSheet: { status: "DRAFT" | "FINAL"; finalizedAt?: string } | null;
  outOfDate: boolean;
}

export interface ManifestPassenger {
  checkInId: string;
  pnrLocator: string;
  passengerId: string;
  passengerName: string;
  type: string;
  seat: string;
  boardingSequence: number;
  status: CheckInStatus;
  channel: string;
  boardedAt?: string;
}
export interface Manifest {
  flight: { id: string; flightNumber: string; status: FlightStatus; gate?: string; boardingOpen: boolean };
  counts: {
    ticketed: number;
    checkedIn: number;
    boarded: number;
    notYetBoarded: number;
    notCheckedIn: number;
    noShow: number;
    noShowCandidates: number;
  };
  passengers: ManifestPassenger[];
  noShowCandidates: {
    kind: "CHECKED_IN_NOT_BOARDED" | "NOT_CHECKED_IN";
    pnrLocator: string;
    passengerName: string;
  }[];
}
export interface ScanResult {
  result: "BOARDED";
  checkInId: string;
  pnrLocator: string;
  passengerName: string;
  seat: string;
  boardingSequence: number;
  boardedAt: string;
}
export interface CloseSummary {
  flightId: string;
  status: "CLOSED";
  boarded: number;
  noShows: { checkedInNotBoarded: number; notCheckedIn: number; total: number };
  seatsReleased: { cabin: string; bucketClass: string; seats: number }[];
  inventoryReleaseFailures: { cabin: string; bucketClass: string; seats: number; error: string }[];
  baggageOffloaded: number;
  closedAt: string;
}
