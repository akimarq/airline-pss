import { describe, expect, it } from "vitest";
import { BCBP_LENGTH, buildBcbp, julianDay, parseBcbp } from "@/modules/dcs/bcbp";
import { evaluateCheckInWindow } from "@/modules/dcs/checkin";
import { canTransition, computeExcess } from "@/modules/dcs/baggage";
import { computeLoad } from "@/modules/dcs/load";

const base = {
  passengerName: "DOE/JANE",
  pnrLocator: "ABC123",
  origin: "MNL",
  destination: "CEB",
  flightNumber: "PS101",
  departure: new Date("2026-03-01T06:30:00Z"), // day 60 of 2026
  cabin: "Y",
  seat: "12A",
  sequence: 7,
};

describe("BCBP builder", () => {
  it("builds the fixed-width 60 char payload", () => {
    const code = buildBcbp(base);
    expect(code).toHaveLength(BCBP_LENGTH);
    expect(code).toBe("M1DOE/JANE            EABC123 MNLCEBPS 0101 060Y012A0007 100");
  });

  it("pads/truncates names, supports suffixes and infants", () => {
    const long = buildBcbp({ ...base, passengerName: "VERYLONGSURNAME/VERYLONGFIRSTNAME", flightNumber: "PS7B" });
    expect(long).toHaveLength(BCBP_LENGTH);
    expect(long.slice(2, 22)).toBe("VERYLONGSURNAME/VERY");
    expect(long.slice(39, 44)).toBe("0007B");

    const infant = buildBcbp({ ...base, seat: "INF" });
    expect(infant.slice(48, 52)).toBe("INF ");
  });

  it("round-trips through parseBcbp", () => {
    const parsed = parseBcbp(buildBcbp(base));
    expect(parsed).toMatchObject({
      passengerName: "DOE/JANE",
      pnrLocator: "ABC123",
      origin: "MNL",
      destination: "CEB",
      carrier: "PS",
      flightNumber: "101",
      julianDate: 60,
      cabin: "Y",
      seat: "12A",
      sequence: 7,
    });
  });

  it("rejects bad input", () => {
    expect(() => buildBcbp({ ...base, flightNumber: "BAD" })).toThrow();
    expect(() => buildBcbp({ ...base, sequence: 0 })).toThrow();
    expect(() => parseBcbp("nope")).toThrow();
  });

  it("computes the julian day in UTC", () => {
    expect(julianDay(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    expect(julianDay(new Date("2026-12-31T23:59:00Z"))).toBe(365);
    expect(julianDay(new Date("2028-12-31T12:00:00Z"))).toBe(366);
  });
});

describe("check-in window (pure)", () => {
  const dep = new Date("2026-03-01T12:00:00Z");
  const at = (ms: number) => new Date(dep.getTime() + ms);
  it("opens at -24h and closes at -45min, inclusive", () => {
    expect(evaluateCheckInWindow(dep, at(-24 * 3_600_000 - 1))).toBe("TOO_EARLY");
    expect(evaluateCheckInWindow(dep, at(-24 * 3_600_000))).toBe("OPEN");
    expect(evaluateCheckInWindow(dep, at(-45 * 60_000))).toBe("OPEN");
    expect(evaluateCheckInWindow(dep, at(-45 * 60_000 + 1))).toBe("CLOSED");
    expect(evaluateCheckInWindow(dep, at(60_000))).toBe("CLOSED");
  });
});

describe("baggage helpers (pure)", () => {
  it("computes the excess of a new bag", () => {
    expect(computeExcess(0, 20, 23)).toEqual({ excess: false, excessKg: 0 });
    expect(computeExcess(20, 5, 23)).toEqual({ excess: true, excessKg: 2 });
    expect(computeExcess(30, 5, 23)).toEqual({ excess: true, excessKg: 5 }); // already over
  });

  it("allows only forward transitions and OFFLOADED from any earlier state", () => {
    expect(canTransition("CHECKED", "SCREENED")).toBe(true);
    expect(canTransition("SCREENED", "LOADED")).toBe(true);
    expect(canTransition("CHECKED", "LOADED")).toBe(false);
    expect(canTransition("LOADED", "SCREENED")).toBe(false);
    for (const s of ["CHECKED", "SCREENED", "LOADED"] as const) expect(canTransition(s, "OFFLOADED")).toBe(true);
    expect(canTransition("OFFLOADED", "CHECKED")).toBe(false);
    expect(canTransition("OFFLOADED", "OFFLOADED")).toBe(false);
  });
});

describe("computeLoad (pure)", () => {
  const limits = {
    operatingEmptyWeightKg: 40_000,
    maxZeroFuelWeightKg: 60_000,
    maxTakeoffWeightKg: 75_000,
    maxPayloadKg: 18_000,
    maxCargoWeightKg: 3_000,
  };

  it("applies standard weights (84 / 35 / 0)", () => {
    const c = computeLoad({ adults: 2, children: 1, infants: 1 }, { count: 2, weightKg: 35 }, { cargoWeightKg: 1000, fuelWeightKg: 10_000 }, limits);
    expect(c.passengerCount).toBe(3);
    expect(c.passengerWeightKg).toBe(2 * 84 + 35);
    expect(c.payloadKg).toBe(203 + 35 + 1000);
    expect(c.zeroFuelWeightKg).toBe(40_000 + 1238);
    expect(c.takeoffWeightKg).toBe(41_238 + 10_000);
    expect(c.withinLimits).toBe(true);
  });

  it("flags each limit", () => {
    const empty = { adults: 0, children: 0, infants: 0 };
    const none = { count: 0, weightKg: 0 };
    expect(computeLoad(empty, none, { cargoWeightKg: 3500, fuelWeightKg: 1 }, limits).warnings[0]).toMatch(/Cargo weight/);
    expect(computeLoad(empty, none, { cargoWeightKg: 0, fuelWeightKg: 40_000 }, limits)).toMatchObject({ withinLimits: false });
    expect(computeLoad(empty, { count: 1, weightKg: 20_000 }, { cargoWeightKg: 0, fuelWeightKg: 1 }, limits).withinLimits).toBe(false); // payload + zero fuel
    const near = computeLoad(empty, none, { cargoWeightKg: 2900, fuelWeightKg: 1 }, limits);
    expect(near.withinLimits).toBe(true);
    expect(near.warnings.some((w) => w.startsWith("NEAR LIMIT"))).toBe(true);
  });
});
