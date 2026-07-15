import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HealthClient, METRICS } from "@baymax/core";
import { z } from "zod";

const METRIC_NAMES = METRICS.map((m) => m.name).join(", ");

const DDL = `Tables:
  sources(id, bundle_id, name) — the app that wrote the data (e.g. com.strava.stravaride)
  devices(id, device_key, name, manufacturer, model, hardware_version, software_version)
  samples(hk_uuid, type, value, unit, start_ts, end_ts, source_id, device_id, metadata)
    type = full HealthKit identifier; start_ts/end_ts = epoch ms UTC;
    category samples (e.g. sleep) store the raw int in value; metadata = raw HealthKit metadata JSON
  workouts(hk_uuid, activity_type_raw, start_ts, end_ts, duration_s, distance_m, active_energy_kcal, source_id, device_id, metadata)
Local-day bucketing: date(start_ts/1000, 'unixepoch', 'localtime')`;

/** Build the MCP server. The DB is opened lazily so the server can start before the first sync. */
export function createServer(dbPath?: string): McpServer {
  let client: HealthClient | undefined;
  const health = () => (client ??= new HealthClient({ dbPath }));

  const server = new McpServer({ name: "baymax-health", version: "0.1.0" });
  const json = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });

  const days = (def: number) =>
    z.number().int().min(1).max(3650).default(def).describe("How many days back from now to include");

  server.registerTool(
    "health_status",
    {
      description:
        "Overview of the local Apple Health database: sample/workout totals, per-source counts, date range, and any HealthKit types present but not yet in the metric registry.",
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
        "Sleep nights, one row per (night, source) — Apple Watch and Eight Sleep are reported separately, never merged. A night is the noon-to-noon local window and is dated by the evening it started. Minutes per stage (core/deep/rem/awake), bedtime/waketime, and efficiency (asleep/inBed) when the source records in-bed time.",
      inputSchema: {
        days: days(7),
        source: z.string().optional().describe("Filter to one source bundle id (see health_sources)"),
      },
    },
    (args: { days: number; source?: string }) => json(health().sleep(args)),
  );

  server.registerTool(
    "health_workouts",
    {
      description: "Workouts with decoded activity type (running, cycling…), duration, distance, energy, source app, and raw HealthKit metadata (Strava workouts carry provider metadata here).",
      inputSchema: { days: days(30) },
    },
    (args: { days: number }) => json(health().workouts(args)),
  );

  server.registerTool(
    "health_samples",
    {
      description: `Raw samples for one metric, newest first, each with value (category values decoded, e.g. sleep stages), unit, timestamps, source app, device, and metadata. Metrics: ${METRIC_NAMES}`,
      inputSchema: {
        metric: z.string().describe("Friendly metric name, e.g. heart_rate_variability"),
        days: days(7),
        limit: z.number().int().min(1).max(10000).default(200),
      },
    },
    (args: { metric: string; days: number; limit: number }) => json(health().samples(args)),
  );

  server.registerTool(
    "health_trend",
    {
      description:
        `Daily buckets for one metric over a date range (local-time days, gaps null-filled). Aggregation depends on the metric: sum (steps, energy — uses only the dominant source and lists excludedSources to avoid iPhone+Watch double counting), avg (heart rate, HRV — includes min/max/count), latest (weight, VO2 max), or sleep (asleep minutes per night plus full night detail). Metrics: ${METRIC_NAMES}`,
      inputSchema: {
        metric: z.string().describe("Friendly metric name, e.g. weight is body_mass"),
        days: days(30),
      },
    },
    (args: { metric: string; days: number }) => json(health().trend(args)),
  );

  server.registerTool(
    "health_query",
    {
      description: `Escape hatch: run read-only SQL (SELECT/WITH only, enforced plus a read-only connection) against the health database.\n${DDL}`,
      inputSchema: { sql: z.string().describe("A SELECT or WITH query") },
    },
    (args: { sql: string }) => json(health().sql(args.sql)),
  );

  return server;
}
