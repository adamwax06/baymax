import { describe, expect, test } from "bun:test";
import { ingestSamples, trend, metricByName, localDateStr } from "../src/index.ts";
import { round1 } from "../src/time.ts";
import { generateFixtures, dayStartTs, WATCH, IPHONE, freshDb, seededDb, NOW } from "./fixtures.ts";

const m = (name: string) => metricByName(name)!;

describe("trend", () => {
  test("sum metrics use the dominant source and report excluded sources", () => {
    const db = seededDb(8);
    const t = trend(db, m("steps"), { days: 7, now: NOW });
    expect(t.source).toBe(WATCH.bundleId); // watch fixture steps > iphone's
    expect(t.excludedSources).toHaveLength(1);
    expect(t.excludedSources![0]!.source).toBe(IPHONE.bundleId);
    expect(t.excludedSources![0]!.total).toBeGreaterThan(0);
    expect(t.buckets).toHaveLength(8); // both boundary days inclusive

    // a full day's value equals the sum of that day's watch samples only
    const fx = generateFixtures({ days: 8, now: NOW });
    const date = localDateStr(dayStartTs(NOW, 2));
    const expected = fx.samples
      .filter((s) => s.type === "HKQuantityTypeIdentifierStepCount" && s.source === WATCH && localDateStr(s.start) === date)
      .reduce((sum, s) => sum + s.value!, 0);
    expect(t.buckets.find((b) => b.date === date)!.value).toBe(round1(expected));
  });

  test("avg metrics include min/max/count per bucket", () => {
    const t = trend(seededDb(8), m("heart_rate"), { days: 5, now: NOW });
    const full = t.buckets.find((b) => b.date === localDateStr(dayStartTs(NOW, 2)))!;
    expect(full.count).toBe(96);
    expect(full.min!).toBeLessThanOrEqual(full.value!);
    expect(full.max!).toBeGreaterThanOrEqual(full.value!);
  });

  test("latest metrics pick the last value per day and gap-fill with null", () => {
    const t = trend(seededDb(8), m("body_mass"), { days: 7, now: NOW });
    const withValue = t.buckets.filter((b) => b.value !== null);
    const without = t.buckets.filter((b) => b.value === null);
    expect(withValue.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0); // fixtures weigh in every 3rd day
  });

  test("days outside the data range are null-filled", () => {
    const db = seededDb(2); // only 2 days of data
    const t = trend(db, m("heart_rate"), { days: 7, now: NOW });
    expect(t.buckets).toHaveLength(8);
    expect(t.buckets.filter((b) => b.value === null).length).toBeGreaterThanOrEqual(5);
  });

  test("a 23:30 local sample lands on its local date bucket", () => {
    const db = freshDb();
    const day = dayStartTs(NOW, 1);
    const ts = day + 23.5 * 3_600_000;
    ingestSamples(db, {
      samples: [{ uuid: "late", type: "HKQuantityTypeIdentifierStepCount", value: 100, unit: "count", start: ts, end: ts, source: WATCH }],
    });
    const t = trend(db, m("steps"), { days: 3, now: NOW });
    expect(t.buckets.find((b) => b.date === localDateStr(day))!.value).toBe(100);
  });

  test("category sum metrics count events per day", () => {
    const db = freshDb();
    const day = dayStartTs(NOW, 1);
    ingestSamples(db, {
      samples: [0, 1].map((j) => ({
        uuid: `hhr-${j}`,
        type: "HKCategoryTypeIdentifierHighHeartRateEvent",
        value: 0,
        start: day + (10 + j) * 3_600_000,
        end: day + (10 + j) * 3_600_000,
        source: WATCH,
      })),
    });
    const t = trend(db, m("high_heart_rate_events"), { days: 3, now: NOW });
    expect(t.buckets.find((b) => b.date === localDateStr(day))!.value).toBe(2);
  });

  test("sleep trend buckets nights of the primary source and attaches all nights", () => {
    const t = trend(seededDb(8), m("sleep"), { days: 5, now: NOW });
    expect(t.unit).toBe("min");
    expect(t.source).toBeDefined();
    expect(t.nights!.length).toBeGreaterThan(0);
    const withSleep = t.buckets.filter((b) => b.value !== null);
    expect(withSleep.length).toBe(5); // nights for the last 5 dates except today has none... fixtures generate nights for i>=1
    for (const b of withSleep) expect(b.value!).toBeGreaterThan(300); // plausible full nights, in minutes
  });

  test("no data at all still returns a full null-filled bucket range", () => {
    const db = freshDb();
    const t = trend(db, m("steps"), { days: 3, now: NOW });
    expect(t.buckets).toHaveLength(4);
    expect(t.buckets.every((b) => b.value === null)).toBe(true);
    expect(t.source).toBeUndefined();
  });
});
