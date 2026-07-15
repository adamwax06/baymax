import { and, desc, eq, gte, sql } from "drizzle-orm";
import { existsSync, statSync } from "node:fs";
import type { BaymaxDb } from "./db.ts";
import { METRICS, type MetricDef, workoutActivityName } from "./registry.ts";
import { devices, samples, sources, workouts } from "./schema.ts";
import { DAY_MS, localDateRange, localDateTimeStr, round1 } from "./time.ts";
import { deriveSleepNights } from "./sleep.ts";
import type { MetricInfo, SampleRow, SourceSummary, StatusResult, TrendResult, WorkoutRow } from "./types.ts";

const localDay = sql<string>`date(${samples.startTs} / 1000, 'unixepoch', 'localtime')`;

export function trend(db: BaymaxDb, metric: MetricDef, opts: { days: number; now?: number }): TrendResult {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * DAY_MS;
  const dates = localDateRange(since, now);
  const result: TrendResult = {
    metric: metric.name,
    unit: metric.unit,
    aggregation: metric.aggregation,
    days: opts.days,
    buckets: [],
  };

  if (metric.aggregation === "sleep") {
    const nights = deriveSleepNights(db, { days: opts.days, now });
    const nightCounts = new Map<string, number>();
    for (const n of nights) nightCounts.set(n.source, (nightCounts.get(n.source) ?? 0) + 1);
    const primary = [...nightCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const byNight = new Map(nights.filter((n) => n.source === primary).map((n) => [n.night, n]));
    result.unit = "min";
    if (primary !== undefined) result.source = primary;
    result.buckets = dates.map((date) => ({
      date,
      value: byNight.get(date)?.asleepMinutes ?? null,
      count: byNight.has(date) ? 1 : 0,
    }));
    result.nights = nights;
    return result;
  }

  const inRange = and(eq(samples.type, metric.hkType), gte(samples.startTs, since));

  if (metric.aggregation === "sum" && metric.kind === "category") {
    // Rare events (e.g. high HR notifications): count per day across all sources.
    // TrendResult.unit is always the bucket-value unit ("count" here, "min" for sleep).
    result.unit = "count";
    const rows = db.select({ date: localDay, count: sql<number>`count(*)` }).from(samples).where(inRange).groupBy(localDay).all();
    const byDate = new Map(rows.map((r) => [r.date, r.count]));
    result.buckets = dates.map((date) => ({ date, value: byDate.get(date) ?? null, count: byDate.get(date) ?? 0 }));
    return result;
  }

  if (metric.aggregation === "sum") {
    // iPhone and Watch both record sum metrics like steps; aggregating only the
    // dominant source avoids double counting. Others are reported, not summed.
    const totals = db
      .select({ source: sources.bundleId, total: sql<number>`sum(${samples.value})` })
      .from(samples)
      .innerJoin(sources, eq(samples.sourceId, sources.id))
      .where(inRange)
      .groupBy(sources.bundleId)
      .orderBy(desc(sql`sum(${samples.value})`))
      .all();
    const dominant = totals[0]?.source;
    if (dominant === undefined) {
      result.buckets = dates.map((date) => ({ date, value: null, count: 0 }));
      return result;
    }
    result.source = dominant;
    if (totals.length > 1) result.excludedSources = totals.slice(1).map((t) => ({ source: t.source, total: round1(t.total) }));
    const rows = db
      .select({ date: localDay, value: sql<number>`sum(${samples.value})`, count: sql<number>`count(*)` })
      .from(samples)
      .innerJoin(sources, eq(samples.sourceId, sources.id))
      .where(and(inRange, eq(sources.bundleId, dominant)))
      .groupBy(localDay)
      .all();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    result.buckets = dates.map((date) => {
      const r = byDate.get(date);
      return { date, value: r ? round1(r.value) : null, count: r?.count ?? 0 };
    });
    return result;
  }

  if (metric.aggregation === "avg") {
    const rows = db
      .select({
        date: localDay,
        value: sql<number>`avg(${samples.value})`,
        min: sql<number>`min(${samples.value})`,
        max: sql<number>`max(${samples.value})`,
        count: sql<number>`count(*)`,
      })
      .from(samples)
      .where(inRange)
      .groupBy(localDay)
      .all();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    result.buckets = dates.map((date) => {
      const r = byDate.get(date);
      return r
        ? { date, value: round1(r.value), count: r.count, min: round1(r.min), max: round1(r.max) }
        : { date, value: null, count: 0 };
    });
    return result;
  }

  // latest: SQLite returns the bare column from the max(end_ts) row per group
  const rows = db.all<{ date: string; value: number | null }>(sql`
    select ${localDay} as date, ${samples.value} as value, max(${samples.endTs})
    from ${samples} where ${samples.type} = ${metric.hkType} and ${samples.startTs} >= ${since} group by date
  `);
  const byDate = new Map(rows.map((r) => [r.date, r.value]));
  result.buckets = dates.map((date) => {
    const value = byDate.get(date);
    return { date, value: value != null ? round1(value) : null, count: byDate.has(date) ? 1 : 0 };
  });
  return result;
}

export function rawSamples(
  db: BaymaxDb,
  metric: MetricDef,
  opts: { days: number; limit?: number; now?: number },
): SampleRow[] {
  const now = opts.now ?? Date.now();
  const rows = db
    .select({
      uuid: samples.hkUuid,
      type: samples.type,
      value: samples.value,
      unit: samples.unit,
      startTs: samples.startTs,
      endTs: samples.endTs,
      metadata: samples.metadata,
      source: sources.bundleId,
      sourceName: sources.name,
      device: devices.name,
    })
    .from(samples)
    .innerJoin(sources, eq(samples.sourceId, sources.id))
    .leftJoin(devices, eq(samples.deviceId, devices.id))
    .where(and(eq(samples.type, metric.hkType), gte(samples.startTs, now - opts.days * DAY_MS)))
    .orderBy(desc(samples.startTs))
    .limit(opts.limit ?? 200)
    .all();
  return rows.map((r) => ({
    uuid: r.uuid,
    type: r.type,
    metric: metric.name,
    value: r.value,
    valueLabel: r.value != null ? (metric.categoryValues?.[r.value] ?? null) : null,
    unit: r.unit,
    start: localDateTimeStr(r.startTs),
    end: localDateTimeStr(r.endTs),
    startTs: r.startTs,
    endTs: r.endTs,
    source: r.source,
    sourceName: r.sourceName,
    device: r.device,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
  }));
}

export function listWorkouts(db: BaymaxDb, opts: { days: number; now?: number }): WorkoutRow[] {
  const now = opts.now ?? Date.now();
  const rows = db
    .select({
      uuid: workouts.hkUuid,
      activityTypeRaw: workouts.activityTypeRaw,
      startTs: workouts.startTs,
      endTs: workouts.endTs,
      durationS: workouts.durationS,
      distanceM: workouts.distanceM,
      activeEnergyKcal: workouts.activeEnergyKcal,
      metadata: workouts.metadata,
      source: sources.bundleId,
      sourceName: sources.name,
      device: devices.name,
    })
    .from(workouts)
    .innerJoin(sources, eq(workouts.sourceId, sources.id))
    .leftJoin(devices, eq(workouts.deviceId, devices.id))
    .where(gte(workouts.startTs, now - opts.days * DAY_MS))
    .orderBy(desc(workouts.startTs))
    .all();
  return rows.map((r) => ({
    uuid: r.uuid,
    activity: workoutActivityName(r.activityTypeRaw),
    activityTypeRaw: r.activityTypeRaw,
    start: localDateTimeStr(r.startTs),
    end: localDateTimeStr(r.endTs),
    startTs: r.startTs,
    endTs: r.endTs,
    durationMin: round1(r.durationS / 60),
    distanceKm: r.distanceM != null ? Math.round(r.distanceM / 10) / 100 : null,
    activeEnergyKcal: r.activeEnergyKcal != null ? round1(r.activeEnergyKcal) : null,
    source: r.source,
    sourceName: r.sourceName,
    device: r.device,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
  }));
}

function sampleTypeStats(db: BaymaxDb) {
  return db
    .select({
      type: samples.type,
      count: sql<number>`count(*)`,
      earliest: sql<number>`min(${samples.startTs})`,
      latest: sql<number>`max(${samples.endTs})`,
    })
    .from(samples)
    .groupBy(samples.type)
    .all();
}

export function metricsInfo(db: BaymaxDb): MetricInfo[] {
  const byType = new Map(sampleTypeStats(db).map((r) => [r.type, r]));
  return METRICS.map((m) => {
    const s = byType.get(m.hkType);
    return {
      name: m.name,
      hkType: m.hkType,
      kind: m.kind,
      unit: m.unit,
      aggregation: m.aggregation,
      description: m.description,
      count: s?.count ?? 0,
      earliest: s ? localDateTimeStr(s.earliest) : null,
      latest: s ? localDateTimeStr(s.latest) : null,
    };
  });
}

export function listSources(db: BaymaxDb): SourceSummary[] {
  const sampleStats = db
    .select({
      id: samples.sourceId,
      count: sql<number>`count(*)`,
      types: sql<string>`group_concat(distinct ${samples.type})`,
      earliest: sql<number>`min(${samples.startTs})`,
      latest: sql<number>`max(${samples.endTs})`,
    })
    .from(samples)
    .groupBy(samples.sourceId)
    .all();
  const workoutStats = db
    .select({ id: workouts.sourceId, count: sql<number>`count(*)` })
    .from(workouts)
    .groupBy(workouts.sourceId)
    .all();
  const workoutsBySource = new Map(workoutStats.map((r) => [r.id, r.count]));
  const samplesBySource = new Map(sampleStats.map((r) => [r.id, r]));
  return db
    .select()
    .from(sources)
    .all()
    .map((src) => {
      const s = samplesBySource.get(src.id);
      const w = workoutsBySource.get(src.id) ?? 0;
      const types = s?.types ? s.types.split(",").sort() : [];
      return {
        source: src.bundleId,
        name: src.name,
        samples: s?.count ?? 0,
        workouts: w,
        types,
        earliest: s ? localDateTimeStr(s.earliest) : null,
        latest: s ? localDateTimeStr(s.latest) : null,
      };
    })
    .sort((a, b) => b.samples - a.samples);
}

export function statusSummary(db: BaymaxDb, dbPath: string): StatusResult {
  const stats = sampleTypeStats(db); // one scan feeds totals, range, and unregistered types
  const workoutCount = db.select({ count: sql<number>`count(*)` }).from(workouts).get();
  const registered = new Set(METRICS.map((m) => m.hkType));
  const total = stats.reduce((n, s) => n + s.count, 0);
  return {
    dbPath,
    dbSizeBytes: dbPath !== ":memory:" && existsSync(dbPath) ? statSync(dbPath).size : null,
    samples: total,
    workouts: workoutCount?.count ?? 0,
    earliestSample: total ? localDateTimeStr(Math.min(...stats.map((s) => s.earliest))) : null,
    latestSample: total ? localDateTimeStr(Math.max(...stats.map((s) => s.latest))) : null,
    perSource: listSources(db).map(({ source, name, samples: s, workouts: w }) => ({ source, name, samples: s, workouts: w })),
    unregisteredTypes: stats.filter((r) => !registered.has(r.type)).map((r) => ({ hkType: r.type, count: r.count })),
  };
}
