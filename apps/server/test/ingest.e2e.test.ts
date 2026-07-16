import { beforeAll, describe, expect, test } from "bun:test";
import { migrateDb, openDb, statusSummary, type BaymaxDb } from "@baymax/core";
import { generateFixtures, NOW } from "@baymax/core/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import type { Hono } from "hono";

let db: BaymaxDb;
let app: Hono;
const fx = generateFixtures({ days: 3, now: NOW });

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeAll(() => {
  db = openDb({ path: ":memory:" });
  migrateDb(db);
  app = createApp(db);
});

describe("server", () => {
  test("ping", async () => {
    const res = await app.request("/v1/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "baymax" });
  });

  test("bodyweight backfill endpoint serves entries (or empty when absent)", async () => {
    const res = await app.request("/v1/backfill/bodyweight");
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { date: string; lb: number }[];
    expect(Array.isArray(entries)).toBe(true);
    for (const e of entries.slice(0, 3)) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.lb).toBeGreaterThan(80);
    }
  });

  test("ingests sample and workout batches", async () => {
    const sres = await post("/v1/ingest/samples", { samples: fx.samples });
    expect(sres.status).toBe(200);
    expect(await sres.json()).toEqual({ accepted: fx.samples.length, deleted: 0 });

    const wres = await post("/v1/ingest/workouts", { workouts: fx.workouts });
    expect(wres.status).toBe(200);

    const status = statusSummary(db, ":memory:");
    expect(status.samples).toBe(fx.samples.length);
    expect(status.workouts).toBe(fx.workouts.length);
    expect(status.perSource.length).toBe(4);
  });

  test("replaying the same batch is idempotent", async () => {
    await post("/v1/ingest/samples", { samples: fx.samples });
    expect(statusSummary(db, ":memory:").samples).toBe(fx.samples.length);
  });

  test("deletions remove rows", async () => {
    const res = await post("/v1/ingest/samples", { samples: [], deleted: [fx.samples[0]!.uuid] });
    expect(await res.json()).toEqual({ accepted: 0, deleted: 1 });
    expect(statusSummary(db, ":memory:").samples).toBe(fx.samples.length - 1);
  });

  test("malformed payloads get a 400 with Zod issues", async () => {
    const res = await post("/v1/ingest/samples", { samples: [{ uuid: "x" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toBeDefined();

    const notJson = await app.request("/v1/ingest/samples", { method: "POST", body: "not json" });
    expect(notJson.status).toBe(400);
  });

  test("oversized batches are rejected", async () => {
    const big = Array.from({ length: 5001 }, (_, i) => ({ ...fx.samples[0]!, uuid: `big-${i}` }));
    const res = await post("/v1/ingest/samples", { samples: big });
    expect(res.status).toBe(400);
  });
});
