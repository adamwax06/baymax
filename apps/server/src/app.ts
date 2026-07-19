import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { defaultDbPath, HealthClient, ingestSamples, ingestWorkouts, metricByHkType, sampleBatchZ, workoutBatchZ, type BaymaxDb } from "@baymax/core";

export function createApp(db: BaymaxDb): Hono {
  const app = new Hono();
  let health: HealthClient | undefined;

  app.get("/v1/ping", (c) => c.json({ ok: true, service: "baymax" }));

  // One-time migration aid: the app pulls these and writes them into
  // HealthKit, making Apple Health the source of truth for body weight.
  app.get("/v1/backfill/bodyweight", (c) => {
    const path = join(dirname(defaultDbPath()), "bodyweight.json");
    return c.json(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []);
  });

  // Plan-derived intake days (data/nutrition.json); the app mirrors these
  // into HealthKit as dietary samples so Apple Health shows cals/macros.
  app.get("/v1/nutrition", (c) => {
    const path = join(dirname(defaultDbPath()), "nutrition.json");
    return c.json(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []);
  });

  // Home-screen tiles: sleep, steps, weight, workouts (core SDK overview).
  app.get("/v1/overview", (c) => {
    return c.json((health ??= new HealthClient({ dbPath: defaultDbPath() })).overview());
  });

  // The app's Today card: calorie/protein targets + what's logged for today.
  app.get("/v1/today", (c) => {
    const path = join(dirname(defaultDbPath()), "nutrition.json");
    const today = new Date().toLocaleDateString("sv-SE");
    const logged = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { date: string }[]).find((e) => e.date === today) ?? null
      : null;
    let targetKcal: number | null = null;
    let proteinG: number | null = null;
    try {
      const n = (health ??= new HealthClient({ dbPath: defaultDbPath() })).nutrition();
      targetKcal = n.targetKcal;
      proteinG = n.proteinG;
    } catch {} // no goal configured — card just shows logged totals
    return c.json({ date: today, targetKcal, proteinG, logged });
  });

  // ---- in-app workout logging (Log tab) ----
  // weights.json stays the source of truth: POST appends a session there and
  // re-runs the importer, exactly like the hand-edited flow (docs/weights.md).
  const weightsPath = () => join(dirname(defaultDbPath()), "weights.json");
  const sessionZ = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.string().optional(),
    gym: z.string().optional(),
    notes: z.string().optional(),
    exercises: z
      .array(
        z.object({
          name: z.string().min(1),
          notes: z.string().optional(),
          sets: z
            .array(
              z.object({
                lb: z.number().positive().optional(),
                perSide: z.boolean().optional(),
                bodyweight: z.boolean().optional(),
                reps: z.array(z.number().positive()).min(1),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  });

  // Ghosting data for the Log tab: the last session per day type (prefill),
  // a suggested next type from the cycle, and all known exercise names.
  app.get("/v1/log/template", (c) => {
    const sessions = (JSON.parse(readFileSync(weightsPath(), "utf8")) as { sessions: any[] }).sessions;
    const lastByType: Record<string, unknown> = {};
    const names = new Set<string>();
    let lastType: string | undefined;
    for (const s of sessions) {
      if (s.type) {
        lastByType[s.type] = s;
        lastType = s.type;
      }
      for (const e of s.exercises) names.add(e.name);
    }
    const cycle: Record<string, string> = { legs: "push", push: "pull", pull: "legs" };
    return c.json({
      suggestedType: (lastType && cycle[lastType]) ?? "push",
      lastByType,
      exerciseNames: [...names].sort(),
    });
  });

  app.post("/v1/log/workout", async (c) => {
    const parsed = sessionZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const log = JSON.parse(readFileSync(weightsPath(), "utf8")) as { sessions: unknown[] };
    log.sessions.push(parsed.data);
    writeFileSync(weightsPath(), JSON.stringify(log, null, 2) + "\n");
    const repoRoot = dirname(dirname(weightsPath()));
    const imp = Bun.spawnSync(["bun", "scripts/import-logs.ts"], { cwd: repoRoot });
    if (imp.exitCode !== 0) {
      return c.json({ error: "saved to weights.json but import failed", detail: imp.stderr.toString().slice(0, 300) }, 500);
    }
    health = undefined; // reopen on next read so it sees the reimported rows
    return c.json({ ok: true, sessions: log.sessions.length });
  });

  app.post("/v1/ingest/samples", async (c) => {
    const parsed = sampleBatchZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    warnOnUnitMismatch(parsed.data.samples);
    const result = ingestSamples(db, parsed.data);
    return c.json({ accepted: result.upserted, deleted: result.deleted });
  });

  app.post("/v1/ingest/workouts", async (c) => {
    const parsed = workoutBatchZ.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const result = ingestWorkouts(db, parsed.data);
    return c.json({ accepted: result.upserted, deleted: result.deleted });
  });

  return app;
}

const warnedTypes = new Set<string>();

/** The registry unit and the HKUnit in SyncedTypes.swift must agree; warn once per type, never reject. */
function warnOnUnitMismatch(samples: { type: string; unit?: string | null }[]): void {
  for (const s of samples) {
    if (!s.unit || warnedTypes.has(s.type)) continue;
    const metric = metricByHkType(s.type);
    if (metric?.unit && metric.unit !== s.unit) {
      warnedTypes.add(s.type);
      console.warn(`[baymax] unit mismatch for ${s.type}: got "${s.unit}", registry says "${metric.unit}"`);
    }
  }
}
