import { Hono } from "hono";
import { ingestSamples, ingestWorkouts, metricByHkType, type BaymaxDb } from "@baymax/core";
import { sampleBatchZ, workoutBatchZ } from "./payloads.ts";

export function createApp(db: BaymaxDb): Hono {
  const app = new Hono();

  app.get("/v1/ping", (c) => c.json({ ok: true, service: "baymax" }));

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
