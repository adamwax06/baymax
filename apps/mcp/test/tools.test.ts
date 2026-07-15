import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ingestSamples, ingestWorkouts, migrateDb, openDb } from "@baymax/core";
import { generateFixtures } from "@baymax/core/test/fixtures.ts";
import { createServer } from "../src/server.ts";

let dir: string;
let client: Client;

const textOf = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content)[0]!.text;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "baymax-mcp-"));
  const dbPath = join(dir, "test.db");
  const db = openDb({ path: dbPath });
  migrateDb(db);
  const fx = generateFixtures({ days: 5, now: Date.now() });
  ingestSamples(db, { samples: fx.samples });
  ingestWorkouts(db, { workouts: fx.workouts });
  db.$client.close();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(dbPath).connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("MCP server", () => {
  test("exposes all health tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "health_metrics",
      "health_query",
      "health_samples",
      "health_sleep",
      "health_sources",
      "health_status",
      "health_trend",
      "health_workouts",
    ]);
  });

  test("health_status returns the SDK JSON", async () => {
    const result = await client.callTool({ name: "health_status", arguments: {} });
    const status = JSON.parse(textOf(result));
    expect(status.samples).toBeGreaterThan(0);
    expect(status.perSource).toHaveLength(4);
  });

  test("health_trend applies defaults and dominant-source rule", async () => {
    const result = await client.callTool({ name: "health_trend", arguments: { metric: "steps", days: 3 } });
    const trend = JSON.parse(textOf(result));
    expect(trend.aggregation).toBe("sum");
    expect(trend.source).toBeDefined();
    expect(trend.excludedSources).toHaveLength(1);
  });

  test("health_query runs SELECT and errors on writes", async () => {
    const ok = await client.callTool({ name: "health_query", arguments: { sql: "SELECT count(*) AS n FROM samples" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok)).rows[0][0]).toBeGreaterThan(0);

    const bad = await client.callTool({ name: "health_query", arguments: { sql: "DROP TABLE samples" } });
    expect(bad.isError).toBe(true);
  });

  test("unknown metric errors carry the available list", async () => {
    const result = await client.callTool({ name: "health_trend", arguments: { metric: "aura" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Available:");
  });
});
