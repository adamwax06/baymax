import type { AggregationKind } from "./registry.ts";

// Wire payload types are inferred from the Zod schemas in payloads.ts.
export type { DevicePayload, SamplePayload, SourcePayload, WorkoutPayload } from "./payloads.ts";

// ---- Query results ----

export interface SampleRow {
  uuid: string;
  type: string;
  metric: string;
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

export interface LiftSet {
  lb?: number;
  perSide?: boolean;
  bodyweight?: boolean;
  reps: number[];
}

export interface LiftEntry {
  date: string; // local YYYY-MM-DD
  exercise: string;
  sets: LiftSet[];
  topLb: number | null;
  totalReps: number;
  volumeLb: number; // sum of lb×reps (perSide weights counted once)
  notes?: string;
}

export interface OverviewResult {
  latestData: string | null; // freshness: newest sample in the DB
  sleep: { nights: SleepNight[]; avgAsleepMinutes: number | null; source?: string };
  workouts: WorkoutRow[];
  weight: { kg: number; lb: number; date: string } | null;
  steps: { dailyAvg: number | null; days: TrendBucket[] };
}

export interface NutritionResult {
  /** "seed" = Mifflin-St Jeor estimate; "empirical" = solved from your own intake + scale data. */
  mode: "seed" | "empirical";
  method: string;
  tdee: number;
  targetKcal: number;
  proteinG: number;
  goal: { targetLb: number; ratePerWeekLb: number };
  currentWeightLb: number | null;
  lastWeighIn: string | null;
  observedRatePerWeekLb: number | null; // 28-day least-squares slope
  loggedDays14: number; // intake entries in the last 14 days
  notes: string[];
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
