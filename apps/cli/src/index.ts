#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { HealthClient, METRICS } from "@baymax/core";

const USAGE = `baymax health CLI

Usage:
  health status                                  totals, sources, freshness
  health sources                                 what each app/device contributed
  health metrics                                 available metrics + live counts
  health sleep    [--days 7] [--source <bundle>] nights per source (noon-to-noon)
  health workouts [--days 30]
  health samples  --type <metric> [--days 7] [--limit 200]
  health trend    --metric <metric> [--days 30]  daily buckets

Options:
  --json      raw SDK output (exact same shapes as the MCP tools)
  --db <path> database path (default: data/baymax.db, or $BAYMAX_DB)

Raw SQL: use \`sqlite3 data/baymax.db\` (or the health_query MCP tool).
Metrics: ${METRICS.map((m) => m.name).join(", ")}`;

const [command, ...rest] = Bun.argv.slice(2);

const { values } = parseArgs({
  args: rest,
  options: {
    days: { type: "string" },
    type: { type: "string" },
    metric: { type: "string" },
    source: { type: "string" },
    limit: { type: "string" },
    db: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

function intOpt(name: "days" | "limit", fallback: number): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireOpt(name: "type" | "metric"): string {
  return values[name] ?? fail(`Missing --${name}. Run \`health metrics\` to see what's available.`);
}

try {
  const client = new HealthClient({ dbPath: values.db });
  const result = run(client, command);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else render(command!, result);
  client.close();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

function run(client: HealthClient, cmd: string | undefined): unknown {
  switch (cmd) {
    case "status":
      return client.status();
    case "sources":
      return client.sources();
    case "metrics":
      return client.metrics();
    case "sleep":
      return client.sleep({ days: intOpt("days", 7), source: values.source });
    case "workouts":
      return client.workouts({ days: intOpt("days", 30) });
    case "samples":
      return client.samples({ metric: requireOpt("type"), days: intOpt("days", 7), limit: intOpt("limit", 200) });
    case "trend":
      return client.trend({ metric: requireOpt("metric"), days: intOpt("days", 30) });
    default:
      fail(USAGE);
  }
}

function render(cmd: string, result: any): void {
  switch (cmd) {
    case "status": {
      console.log(`db: ${result.dbPath} (${result.dbSizeBytes != null ? `${(result.dbSizeBytes / 1024 / 1024).toFixed(1)} MB` : "?"})`);
      console.log(`samples: ${result.samples}  workouts: ${result.workouts}`);
      console.log(`range: ${result.earliestSample ?? "-"} → ${result.latestSample ?? "-"}`);
      console.table(result.perSource);
      if (result.unregisteredTypes.length > 0) {
        console.log("\nTypes in DB but not in the registry (candidates for packages/core/src/registry.ts):");
        console.table(result.unregisteredTypes);
      }
      break;
    }
    case "sources":
      console.table(result.map((s: any) => ({ ...s, types: s.types.length })));
      break;
    case "metrics":
      console.table(result.map(({ name, kind, unit, aggregation, count, latest }: any) => ({ name, kind, unit, aggregation, count, latest })));
      break;
    case "sleep":
      console.table(
        result.map((n: any) => ({
          night: n.night,
          source: n.sourceName ?? n.source,
          asleepMin: n.asleepMinutes,
          inBedMin: n.inBedMinutes,
          deep: n.stages.deep,
          rem: n.stages.rem,
          core: n.stages.core,
          awake: n.stages.awake,
          bedtime: n.bedtime,
          waketime: n.waketime,
          eff: n.efficiency ?? "",
        })),
      );
      break;
    case "workouts":
      console.table(
        result.map((w: any) => ({
          start: w.start,
          activity: w.activity,
          min: w.durationMin,
          km: w.distanceKm ?? "",
          kcal: w.activeEnergyKcal ?? "",
          source: w.sourceName ?? w.source,
        })),
      );
      break;
    case "samples":
      console.table(
        result.map((s: any) => ({
          start: s.start,
          value: s.valueLabel ?? s.value,
          unit: s.unit ?? "",
          source: s.sourceName ?? s.source,
          device: s.device ?? "",
        })),
      );
      break;
    case "trend": {
      const note = result.source ? `  source: ${result.source}` : "";
      console.log(`${result.metric} (${result.unit ?? "count"}, ${result.aggregation})${note}`);
      if (result.excludedSources?.length) {
        console.log(`excluded to avoid double counting: ${result.excludedSources.map((e: any) => `${e.source} (${e.total})`).join(", ")}`);
      }
      console.table(result.buckets.map(({ date, value, min, max }: any) => ({ date, value: value ?? "", ...(min != null ? { min, max } : {}) })));
      break;
    }
  }
}
