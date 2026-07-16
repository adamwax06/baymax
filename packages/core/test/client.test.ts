import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { HealthClient } from "../src/index.ts";
import { EIGHT_SLEEP, STRAVA, NOW, seedTempDb } from "./fixtures.ts";

let dir: string;
let client: HealthClient;

beforeAll(() => {
  ({ dir } = seedTempDb("baymax-", { days: 8, now: NOW }));
  client = new HealthClient({ dbPath: join(dir, "test.db") });
});

afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("HealthClient", () => {
  test("throws a helpful error when the database doesn't exist", () => {
    expect(() => new HealthClient({ dbPath: join(dir, "nope.db") })).toThrow(/bun run seed/);
  });

  test("status reports totals, per-source counts, and no unregistered types", () => {
    const s = client.status();
    expect(s.samples).toBeGreaterThan(1000);
    expect(s.workouts).toBeGreaterThan(0);
    expect(s.perSource).toHaveLength(4);
    expect(s.unregisteredTypes).toHaveLength(0);
    expect(s.dbSizeBytes!).toBeGreaterThan(0);
    expect(s.latestSample).not.toBeNull();
  });

  test("sources include per-source types for inspection", () => {
    const strava = client.sources().find((s) => s.source === STRAVA.bundleId)!;
    expect(strava.workouts).toBeGreaterThan(0);
    expect(strava.types).toContain("HKQuantityTypeIdentifierDistanceCycling");
  });

  test("metrics merge the registry with live counts", () => {
    const metrics = client.metrics();
    const hr = metrics.find((m) => m.name === "heart_rate")!;
    expect(hr.count).toBeGreaterThan(0);
    expect(hr.earliest).not.toBeNull();
    const unused = metrics.find((m) => m.name === "oxygen_saturation")!;
    expect(unused.count).toBe(0); // registered but no data — visible either way
  });

  test("samples decode category values and carry source + device", () => {
    const rows = client.samples({ metric: "sleep", days: 3, now: NOW });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.valueLabel === "asleepDeep")).toBe(true);
    expect(rows.every((r) => r.source.length > 0)).toBe(true);
    const es = rows.find((r) => r.source === EIGHT_SLEEP.bundleId);
    expect(es?.device).toBe("Eight Sleep Pod");
  });

  test("workouts decode activity names", () => {
    const rides = client.workouts({ days: 8, now: NOW }).filter((w) => w.activity === "cycling");
    expect(rides.length).toBeGreaterThan(0);
    expect(rides[0]!.source).toBe(STRAVA.bundleId);
    expect(rides[0]!.distanceKm!).toBeGreaterThan(10);
    expect(rides[0]!.metadata!.strava_activity).toContain("strava.com");
  });

  test("sleep and trend are exposed with defaults", () => {
    expect(client.sleep({ days: 3, now: NOW }).length).toBeGreaterThan(0);
    const t = client.trend({ metric: "heart_rate_variability", days: 7, now: NOW });
    expect(t.aggregation).toBe("avg");
    expect(t.buckets.some((b) => b.value !== null)).toBe(true);
  });

  test("overview bundles sleep, workouts, weight, and steps in one call", () => {
    const o = client.overview({ now: NOW });
    expect(o.latestData).not.toBeNull();
    expect(o.sleep.avgAsleepMinutes!).toBeGreaterThan(300);
    expect(o.sleep.nights.length).toBeGreaterThan(0);
    expect(o.workouts.length).toBeGreaterThan(0);
    expect(o.weight!.lb).toBeGreaterThan(150);
    expect(o.steps.dailyAvg!).toBeGreaterThan(1000);
  });

  test("unknown metric names get a helpful error", () => {
    expect(() => client.trend({ metric: "chakra_alignment" })).toThrow(/Available:/);
  });

  test("sql runs SELECT and rejects everything else", () => {
    const res = client.sql("SELECT type, count(*) as n FROM samples GROUP BY type ORDER BY n DESC LIMIT 3");
    expect(res.columns).toEqual(["type", "n"]);
    expect(res.rows.length).toBe(3);
    expect(() => client.sql("DELETE FROM samples")).toThrow(/Read-only/);
    expect(() => client.sql("PRAGMA journal_mode=DELETE")).toThrow(/Read-only/);
  });

  test("the connection itself is read-only even for sneaky CTEs", () => {
    expect(() => client.sql("WITH x AS (SELECT 1) INSERT INTO sources (bundle_id) VALUES ('evil')")).toThrow();
  });
});
