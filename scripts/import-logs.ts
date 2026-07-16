#!/usr/bin/env bun
// Imports the gym log (data/weights.json) into the health database — see
// docs/weights.md. The file is the source of truth: sessions previously
// imported but no longer present are removed, so edits and deletions sync
// on re-import. (Weigh-ins live in Apple Health and arrive via phone sync.)
// Usage: bun scripts/import-logs.ts [weights.json]
import { z } from "zod";
import { defaultDbPath, ingestWorkouts, migrateDb, openDb, type WorkoutPayload } from "@baymax/core";

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
const weightsZ = z.object({ sessions: z.array(sessionZ) });

const SOURCE = { bundleId: "weights-json", name: "Weights Log" };
const STRENGTH_TRAINING = 50; // HKWorkoutActivityType.traditionalStrengthTraining

const localTs = (date: string, hour: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!, hour).getTime();
};

const path = Bun.argv[2] ?? "data/weights.json";
const file = Bun.file(path);
if (!(await file.exists())) {
  console.error(`No file at ${path} (see docs/weights.md)`);
  process.exit(1);
}
const parsed = weightsZ.safeParse(await file.json());
if (!parsed.success) {
  console.error(`${path} failed validation:`);
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
const { sessions } = parsed.data;

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

// Source-of-truth sync: sessions imported before but gone from the file get deleted.
const current = (db.$client.query(`SELECT hk_uuid FROM workouts WHERE hk_uuid LIKE 'weights-%'`).values() as string[][]).map(
  (r) => r[0]!,
);
const keep = new Set(workouts.map((w) => w.uuid));
const wr = ingestWorkouts(db, { workouts, deleted: current.filter((u) => !keep.has(u)) });
db.$client.close();

const setCount = sessions.reduce((n, s) => n + s.exercises.reduce((m, e) => m + e.sets.reduce((k, g) => k + g.reps.length, 0), 0), 0);
console.log(`Imported ${path} → ${defaultDbPath()}`);
console.log(`  sessions: ${wr.upserted} (${setCount} sets)${wr.deleted ? `  removed: ${wr.deleted}` : ""}`);
console.log(`Check: bun run health workouts --days 30`);
