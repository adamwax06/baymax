import { defaultDbPath, openDb, type BaymaxDb } from "./db.ts";
import { metricByName, METRICS } from "./registry.ts";
import { deriveSleepNights } from "./sleep.ts";
import { listSources, listWorkouts, metricsInfo, rawSamples, statusSummary, trend } from "./queries.ts";
import type { MetricInfo, SampleRow, SleepNight, SourceSummary, StatusResult, TrendResult, WorkoutRow } from "./types.ts";

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
