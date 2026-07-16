import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthClient } from "@baymax/core";

const SCRIPT = join(import.meta.dir, "import-weights.ts");
let dir: string;
let dbPath: string;
let jsonPath: string;

const weights = {
  bodyWeight: [{ date: "2026-07-01", lb: 168.4 }],
  sessions: [
    {
      date: "2026-07-01",
      type: "push",
      exercises: [
        { name: "Bench Press", sets: [{ lb: 160, reps: [6, 6] }] },
        { name: "Pullups", sets: [{ bodyweight: true, reps: [9, 6] }] },
      ],
    },
    { date: "2026-07-03", exercises: [{ name: "Squat", sets: [{ lb: 195, reps: [6, 6] }] }] },
  ],
};

function run(json: unknown) {
  Bun.write(jsonPath, JSON.stringify(json));
  return Bun.spawnSync(["bun", SCRIPT, jsonPath], { env: { ...process.env, BAYMAX_DB: dbPath } });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "baymax-weights-"));
  dbPath = join(dir, "test.db");
  jsonPath = join(dir, "weights.json");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("import-weights", () => {
  test("imports sessions and body weight with full set detail", () => {
    const proc = run(weights);
    expect(proc.exitCode).toBe(0);

    const client = new HealthClient({ dbPath });
    const workouts = client.workouts({ days: 3650 });
    expect(workouts).toHaveLength(2);
    expect(workouts.every((w) => w.activity === "traditional_strength_training")).toBe(true);
    const push = workouts.find((w) => w.uuid === "weights-2026-07-01")!;
    expect(push.metadata!.type).toBe("push");
    const exercises = push.metadata!.exercises as { name: string; sets: { lb?: number; reps: number[] }[] }[];
    expect(exercises[0]!.sets[0]).toEqual({ lb: 160, reps: [6, 6] });

    const bw = client.samples({ metric: "body_mass", days: 3650 });
    expect(bw).toHaveLength(1);
    expect(bw[0]!.value).toBeCloseTo(76.38, 1); // 168.4 lb in kg
    expect(bw[0]!.sourceName).toBe("Weights Log");
    client.close();
  });

  test("re-import is idempotent; removed entries are deleted (source of truth)", () => {
    expect(run(weights).exitCode).toBe(0); // replay: no dupes
    const pruned = { ...weights, sessions: weights.sessions.slice(0, 1) };
    expect(run(pruned).exitCode).toBe(0);

    const client = new HealthClient({ dbPath });
    expect(client.workouts({ days: 3650 })).toHaveLength(1);
    client.close();
  });

  test("validation fails loudly with the exact path", () => {
    const proc = run({ bodyWeight: [], sessions: [{ date: "07/01/26", exercises: [{ name: "Bench", sets: [] }] }] });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("sessions.0.date");
  });
});
