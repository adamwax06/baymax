import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ingestSamples, ingestWorkouts, listWorkouts, type BaymaxDb } from "../src/index.ts";
import { generateFixtures, WATCH, dayStartTs, freshDb, NOW } from "./fixtures.ts";

const count = (db: BaymaxDb, table: string) =>
  (db.all<{ n: number }>(sql.raw(`select count(*) as n from ${table}`))[0] as { n: number }).n;

describe("ingest", () => {
  test("upsert is idempotent — re-ingesting the same batch changes nothing", () => {
    const db = freshDb();
    const fx = generateFixtures({ days: 3, now: NOW });
    ingestSamples(db, { samples: fx.samples });
    ingestWorkouts(db, { workouts: fx.workouts });
    const sampleCount = count(db, "samples");
    const workoutCount = count(db, "workouts");
    expect(sampleCount).toBe(fx.samples.length);
    expect(workoutCount).toBe(fx.workouts.length);

    ingestSamples(db, { samples: fx.samples });
    ingestWorkouts(db, { workouts: fx.workouts });
    expect(count(db, "samples")).toBe(sampleCount);
    expect(count(db, "workouts")).toBe(workoutCount);
  });

  test("deleted uuids are removed", () => {
    const db = freshDb();
    const fx = generateFixtures({ days: 2, now: NOW });
    ingestSamples(db, { samples: fx.samples });
    const victim = fx.samples[0]!.uuid;
    const res = ingestSamples(db, { samples: [], deleted: [victim, "never-existed"] });
    expect(res.deleted).toBe(1);
    expect(count(db, "samples")).toBe(fx.samples.length - 1);
  });

  test("sources and devices are deduplicated", () => {
    const db = freshDb();
    const fx = generateFixtures({ days: 3, now: NOW });
    ingestSamples(db, { samples: fx.samples });
    ingestWorkouts(db, { workouts: fx.workouts });
    expect(count(db, "sources")).toBe(4); // watch, iphone, strava, eight sleep
    expect(count(db, "devices")).toBe(3); // watch, iphone, pod (strava has none)
  });

  test("metadata round-trips and unknown workout activity types fall back", () => {
    const db = freshDb();
    ingestWorkouts(db, {
      workouts: [
        {
          uuid: "wk-1",
          activityTypeRaw: 9999,
          start: NOW - 3_600_000,
          end: NOW,
          duration: 3600,
          source: WATCH,
          metadata: { HKIndoorWorkout: true, note: "mystery sport" },
        },
      ],
    });
    const [w] = listWorkouts(db, { days: 1, now: NOW });
    expect(w!.activity).toBe("unknown_9999");
    expect(w!.metadata).toEqual({ HKIndoorWorkout: true, note: "mystery sport" });
  });

  test("upsert updates fields on conflict", () => {
    const db = freshDb();
    const base = {
      uuid: "s-1",
      type: "HKQuantityTypeIdentifierBodyMass",
      unit: "kg",
      start: dayStartTs(NOW, 0),
      end: dayStartTs(NOW, 0),
      source: WATCH,
    };
    ingestSamples(db, { samples: [{ ...base, value: 80 }] });
    ingestSamples(db, { samples: [{ ...base, value: 81.5 }] });
    const rows = db.all<{ value: number }>(sql.raw("select value from samples where hk_uuid = 's-1'"));
    expect(rows[0]!.value).toBe(81.5);
    expect(count(db, "samples")).toBe(1);
  });
});
