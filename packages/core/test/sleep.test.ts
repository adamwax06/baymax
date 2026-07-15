import { describe, expect, test } from "bun:test";
import { openDb, migrateDb, ingestSamples, deriveSleepNights, localDateStr, type BaymaxDb } from "../src/index.ts";
import { generateFixtures, dayStartTs, WATCH, EIGHT_SLEEP } from "./fixtures.ts";

const NOW = new Date(2026, 5, 20, 12, 0, 0).getTime();
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";

function seededDb(days = 9): BaymaxDb {
  const db = openDb({ path: ":memory:" });
  migrateDb(db);
  ingestSamples(db, { samples: generateFixtures({ days, now: NOW }).samples });
  return db;
}

describe("deriveSleepNights", () => {
  test("one night per source per date, both sources reported, newest first", () => {
    const nights = deriveSleepNights(seededDb(), { days: 7, now: NOW });
    const watchNights = nights.filter((n) => n.source === WATCH.bundleId);
    const esNights = nights.filter((n) => n.source === EIGHT_SLEEP.bundleId);
    expect(watchNights.length).toBe(7);
    expect(esNights.length).toBe(7);
    expect(nights[0]!.night >= nights.at(-1)!.night).toBe(true);
    // fixture night i=1 starts on yesterday's local date
    expect(watchNights[0]!.night).toBe(localDateStr(dayStartTs(NOW, 1)));
  });

  test("post-midnight segments land on the night they belong to (noon-to-noon)", () => {
    const db = openDb({ path: ":memory:" });
    migrateDb(db);
    const day = dayStartTs(NOW, 3);
    ingestSamples(db, {
      samples: [
        { uuid: "a", type: SLEEP, value: 3, start: day + 23 * 3_600_000, end: day + 24 * 3_600_000, source: WATCH },
        { uuid: "b", type: SLEEP, value: 4, start: day + 25 * 3_600_000, end: day + 26 * 3_600_000, source: WATCH }, // 01:00-02:00 next day
      ],
    });
    const nights = deriveSleepNights(db, { days: 7, now: NOW });
    expect(nights.length).toBe(1);
    expect(nights[0]!.night).toBe(localDateStr(day));
    expect(nights[0]!.stages.core).toBe(60);
    expect(nights[0]!.stages.deep).toBe(60);
    expect(nights[0]!.asleepMinutes).toBe(120);
  });

  test("an afternoon nap counts toward that day's night window", () => {
    const db = openDb({ path: ":memory:" });
    migrateDb(db);
    const day = dayStartTs(NOW, 2);
    ingestSamples(db, {
      samples: [{ uuid: "nap", type: SLEEP, value: 1, start: day + 13 * 3_600_000, end: day + 14 * 3_600_000, source: WATCH }],
    });
    const nights = deriveSleepNights(db, { days: 7, now: NOW });
    expect(nights[0]!.night).toBe(localDateStr(day));
    expect(nights[0]!.stages.unspecified).toBe(60);
  });

  test("stage minutes sum to asleep minutes; efficiency only when inBed present", () => {
    const nights = deriveSleepNights(seededDb(), { days: 3, now: NOW });
    for (const n of nights) {
      const stageSum = n.stages.core + n.stages.deep + n.stages.rem + n.stages.unspecified;
      expect(Math.abs(stageSum - n.asleepMinutes)).toBeLessThan(0.5); // rounding tolerance
      expect(n.bedtime < n.waketime).toBe(true);
      if (n.source === EIGHT_SLEEP.bundleId) {
        expect(n.inBedMinutes).toBeGreaterThan(0);
        expect(n.efficiency).not.toBeNull();
        expect(n.efficiency!).toBeLessThanOrEqual(1);
      } else {
        expect(n.inBedMinutes).toBe(0);
        expect(n.efficiency).toBeNull();
      }
    }
  });

  test("source filter returns only that source's nights", () => {
    const nights = deriveSleepNights(seededDb(), { days: 7, source: EIGHT_SLEEP.bundleId, now: NOW });
    expect(nights.length).toBe(7);
    expect(nights.every((n) => n.source === EIGHT_SLEEP.bundleId)).toBe(true);
  });
});
