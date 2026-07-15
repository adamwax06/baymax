import { describe, expect, test } from "bun:test";
import { METRICS, metricByName, workoutActivityName } from "../src/index.ts";

describe("registry", () => {
  test("friendly names are unique", () => {
    const names = METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("HealthKit identifiers are unique and well-formed", () => {
    const types = METRICS.map((m) => m.hkType);
    expect(new Set(types).size).toBe(types.length);
    for (const m of METRICS) {
      expect(m.hkType).toMatch(m.kind === "quantity" ? /^HKQuantityTypeIdentifier/ : /^HKCategoryTypeIdentifier/);
    }
  });

  test("quantity metrics have units; category metrics don't", () => {
    for (const m of METRICS) {
      if (m.kind === "quantity") expect(m.unit).not.toBeNull();
      else expect(m.unit).toBeNull();
    }
  });

  test("sleep decodes its category values", () => {
    expect(metricByName("sleep")!.categoryValues![4]).toBe("asleepDeep");
  });

  test("workout activity names decode with fallback", () => {
    expect(workoutActivityName(37)).toBe("running");
    expect(workoutActivityName(13)).toBe("cycling");
    expect(workoutActivityName(424242)).toBe("unknown_424242");
  });
});
