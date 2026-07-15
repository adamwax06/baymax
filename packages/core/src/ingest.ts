import { eq, inArray, sql } from "drizzle-orm";
import type { BaymaxDb } from "./db.ts";
import { devices, samples, sources, workouts } from "./schema.ts";
import type { DevicePayload, SamplePayload, SourcePayload, WorkoutPayload } from "./types.ts";

export interface IngestResult {
  upserted: number;
  deleted: number;
}

type Tx = Parameters<Parameters<BaymaxDb["transaction"]>[0]>[0];

// Multi-row upsert chunks: bounded well under SQLite's parameter limit
// (10 cols x 500 rows = 5000 params).
const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function getOrCreateSource(tx: Tx, cache: Map<string, number>, source: SourcePayload): number {
  const cached = cache.get(source.bundleId);
  if (cached !== undefined) return cached;
  const existing = tx.select({ id: sources.id }).from(sources).where(eq(sources.bundleId, source.bundleId)).get();
  const id =
    existing?.id ??
    tx
      .insert(sources)
      .values({ bundleId: source.bundleId, name: source.name ?? null })
      .returning({ id: sources.id })
      .get().id;
  cache.set(source.bundleId, id);
  return id;
}

function getOrCreateDevice(tx: Tx, cache: Map<string, number>, device: DevicePayload | null | undefined): number | null {
  if (!device) return null;
  const fields = {
    name: device.name ?? null,
    manufacturer: device.manufacturer ?? null,
    model: device.model ?? null,
    hardwareVersion: device.hardwareVersion ?? null,
    softwareVersion: device.softwareVersion ?? null,
  };
  const key = JSON.stringify(Object.values(fields));
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = tx.select({ id: devices.id }).from(devices).where(eq(devices.deviceKey, key)).get();
  const id = existing?.id ?? tx.insert(devices).values({ deviceKey: key, ...fields }).returning({ id: devices.id }).get().id;
  cache.set(key, id);
  return id;
}

function metadataJson(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

function chunkedDelete(tx: Tx, table: typeof samples | typeof workouts, uuids: string[]): number {
  let deleted = 0;
  for (const chunk of chunks(uuids)) {
    deleted += tx.delete(table).where(inArray(table.hkUuid, chunk)).returning({ uuid: table.hkUuid }).all().length;
  }
  return deleted;
}

export function ingestSamples(db: BaymaxDb, batch: { samples: SamplePayload[]; deleted?: string[] }): IngestResult {
  return db.transaction((tx) => {
    const sourceCache = new Map<string, number>();
    const deviceCache = new Map<string, number>();
    const rows = batch.samples.map((s) => ({
      hkUuid: s.uuid,
      type: s.type,
      value: s.value ?? null,
      unit: s.unit ?? null,
      startTs: s.start,
      endTs: s.end,
      sourceId: getOrCreateSource(tx, sourceCache, s.source),
      deviceId: getOrCreateDevice(tx, deviceCache, s.device),
      metadata: metadataJson(s.metadata),
    }));
    for (const chunk of chunks(rows)) {
      tx.insert(samples)
        .values(chunk)
        .onConflictDoUpdate({
          target: samples.hkUuid,
          set: {
            type: sql`excluded.type`,
            value: sql`excluded.value`,
            unit: sql`excluded.unit`,
            startTs: sql`excluded.start_ts`,
            endTs: sql`excluded.end_ts`,
            sourceId: sql`excluded.source_id`,
            deviceId: sql`excluded.device_id`,
            metadata: sql`excluded.metadata`,
          },
        })
        .run();
    }
    return { upserted: rows.length, deleted: chunkedDelete(tx, samples, batch.deleted ?? []) };
  });
}

export function ingestWorkouts(db: BaymaxDb, batch: { workouts: WorkoutPayload[]; deleted?: string[] }): IngestResult {
  return db.transaction((tx) => {
    const sourceCache = new Map<string, number>();
    const deviceCache = new Map<string, number>();
    const rows = batch.workouts.map((w) => ({
      hkUuid: w.uuid,
      activityTypeRaw: w.activityTypeRaw,
      startTs: w.start,
      endTs: w.end,
      durationS: w.duration,
      distanceM: w.distanceMeters ?? null,
      activeEnergyKcal: w.activeEnergyKcal ?? null,
      sourceId: getOrCreateSource(tx, sourceCache, w.source),
      deviceId: getOrCreateDevice(tx, deviceCache, w.device),
      metadata: metadataJson(w.metadata),
    }));
    for (const chunk of chunks(rows)) {
      tx.insert(workouts)
        .values(chunk)
        .onConflictDoUpdate({
          target: workouts.hkUuid,
          set: {
            activityTypeRaw: sql`excluded.activity_type_raw`,
            startTs: sql`excluded.start_ts`,
            endTs: sql`excluded.end_ts`,
            durationS: sql`excluded.duration_s`,
            distanceM: sql`excluded.distance_m`,
            activeEnergyKcal: sql`excluded.active_energy_kcal`,
            sourceId: sql`excluded.source_id`,
            deviceId: sql`excluded.device_id`,
            metadata: sql`excluded.metadata`,
          },
        })
        .run();
    }
    return { upserted: rows.length, deleted: chunkedDelete(tx, workouts, batch.deleted ?? []) };
  });
}
