#!/usr/bin/env bun
// Imports data/weights.json (see docs/weights.md) into the health database.
// The JSON is the source of truth: rows previously imported but no longer in
// the file are removed, so edits and deletions sync on re-import.
// Usage: bun scripts/import-weights.ts [path/to/weights.json]
import { z } from "zod";
import {
  defaultDbPath,
  ingestSamples,
  ingestWorkouts,
  migrateDb,
  openDb,
  type SamplePayload,
  type WorkoutPayload,
} from "@baymax/core";

const dateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");
const setZ = z.object({
  lb: z.number().positive().optional(),
  perSide: z.boolean().optional(),
  bodyweight: z.boolean().optional(),
  reps: z.array(z.number().positive()).min(1),
});
const exerciseZ = z.object({
  name: z.string().min(1),
  sets: z.array(setZ),
  notes: z.string().optional(),
});
const sessionZ = z.object({
  date: dateZ,
  type: z.string().optional(),
  gym: z.string().optional(),
  exercises: z.array(exerciseZ).min(1),
  notes: z.string().optional(),
});
const fileZ = z.object({
  bodyWeight: z.array(z.object({ date: dateZ, lb: z.number().min(80).max(500) })),
  sessions: z.array(sessionZ),
});

const SOURCE = { bundleId: "weights-json", name: "Weights Log" };
const STRENGTH_TRAINING = 50; // HKWorkoutActivityType.traditionalStrengthTraining
const LB_TO_KG = 0.45359237;

const localTs = (date: string, hour: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!, hour).getTime();
};

const path = Bun.argv[2] ?? "data/weights.json";
const file = Bun.file(path);
if (!(await file.exists())) {
  console.error(`No weights file at ${path} (see docs/weights.md)`);
  process.exit(1);
}
const parsed = fileZ.safeParse(await file.json());
if (!parsed.success) {
  console.error(`${path} failed validation:`);
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
const { bodyWeight, sessions } = parsed.data;

const samples: SamplePayload[] = bodyWeight.map((b) => ({
  uuid: `weights-bw-${b.date}`,
  type: "HKQuantityTypeIdentifierBodyMass",
  value: Math.round(b.lb * LB_TO_KG * 100) / 100,
  unit: "kg",
  start: localTs(b.date, 12),
  end: localTs(b.date, 12),
  source: SOURCE,
  metadata: { lb: b.lb },
}));

const perDate = new Map<string, number>();
const workouts: WorkoutPayload[] = sessions.map((s) => {
  const n = (perDate.get(s.date) ?? 0) + 1;
  perDate.set(s.date, n);
  const start = localTs(s.date, 17) + (n - 1) * 3_600_000;
  return {
    uuid: n === 1 ? `weights-${s.date}` : `weights-${s.date}-${n}`,
    activityTypeRaw: STRENGTH_TRAINING,
    start,
    end: start + 3_600_000, // duration unknown; documented 60-minute convention
    duration: 3600,
    source: SOURCE,
    metadata: {
      ...(s.type && { type: s.type }),
      ...(s.gym && { gym: s.gym }),
      ...(s.notes && { notes: s.notes }),
      exercises: s.exercises,
    },
  };
});

const db = openDb();
migrateDb(db);

// Source-of-truth sync: anything we imported before that is gone from the file gets deleted.
const current = (table: string) =>
  (db.$client.query(`SELECT hk_uuid FROM ${table} WHERE hk_uuid LIKE 'weights-%'`).values() as string[][]).map((r) => r[0]!);
const keepSamples = new Set(samples.map((s) => s.uuid));
const keepWorkouts = new Set(workouts.map((w) => w.uuid));
const staleSamples = current("samples").filter((u) => !keepSamples.has(u));
const staleWorkouts = current("workouts").filter((u) => !keepWorkouts.has(u));

const sr = ingestSamples(db, { samples, deleted: staleSamples });
const wr = ingestWorkouts(db, { workouts, deleted: staleWorkouts });
db.$client.close();

const setCount = sessions.reduce((n, s) => n + s.exercises.reduce((m, e) => m + e.sets.reduce((k, g) => k + g.reps.length, 0), 0), 0);
console.log(`Imported ${path} → ${defaultDbPath()}`);
console.log(`  sessions: ${wr.upserted} (${setCount} sets)  body weight: ${sr.upserted}`);
if (sr.deleted || wr.deleted) console.log(`  removed (no longer in file): ${wr.deleted} sessions, ${sr.deleted} body weight`);
console.log(`Check: bun run health workouts --days 30`);
