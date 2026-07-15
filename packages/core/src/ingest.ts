import { eq, inArray, sql } from "drizzle-orm";
import type { BaymaxDb } from "./db.ts";
import { devices, samples, sources, workouts } from "./schema.ts";
import type { DevicePayload, SamplePayload, SourcePayload, WorkoutPayload } from "./types.ts";

export interface IngestResult {
  upserted: number;
  deleted: number;
}

type Tx = Parameters<Parameters<BaymaxDb["transaction"]>[0]>[0];

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
  for (let i = 0; i < uuids.length; i += 500) {
    tx.delete(table).where(inArray(table.hkUuid, uuids.slice(i, i + 500))).run();
    deleted += (tx.all(sql`select changes() as c`) as { c: number }[])[0]!.c;
  }
  return deleted;
}

export function ingestSamples(db: BaymaxDb, batch: { samples: SamplePayload[]; deleted?: string[] }): IngestResult {
  return db.transaction((tx) => {
    const sourceCache = new Map<string, number>();
    const deviceCache = new Map<string, number>();
    for (const s of batch.samples) {
      const row = {
        type: s.type,
        value: s.value ?? null,
        unit: s.unit ?? null,
        startTs: s.start,
        endTs: s.end,
        sourceId: getOrCreateSource(tx, sourceCache, s.source),
        deviceId: getOrCreateDevice(tx, deviceCache, s.device),
        metadata: metadataJson(s.metadata),
      };
      tx.insert(samples)
        .values({ hkUuid: s.uuid, ...row })
        .onConflictDoUpdate({ target: samples.hkUuid, set: row })
        .run();
    }
    return { upserted: batch.samples.length, deleted: chunkedDelete(tx, samples, batch.deleted ?? []) };
  });
}

export function ingestWorkouts(db: BaymaxDb, batch: { workouts: WorkoutPayload[]; deleted?: string[] }): IngestResult {
  return db.transaction((tx) => {
    const sourceCache = new Map<string, number>();
    const deviceCache = new Map<string, number>();
    for (const w of batch.workouts) {
      const row = {
        activityTypeRaw: w.activityTypeRaw,
        startTs: w.start,
        endTs: w.end,
        durationS: w.duration,
        distanceM: w.distanceMeters ?? null,
        activeEnergyKcal: w.activeEnergyKcal ?? null,
        sourceId: getOrCreateSource(tx, sourceCache, w.source),
        deviceId: getOrCreateDevice(tx, deviceCache, w.device),
        metadata: metadataJson(w.metadata),
      };
      tx.insert(workouts)
        .values({ hkUuid: w.uuid, ...row })
        .onConflictDoUpdate({ target: workouts.hkUuid, set: row })
        .run();
    }
    return { upserted: batch.workouts.length, deleted: chunkedDelete(tx, workouts, batch.deleted ?? []) };
  });
}
