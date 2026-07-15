import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePayload, SamplePayload, SourcePayload, WorkoutPayload } from "../src/types.ts";
import { DAY_MS } from "../src/time.ts";
import { ingestSamples, ingestWorkouts, migrateDb, openDb, type BaymaxDb } from "../src/index.ts";

/**
 * Deterministic fixture generator emulating the three real-world sources.
 * Emits ingest-payload-shaped data so the same generator drives unit tests,
 * server e2e tests, and scripts/seed.ts. Bundle ids confirmed against the
 * first real sync (July 2026): com.eightsleep.Eight, com.strava.stravaride;
 * Apple sources follow the real com.apple.health.<UUID> pattern.
 */

export const WATCH: SourcePayload = {
  bundleId: "com.apple.health.8A2C3D4E-5F60-4718-9A2B-3C4D5E6F7081",
  name: "Adam's Apple Watch",
};
export const IPHONE: SourcePayload = { bundleId: "com.apple.health", name: "iPhone" };
export const STRAVA: SourcePayload = { bundleId: "com.strava.stravaride", name: "Strava" };
export const EIGHT_SLEEP: SourcePayload = { bundleId: "com.eightsleep.Eight", name: "Eight Sleep" };

const WATCH_DEVICE: DevicePayload = {
  name: "Apple Watch",
  manufacturer: "Apple Inc.",
  model: "Watch",
  hardwareVersion: "Watch6,10",
  softwareVersion: "26.3",
};
const IPHONE_DEVICE: DevicePayload = {
  name: "iPhone",
  manufacturer: "Apple Inc.",
  model: "iPhone",
  hardwareVersion: "iPhone17,3",
  softwareVersion: "26.3",
};
const POD_DEVICE: DevicePayload = { name: "Eight Sleep Pod", manufacturer: "Eight Sleep", model: "Pod 4" };

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local midnight of the day `i` days before `now`. */
export function dayStartTs(now: number, i: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - i);
  return d.getTime();
}

const at = (dayTs: number, h: number, m = 0) => dayTs + h * 3_600_000 + m * 60_000;

export interface Fixtures {
  samples: SamplePayload[];
  workouts: WorkoutPayload[];
}

/** Fixed "now" shared by the deterministic unit tests. */
export const NOW = new Date(2026, 5, 20, 12, 0, 0).getTime();

/** Fresh migrated in-memory DB. */
export function freshDb(): BaymaxDb {
  const db = openDb({ path: ":memory:" });
  migrateDb(db);
  return db;
}

/** In-memory DB seeded with `days` of fixtures relative to NOW. */
export function seededDb(days: number, opts: { workouts?: boolean } = {}): BaymaxDb {
  const db = freshDb();
  const fx = generateFixtures({ days, now: NOW });
  ingestSamples(db, { samples: fx.samples });
  if (opts.workouts) ingestWorkouts(db, { workouts: fx.workouts });
  return db;
}

/** Seeded temp-file DB for tests that need a real path (CLI spawn, readonly HealthClient, MCP). */
export function seedTempDb(prefix: string, opts: { days?: number; now?: number } = {}): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, "test.db");
  const db = openDb({ path: dbPath });
  migrateDb(db);
  const fx = generateFixtures({ days: opts.days ?? 5, now: opts.now ?? Date.now() });
  ingestSamples(db, { samples: fx.samples });
  ingestWorkouts(db, { workouts: fx.workouts });
  db.$client.close();
  return { dir, dbPath };
}

export function generateFixtures(opts: { days: number; now: number; seed?: number }): Fixtures {
  const rng = mulberry32(opts.seed ?? 42);
  const samples: SamplePayload[] = [];
  const workouts: WorkoutPayload[] = [];

  const quantity = (
    uuid: string,
    type: string,
    value: number,
    unit: string,
    start: number,
    end: number,
    source: SourcePayload,
    device: DevicePayload | null,
    metadata?: Record<string, unknown>,
  ) => samples.push({ uuid, type, value, unit, start: Math.round(start), end: Math.round(end), source, device, metadata: metadata ?? null });

  const sleepSegment = (uuid: string, value: number, start: number, end: number, source: SourcePayload, device: DevicePayload | null) =>
    samples.push({ uuid, type: "HKCategoryTypeIdentifierSleepAnalysis", value, unit: null, start: Math.round(start), end: Math.round(end), source, device });

  for (let i = 0; i < opts.days; i++) {
    const day = dayStartTs(opts.now, i);

    // Watch heart rate every 15 minutes
    for (let j = 0; j < 96; j++) {
      const t = day + j * 15 * 60_000;
      quantity(`hr-w-${i}-${j}`, "HKQuantityTypeIdentifierHeartRate", 55 + rng() * 40, "count/min", t, t, WATCH, WATCH_DEVICE);
    }
    // Steps from both Watch and iPhone (overlapping — exercises dominant-source dedup)
    for (let h = 8; h < 22; h++) {
      quantity(`steps-w-${i}-${h}`, "HKQuantityTypeIdentifierStepCount", Math.floor(300 + rng() * 600), "count", at(day, h), at(day, h + 1), WATCH, WATCH_DEVICE);
      quantity(`steps-p-${i}-${h}`, "HKQuantityTypeIdentifierStepCount", Math.floor(200 + rng() * 400), "count", at(day, h, 5), at(day, h, 55), IPHONE, IPHONE_DEVICE);
      quantity(`energy-w-${i}-${h}`, "HKQuantityTypeIdentifierActiveEnergyBurned", 15 + rng() * 35, "kcal", at(day, h), at(day, h + 1), WATCH, WATCH_DEVICE);
    }
    quantity(`hrv-w-${i}`, "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", 35 + rng() * 50, "ms", at(day, 3), at(day, 3), WATCH, WATCH_DEVICE);
    quantity(`rhr-w-${i}`, "HKQuantityTypeIdentifierRestingHeartRate", 50 + rng() * 10, "count/min", at(day, 6), at(day, 6), WATCH, WATCH_DEVICE);
    quantity(`rr-es-${i}`, "HKQuantityTypeIdentifierRespiratoryRate", 13 + rng() * 3, "count/min", at(day, 3, 30), at(day, 3, 30), EIGHT_SLEEP, POD_DEVICE);
    if (i % 3 === 0) {
      quantity(`mass-p-${i}`, "HKQuantityTypeIdentifierBodyMass", 82 - i * 0.01 + rng() * 0.6, "kg", at(day, 7, 30), at(day, 7, 30), IPHONE, IPHONE_DEVICE);
    }
    if (i % 7 === 0) {
      quantity(`vo2-w-${i}`, "HKQuantityTypeIdentifierVO2Max", 42 + rng() * 2, "mL/min·kg", at(day, 12), at(day, 12), WATCH, WATCH_DEVICE);
    }

    // Night starting on this day at ~23:00, ending ~07:00 the next day.
    // Skipped for i=0 (tonight hasn't happened yet).
    if (i > 0) {
      const wake = at(day, 7) + DAY_MS; // 07:00 next day
      const stageCycle: [number, number][] = [[3, 50], [4, 20], [3, 30], [5, 25], [2, 4]]; // core/deep/core/rem/awake
      // Watch: stages only, no inBed
      let t = at(day, 23, Math.floor(rng() * 30));
      for (let j = 0; t < wake; j++) {
        const [value, minutes] = stageCycle[j % stageCycle.length]!;
        const end = Math.min(t + (minutes + rng() * 10) * 60_000, wake);
        sleepSegment(`sleep-w-${i}-${j}`, value, t, end, WATCH, WATCH_DEVICE);
        t = end;
      }
      // Eight Sleep: one inBed span plus its own stages, slightly offset
      const bed = at(day, 22, 40 + Math.floor(rng() * 15));
      const esWake = wake + 12 * 60_000;
      sleepSegment(`sleep-es-${i}-inbed`, 0, bed, esWake, EIGHT_SLEEP, POD_DEVICE);
      t = bed + 15 * 60_000;
      for (let j = 0; t < esWake - 10 * 60_000; j++) {
        const [value, minutes] = stageCycle[j % stageCycle.length]!;
        const end = Math.min(t + (minutes + rng() * 8) * 60_000, esWake - 10 * 60_000);
        sleepSegment(`sleep-es-${i}-${j}`, value, t, end, EIGHT_SLEEP, POD_DEVICE);
        t = end;
      }
    }

    // Workouts: Watch runs 3x/week, Strava rides 2x/week
    if (i % 7 === 1 || i % 7 === 3 || i % 7 === 5) {
      const durationS = (30 + rng() * 10) * 60;
      workouts.push({
        uuid: `run-w-${i}`,
        activityTypeRaw: 37,
        start: at(day, 18),
        end: Math.round(at(day, 18) + durationS * 1000),
        duration: durationS,
        distanceMeters: 5000 + rng() * 1500,
        activeEnergyKcal: 300 + rng() * 80,
        source: WATCH,
        device: WATCH_DEVICE,
        metadata: { HKIndoorWorkout: false, HKAverageMETs: "9.8 kcal/hr·kg" },
      });
    }
    if (i % 7 === 2 || i % 7 === 6) {
      const durationS = (45 + rng() * 20) * 60;
      const distance = 20_000 + rng() * 8000;
      workouts.push({
        uuid: `ride-s-${i}`,
        activityTypeRaw: 13,
        start: at(day, 17),
        end: Math.round(at(day, 17) + durationS * 1000),
        duration: durationS,
        distanceMeters: distance,
        activeEnergyKcal: 400 + rng() * 150,
        source: STRAVA,
        device: null,
        metadata: { strava_activity: `https://www.strava.com/activities/${1_000_000 + i}` },
      });
      quantity(`dist-s-${i}`, "HKQuantityTypeIdentifierDistanceCycling", distance, "m", at(day, 17), at(day, 17) + durationS * 1000, STRAVA, null);
    }
  }

  return { samples, workouts };
}
