#!/usr/bin/env bun
// Seeds data/baymax.db with 60 days of fixture data (Apple Watch, iPhone,
// Strava, Eight Sleep) so every CLI/MCP surface works without a phone.
// Usage: bun run seed [--reset]
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDbPath, ingestSamples, ingestWorkouts, migrateDb, openDb } from "@baymax/core";
import { generateFixtures } from "@baymax/core/test/fixtures.ts";

const path = defaultDbPath();
if (Bun.argv.includes("--reset") && existsSync(path)) rmSync(path);
mkdirSync(dirname(path), { recursive: true });

const db = openDb({ path });
migrateDb(db);
const fx = generateFixtures({ days: 60, now: Date.now() });
const s = ingestSamples(db, { samples: fx.samples });
const w = ingestWorkouts(db, { workouts: fx.workouts });
console.log(`Seeded ${path}: ${s.upserted} samples, ${w.upserted} workouts (60 days of fixtures).`);
console.log("Try: bun run health status");
