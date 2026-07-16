import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HealthClient, METRICS, SCHEMA_DOC } from "@baymax/core";
import { z } from "zod";

const METRIC_NAMES = METRICS.map((m) => m.name).join(", ");

/** Build the MCP server. The DB is opened lazily so the server can start before the first sync. */
export function createServer(dbPath?: string): McpServer {
  let client: HealthClient | undefined;
  const health = () => (client ??= new HealthClient({ dbPath }));

  const server = new McpServer({ name: "baymax-health", version: "0.1.0" });
  const json = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });

  // Optional on purpose: HealthClient owns the defaults; the prose documents them.
  const days = (def: number) =>
    z.number().int().min(1).max(3650).optional().describe(`How many days back from now to include (default ${def})`);

  server.registerTool(
    "health_overview",
    {
      description:
        'START HERE for broad or vague questions — "how am I doing", "how\'s my recovery", "what\'s my current state", "catch me up". One call returns the full current picture: last 7 nights of sleep (stages, per source), last 7 days of workouts, latest body weight, daily steps, and how fresh the data is. Returns raw inputs for you to interpret — no synthetic scores.',
      inputSchema: {},
    },
    () => json(health().overview()),
  );

  server.registerTool(
    "health_lifts",
    {
      description:
        'Strength progression — "how\'s my bench", "am I on pace for my lift goal", "am I getting stronger". Dated entries per exercise with full structured sets (lb, reps, perSide for dumbbell pairs, bodyweight flag), top set, e1rmLb (Epley estimated 1RM off the best set — the measure lift-goal pacing in data/goals.json uses), total reps, and volume. Exercise matches by case-insensitive substring ("bench" matches "Bench Press"). Data comes from the hand-edited gym log (docs/weights.md).',
      inputSchema: {
        exercise: z.string().optional().describe('Filter, e.g. "bench" or "squat"; omit for all exercises'),
        days: days(365),
      },
    },
    (args: { exercise?: string; days?: number }) => json(health().lifts(args)),
  );

  server.registerTool(
    "health_nutrition",
    {
      description:
        '"What should I eat today", "how many calories", "am I on track for 180". Adaptive calorie + protein targets for the body-weight goal in data/goals.json: seeded from Mifflin-St Jeor, automatically switching to an empirically measured TDEE (energy balance over logged intake in data/nutrition.json + weigh-ins) once 21 days contain enough data. Returns TDEE, target kcal, protein, observed vs target rate, logging adherence, and honest staleness notes. Methods are named in the output. Log intake by appending {date, kcal} lines to data/nutrition.json.',
      inputSchema: {},
    },
    () => json(health().nutrition()),
  );

  server.registerTool(
    "health_status",
    {
      description:
        'Database health — "is my data syncing", "what\'s in the database". Sample/workout totals, per-source counts, date range, and any HealthKit types present but not yet in the metric registry.',
      inputSchema: {},
    },
    () => json(health().status()),
  );

  server.registerTool(
    "health_sources",
    {
      description:
        "Every app/device that contributed data (Apple Watch, Strava, Eight Sleep, iPhone…), with sample/workout counts, the HealthKit types each one wrote, and date ranges. Use this to see where data comes from.",
      inputSchema: {},
    },
    () => json(health().sources()),
  );

  server.registerTool(
    "health_metrics",
    {
      description:
        "All registered metrics (friendly name, HealthKit identifier, unit, aggregation kind) merged with live record counts and date ranges — the 'what data exists' view. Metric names from here feed health_samples and health_trend.",
      inputSchema: {},
    },
    () => json(health().metrics()),
  );

  server.registerTool(
    "health_sleep",
    {
      description:
        '"How am I sleeping", "how was last night", "sleep quality lately". Sleep nights, one row per (night, source) — Apple Watch and Eight Sleep are reported separately, never merged. A night is the noon-to-noon local window and is dated by the evening it started. Minutes per stage (core/deep/rem/awake), bedtime/waketime, and efficiency (asleep/inBed) when the source records in-bed time.',
      inputSchema: {
        days: days(7),
        source: z.string().optional().describe("Filter to one source bundle id (see health_sources)"),
      },
    },
    (args: { days?: number; source?: string }) => json(health().sleep(args)),
  );

  server.registerTool(
    "health_workouts",
    {
      description: '"What workouts have I done", "did I train this week", "show my runs". Workouts with decoded activity type (running, cycling, strength…), duration, distance, energy, source app, and raw metadata (Strava links, gym-log set detail). For strength progression specifically, prefer health_lifts.',
      inputSchema: { days: days(30) },
    },
    (args: { days?: number }) => json(health().workouts(args)),
  );

  server.registerTool(
    "health_samples",
    {
      description: `Raw samples for one metric, newest first, each with value (category values decoded, e.g. sleep stages), unit, timestamps, source app, device, and metadata. Metrics: ${METRIC_NAMES}`,
      inputSchema: {
        metric: z.string().describe("Friendly metric name, e.g. heart_rate_variability"),
        days: days(7),
        limit: z.number().int().min(1).max(10000).optional().describe("Max rows (default 200)"),
      },
    },
    (args: { metric: string; days?: number; limit?: number }) => json(health().samples(args)),
  );

  server.registerTool(
    "health_trend",
    {
      description:
        `"How has my weight changed", "steps over the last month", "heart rate trend". Daily buckets for one metric over a date range (local-time days, gaps null-filled). Aggregation depends on the metric: sum (steps, energy — uses only the dominant source and lists excludedSources to avoid iPhone+Watch double counting), avg (heart rate, HRV — includes min/max/count), latest (weight, VO2 max), or sleep (asleep minutes per night plus full night detail). Metrics: ${METRIC_NAMES}`,
      inputSchema: {
        metric: z.string().describe("Friendly metric name, e.g. weight is body_mass"),
        days: days(30),
      },
    },
    (args: { metric: string; days?: number }) => json(health().trend(args)),
  );

  server.registerTool(
    "health_query",
    {
      description: `Escape hatch: run read-only SQL (SELECT/WITH only, enforced plus a read-only connection) against the health database.\n${SCHEMA_DOC}`,
      inputSchema: { sql: z.string().describe("A SELECT or WITH query") },
    },
    (args: { sql: string }) => json(health().sql(args.sql)),
  );

  return server;
}
