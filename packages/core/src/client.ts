import { defaultDbPath, openDb, type BaymaxDb } from "./db.ts";
import { metricByName, METRICS } from "./registry.ts";
import { deriveSleepNights } from "./sleep.ts";
import { listSources, listWorkouts, metricsInfo, rawSamples, statusSummary, trend } from "./queries.ts";
import type {
  LiftEntry,
  LiftSet,
  MetricInfo,
  OverviewResult,
  SampleRow,
  SleepNight,
  SourceSummary,
  StatusResult,
  TrendResult,
  WorkoutRow,
} from "./types.ts";

/**
 * The typed read SDK. Opens the SQLite database read-only; all CLI and MCP
 * output is exactly what these methods return.
 */
export class HealthClient {
  readonly dbPath: string;
  private db: BaymaxDb;

  constructor(opts: { dbPath?: string } = {}) {
    this.dbPath = opts.dbPath ?? defaultDbPath();
    this.db = openDb({ path: this.dbPath, readonly: true });
  }

  status(): StatusResult {
    return statusSummary(this.db, this.dbPath);
  }

  sources(): SourceSummary[] {
    return listSources(this.db);
  }

  metrics(): MetricInfo[] {
    return metricsInfo(this.db);
  }

  sleep(opts: { days?: number; source?: string; now?: number } = {}): SleepNight[] {
    return deriveSleepNights(this.db, { days: opts.days ?? 7, source: opts.source, now: opts.now });
  }

  workouts(opts: { days?: number; now?: number } = {}): WorkoutRow[] {
    return listWorkouts(this.db, { days: opts.days ?? 30, now: opts.now });
  }

  samples(opts: { metric: string; days?: number; limit?: number; now?: number }): SampleRow[] {
    return rawSamples(this.db, this.requireMetric(opts.metric), {
      days: opts.days ?? 7,
      limit: opts.limit,
      now: opts.now,
    });
  }

  trend(opts: { metric: string; days?: number; now?: number }): TrendResult {
    return trend(this.db, this.requireMetric(opts.metric), { days: opts.days ?? 30, now: opts.now });
  }

  /** Strength progression: flattens structured set detail out of workout metadata (see docs/weights.md). */
  lifts(opts: { exercise?: string; days?: number; now?: number } = {}): LiftEntry[] {
    const needle = opts.exercise?.toLowerCase();
    const entries: LiftEntry[] = [];
    for (const w of this.workouts({ days: opts.days ?? 365, now: opts.now })) {
      const exercises = w.metadata?.exercises;
      if (!Array.isArray(exercises)) continue;
      for (const e of exercises as { name: string; sets?: LiftSet[]; notes?: string }[]) {
        if (needle && !e.name.toLowerCase().includes(needle)) continue;
        const sets = e.sets ?? [];
        const lbs = sets.map((s) => s.lb).filter((lb): lb is number => lb !== undefined);
        entries.push({
          date: w.start.slice(0, 10),
          exercise: e.name,
          sets,
          topLb: lbs.length ? Math.max(...lbs) : null,
          totalReps: sets.reduce((n, s) => n + s.reps.reduce((a, b) => a + b, 0), 0),
          volumeLb: Math.round(sets.reduce((n, s) => n + (s.lb ?? 0) * s.reps.reduce((a, b) => a + b, 0), 0)),
          ...(e.notes && { notes: e.notes }),
        });
      }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** One-call context bundle: recent sleep, training, weight, activity, and data freshness. */
  overview(opts: { now?: number } = {}): OverviewResult {
    const now = opts.now;
    const sleepTrend = this.trend({ metric: "sleep", days: 7, now });
    const asleep = sleepTrend.buckets.map((b) => b.value).filter((v): v is number => v !== null);
    const latestWeight = this.samples({ metric: "body_mass", days: 365, limit: 1, now })[0];
    const steps = this.trend({ metric: "steps", days: 7, now });
    const stepValues = steps.buckets.map((b) => b.value).filter((v): v is number => v !== null);
    const round = (n: number) => Math.round(n);
    return {
      latestData: this.status().latestSample,
      sleep: {
        nights: sleepTrend.nights ?? [],
        avgAsleepMinutes: asleep.length ? round(asleep.reduce((a, b) => a + b, 0) / asleep.length) : null,
        ...(sleepTrend.source && { source: sleepTrend.source }),
      },
      workouts: this.workouts({ days: 7, now }),
      weight: latestWeight?.value != null
        ? { kg: latestWeight.value, lb: Math.round(latestWeight.value * 2.20462 * 10) / 10, date: latestWeight.start.slice(0, 10) }
        : null,
      steps: {
        dailyAvg: stepValues.length ? round(stepValues.reduce((a, b) => a + b, 0) / stepValues.length) : null,
        days: steps.buckets,
      },
    };
  }

  /** Escape hatch for arbitrary read-only SQL (the connection itself is read-only too). */
  sql(query: string): { columns: string[]; rows: unknown[][] } {
    if (!/^\s*(select|with)\b/i.test(query)) {
      throw new Error("Read-only: only SELECT/WITH queries are allowed.");
    }
    const stmt = this.db.$client.query(query);
    return { columns: stmt.columnNames, rows: stmt.values() as unknown[][] };
  }

  close(): void {
    this.db.$client.close();
  }

  private requireMetric(name: string) {
    const metric = metricByName(name);
    if (!metric) {
      throw new Error(`Unknown metric "${name}". Available: ${METRICS.map((m) => m.name).join(", ")}`);
    }
    return metric;
  }
}
