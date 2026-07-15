import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { seedTempDb } from "@baymax/core/test/fixtures.ts";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
let dir: string;
let dbPath: string;

beforeAll(() => {
  ({ dir, dbPath } = seedTempDb("baymax-cli-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function health(...args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, BAYMAX_DB: dbPath } });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("health CLI", () => {
  test("status --json returns the SDK shape", () => {
    const { code, stdout } = health("status", "--json");
    expect(code).toBe(0);
    const status = JSON.parse(stdout);
    expect(status.samples).toBeGreaterThan(0);
    expect(status.perSource).toHaveLength(4);
  });

  test("human output renders tables", () => {
    const { code, stdout } = health("sleep", "--days", "3");
    expect(code).toBe(0);
    expect(stdout).toContain("night");
  });

  test("unknown command prints usage and fails", () => {
    const { code, stderr } = health("teleport");
    expect(code).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("missing db gives the helpful error", () => {
    const proc = Bun.spawnSync(["bun", CLI, "status"], { env: { ...process.env, BAYMAX_DB: join(dir, "missing.db") } });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("bun run seed");
  });
});
