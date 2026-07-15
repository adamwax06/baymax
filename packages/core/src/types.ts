import type { AggregationKind } from "./registry.ts";

// ---- Wire payloads (mirrored by apps/server Zod schemas and ios/Baymax/Payloads.swift) ----

export interface SourcePayload {
  bundleId: string;
  name?: string | null;
}

export interface DevicePayload {
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  hardwareVersion?: string | null;
  softwareVersion?: string | null;
}

export interface SamplePayload {
  uuid: string;
  type: string;
  value?: number | null;
  unit?: string | null;
  start: number; // epoch ms UTC
  end: number;
  source: SourcePayload;
  device?: DevicePayload | null;
  metadata?: Record<string, unknown> | null;
}

export interface WorkoutPayload {
  uuid: string;
  activityTypeRaw: number;
  start: number;
  end: number;
  duration: number; // seconds
  distanceMeters?: number | null;
  activeEnergyKcal?: number | null;
  source: SourcePayload;
  device?: DevicePayload | null;
  metadata?: Record<string, unknown> | null;
}

// ---- Query results ----

export interface SampleRow {
  uuid: string;
  type: string;
  metric: string | null; // friendly name if registered
  value: number | null;
  valueLabel: string | null; // decoded category name, e.g. "asleepDeep"
  unit: string | null;
  start: string; // ISO local
  end: string;
  startTs: number;
  endTs: number;
  source: string; // bundle id
  sourceName: string | null;
  device: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WorkoutRow {
  uuid: string;
  activity: string;
  activityTypeRaw: number;
  start: string;
  end: string;
  startTs: number;
  endTs: number;
  durationMin: number;
  distanceKm: number | null;
  activeEnergyKcal: number | null;
  source: string;
  sourceName: string | null;
  device: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SleepNight {
  night: string; // local date the night started (noon-to-noon window)
  source: string; // bundle id — nights are per source, never merged
  sourceName: string | null;
  inBedMinutes: number;
  asleepMinutes: number;
  stages: { core: number; deep: number; rem: number; awake: number; unspecified: number };
  bedtime: string; // ISO local
  waketime: string;
  efficiency: number | null; // asleep / inBed, when inBed was recorded
}

export interface TrendBucket {
  date: string; // local YYYY-MM-DD
  value: number | null;
  count: number;
  min?: number;
  max?: number;
}

export interface TrendResult {
  metric: string;
  unit: string | null;
  aggregation: AggregationKind;
  days: number;
  /** For sum metrics: the single source aggregated (dominant), to avoid double counting. */
  source?: string;
  excludedSources?: { source: string; total: number }[];
  buckets: TrendBucket[];
  /** For the sleep metric: full per-source night detail. */
  nights?: SleepNight[];
}

export interface SourceSummary {
  source: string;
  name: string | null;
  samples: number;
  workouts: number;
  types: string[];
  earliest: string | null;
  latest: string | null;
}

export interface MetricInfo {
  name: string;
  hkType: string;
  kind: "quantity" | "category";
  unit: string | null;
  aggregation: AggregationKind;
  description: string;
  count: number;
  earliest: string | null;
  latest: string | null;
}

export interface StatusResult {
  dbPath: string;
  dbSizeBytes: number | null;
  samples: number;
  workouts: number;
  earliestSample: string | null;
  latestSample: string | null;
  perSource: { source: string; name: string | null; samples: number; workouts: number }[];
  /** HealthKit types present in the DB but missing from the registry — candidates to add. */
  unregisteredTypes: { hkType: string; count: number }[];
}
