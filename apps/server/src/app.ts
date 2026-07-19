import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { defaultDbPath, ingestSamples, ingestWorkouts, metricByHkType, sampleBatchZ, workoutBatchZ, type BaymaxDb } from "@baymax/core";

export function createApp(db: BaymaxDb): Hono {
  const app = new Hono();

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
