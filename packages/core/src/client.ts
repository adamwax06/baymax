import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultDbPath, openDb, type BaymaxDb } from "./db.ts";
import { round1 } from "./time.ts";
import { ageYears, empiricalTdee, epley1RM, KG_PER_LB, mifflinStJeor, proteinTarget, slopePerDay, targetKcal } from "./nutrition.ts";
import { metricByName, METRICS } from "./registry.ts";
import { deriveSleepNights } from "./sleep.ts";
import { listSources, listWorkouts, metricsInfo, rawSamples, statusSummary, trend } from "./queries.ts";
import type {
  LiftEntry,
  LiftSet,
  MetricInfo,
  NutritionResult,
  OverviewResult,
  SampleRow,
  SleepNight,
  SourceSummary,
  StatusResult,
  TrendResult,
  WorkoutRow,
} from "./types.ts";

// Fail-loud schemas for the hand-edited nutrition files: a typo like "kcals"
// must error with the file path, never silently poison the TDEE math.
const profileZ = z
  .object({ birthdate: z.string(), heightIn: z.number(), sex: z.enum(["male", "female"]), activityFactor: z.number() })
  .passthrough();
const goalsZ = z.array(z.object({}).passthrough());
const bodyGoalZ = z.object({ metric: z.literal("body_mass"), targetLb: z.number(), ratePerWeekLb: z.number() }).passthrough();
const intakeZ = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kcal: z.number().positive() }).passthrough());

function readValidated<T>(path: string, schema: z.ZodType<T>, required: boolean): T | undefined {
  if (!existsSync(path)) {
    if (!required) return undefined;
    throw new Error(`Missing ${path} (see docs/nutrition.md)`);
  }
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

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
        const e1rms = sets.filter((s) => s.lb).flatMap((s) => s.reps.map((r) => epley1RM(s.lb!, r)));
        entries.push({
          date: w.start.slice(0, 10),
          exercise: e.name,
          sets,
          topLb: lbs.length ? Math.max(...lbs) : null,
          e1rmLb: e1rms.length ? round1(Math.max(...e1rms)) : null,
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
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const sleepTrend = this.trend({ metric: "sleep", days: 7, now });
    const latestWeight = this.samples({ metric: "body_mass", days: 365, limit: 1, now })[0];
    const steps = this.trend({ metric: "steps", days: 7, now });
    return {
      latestSample: this.status().latestSample,
      sleep: {
        nights: sleepTrend.nights ?? [],
        avgAsleepMinutes: avg(sleepTrend.buckets.map((b) => b.value).filter((v): v is number => v !== null)),
        ...(sleepTrend.source && { source: sleepTrend.source }),
      },
      workouts: this.workouts({ days: 7, now }),
      weight: latestWeight?.value != null
        ? { kg: latestWeight.value, lb: round1(latestWeight.value / KG_PER_LB), date: latestWeight.start.slice(0, 10) }
        : null,
      steps: {
        dailyAvg: avg(steps.buckets.map((b) => b.value).filter((v): v is number => v !== null)),
        buckets: steps.buckets,
      },
    };
  }

  /**
   * Adaptive calorie/protein targets for the body-weight goal in data/goals.json.
   * Seeds from Mifflin-St Jeor; switches to an empirical energy-balance TDEE once
   * the last 21 days contain ≥12 logged intake days and ≥5 weigh-ins.
   */
  nutrition(opts: { now?: number } = {}): NutritionResult {
    const now = opts.now ?? Date.now();
    const dataDir = dirname(this.dbPath);
    const profile = readValidated(join(dataDir, "profile.json"), profileZ, true)!;
    const goals = readValidated(join(dataDir, "goals.json"), goalsZ, true)!;
    const goal = goals.map((g) => bodyGoalZ.safeParse(g)).find((r) => r.success)?.data;
    if (!goal) throw new Error("No body_mass goal in goals.json (needs metric, targetLb, ratePerWeekLb)");
    const intake = readValidated(join(dataDir, "nutrition.json"), intakeZ, false) ?? [];

    const weighIns = this.samples({ metric: "body_mass", days: 3650, limit: 10000, now })
      .map((s) => ({ ts: s.startTs, value: s.value! / KG_PER_LB, date: s.start.slice(0, 10) }))
      .sort((a, b) => a.ts - b.ts);
    const last7 = weighIns.filter((w) => now - w.ts <= 7 * 86_400_000);
    const currentWeightLb = last7.length
      ? round1(last7.reduce((a, w) => a + w.value, 0) / last7.length)
      : weighIns.length
        ? round1(weighIns.at(-1)!.value)
        : null;
    if (currentWeightLb === null) {
      throw new Error("No weigh-ins found — add one in the Apple Health app (or tell Siri), then sync from the Baymax app");
    }

    const daysAgo = (date: string) => now - new Date(date + "T12:00:00").getTime();
    const inWindow = weighIns.filter((w) => now - w.ts <= 21 * 86_400_000);
    const logged = intake.filter((e) => daysAgo(e.date) <= 21 * 86_400_000);
    const loggedDays14 = intake.filter((e) => daysAgo(e.date) <= 14 * 86_400_000).length;

    const slope28 = slopePerDay(weighIns.filter((w) => now - w.ts <= 28 * 86_400_000));
    const observedRatePerWeekLb = slope28 !== null ? Math.round(slope28 * 7 * 100) / 100 : null;

    const notes: string[] = [];
    const weightForCalc = currentWeightLb;
    let mode: NutritionResult["mode"] = "seed";
    let method: string;
    let tdee: number;

    const windowSlope = slopePerDay(inWindow);
    if (logged.length >= 12 && inWindow.length >= 5 && windowSlope !== null) {
      mode = "empirical";
      const avgKcal = logged.reduce((a, e) => a + e.kcal, 0) / logged.length;
      tdee = Math.round(empiricalTdee(avgKcal, windowSlope));
      method = `energy balance over ${logged.length} logged days + ${inWindow.length} weigh-ins (21d window)`;
    } else {
      const age = ageYears(profile.birthdate, now);
      const bmr = mifflinStJeor(weightForCalc * KG_PER_LB, profile.heightIn * 2.54, age, profile.sex);
      tdee = Math.round(bmr * profile.activityFactor);
      method = `Mifflin-St Jeor × ${profile.activityFactor} activity (seed — switches to measured TDEE at 12 logged days + 5 weigh-ins per 21d)`;
      notes.push(`empirical progress: ${logged.length}/12 logged days, ${inWindow.length}/5 weigh-ins in the last 21 days`);
    }

    if (!weighIns.length) notes.push("no weigh-ins in the last 45 days — the loop is blind without the scale");
    else {
      const staleDays = Math.floor((now - weighIns.at(-1)!.ts) / 86_400_000);
      if (staleDays > 3) notes.push(`last weigh-in is ${staleDays} days old`);
    }

    return {
      mode,
      method,
      tdee,
      targetKcal: targetKcal(tdee, goal.ratePerWeekLb),
      proteinG: proteinTarget(weightForCalc),
      goal: { targetLb: goal.targetLb, ratePerWeekLb: goal.ratePerWeekLb },
      currentWeightLb,
      lastWeighIn: weighIns.at(-1)?.date ?? null,
      observedRatePerWeekLb,
      loggedDays14,
      notes,
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
