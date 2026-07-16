import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HealthClient, ingestSamples, migrateDb, openDb } from "../src/index.ts";
import { ageYears, empiricalTdee, mifflinStJeor, slopePerDay, targetKcal, proteinTarget } from "../src/nutrition.ts";
import { seedTempDb, NOW } from "./fixtures.ts";

describe("nutrition formulas", () => {
  test("Mifflin-St Jeor matches the textbook", () => {
    // 76.66 kg, 184.15 cm, age 20, male -> 766.6 + 1150.9 - 100 + 5
    expect(mifflinStJeor(76.66, 184.15, 20, "male")).toBeCloseTo(1822.5, 0);
  });

  test("age handles birthdays correctly", () => {
    const now = new Date(2026, 6, 15).getTime(); // July 15, 2026
    expect(ageYears("2006-06-19", now)).toBe(20);
    expect(ageYears("2006-08-19", now)).toBe(19);
  });

  test("energy balance solves TDEE from intake and scale trend", () => {
    // eating 3000/day while gaining 0.5 lb/wk -> TDEE 2750
    expect(empiricalTdee(3000, 0.5 / 7)).toBeCloseTo(2750, 0);
  });

  test("slope recovers a known trend", () => {
    const day = 86_400_000;
    const points = Array.from({ length: 14 }, (_, i) => ({ ts: i * day, value: 169 + (0.5 / 7) * i }));
    expect(slopePerDay(points)! * 7).toBeCloseTo(0.5, 5);
    expect(slopePerDay([{ ts: 0, value: 1 }])).toBeNull();
  });

  test("targets", () => {
    expect(targetKcal(2750, 0.5)).toBe(3000);
    expect(proteinTarget(169)).toBe(152);
  });
});

describe("HealthClient.nutrition", () => {
  let dir: string;
  const day = 86_400_000;

  beforeAll(() => {
    ({ dir } = seedTempDb("baymax-nutrition-", { days: 5, now: NOW }));
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({ birthdate: "2006-06-19", heightIn: 72.5, sex: "male", activityFactor: 1.5 }),
    );
    writeFileSync(join(dir, "goals.json"), JSON.stringify([{ id: "weight-180", metric: "body_mass", targetLb: 180, ratePerWeekLb: 0.5 }]));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("seed mode: named formula, targets from profile", () => {
    const client = new HealthClient({ dbPath: join(dir, "test.db") });
    const n = client.nutrition({ now: NOW });
    expect(n.mode).toBe("seed");
    expect(n.method).toContain("Mifflin-St Jeor");
    expect(n.targetKcal).toBeGreaterThan(2500);
    expect(n.proteinG).toBeGreaterThan(130);
    expect(n.notes.join(" ")).toContain("logged days");
    client.close();
  });

  test("empirical mode activates with enough paired data and solves TDEE", () => {
    // Own clean DB: the shared fixtures contain body_mass samples that would pollute the trend.
    const dir2 = join(dir, "empirical");
    mkdirSync(dir2);
    const dbPath = join(dir2, "test.db");
    const iso = (i: number) => new Date(NOW - i * day).toISOString().slice(0, 10);
    copyFileSync(join(dir, "goals.json"), join(dir2, "goals.json"));
    copyFileSync(join(dir, "profile.json"), join(dir2, "profile.json"));
    writeFileSync(join(dir2, "nutrition.json"), JSON.stringify(Array.from({ length: 18 }, (_, i) => ({ date: iso(i), kcal: 3000 }))));
    const db = openDb({ path: dbPath });
    migrateDb(db);
    ingestSamples(db, {
      samples: Array.from({ length: 18 }, (_, i) => ({
        uuid: `nut-bw-${i}`,
        type: "HKQuantityTypeIdentifierBodyMass",
        value: (170 - (0.5 / 7) * i) * 0.45359237, // gaining toward NOW
        unit: "kg",
        start: NOW - i * day,
        end: NOW - i * day,
        source: { bundleId: "weights-json", name: "Weights Log" },
      })),
    });
    db.$client.close();

    const client = new HealthClient({ dbPath });
    const n = client.nutrition({ now: NOW });
    expect(n.mode).toBe("empirical");
    expect(n.tdee).toBeGreaterThan(2650);
    expect(n.tdee).toBeLessThan(2850); // ~2750: 3000 intake minus 250 stored
    expect(n.targetKcal).toBeGreaterThanOrEqual(2900);
    expect(n.observedRatePerWeekLb!).toBeCloseTo(0.5, 1);
    client.close();
  });
});
