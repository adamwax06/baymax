#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createWeeklyPlan,
  defaultDbPath,
  HealthClient,
  localDateStr,
  planningPreferencesZ,
} from "@baymax/core";

const args = process.argv.slice(2);

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function nextWeekStart(now = new Date()): string {
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  const daysUntilMonday = (8 - cursor.getDay()) % 7;
  cursor.setDate(cursor.getDate() + daysUntilMonday);
  return localDateStr(cursor.getTime());
}

function help() {
  console.log(`usage: bun run sunday-plan [options]

Build a deterministic, local-only weekly plan. It never writes to Google
Calendar and never creates or submits a DoorDash order.

Options:
  --week YYYY-MM-DD   Monday starting the plan (default: next/current Monday)
  --busy PATH         Optional JSON array of {date,start,end,title} conflicts
  --extra-days PATH   Optional JSON array of extra meal days included in groceries
  --output PATH       Override data/plans/<ISO-week>.json
  --grocery-output PATH  Override data/plans/<ISO-week>-groceries.md
  --stdout            Print the full plan instead of writing an artifact
  --dry-run           Explicitly document that no external actions are applied
  --help              Show this help
`);
}

function groceryMarkdown(plan: ReturnType<typeof createWeeklyPlan>): string {
  const coveredDates = [...plan.extraDays.map((day) => day.date), `${plan.weekStart} through ${plan.weekEnd}`].join(", ");
  const lines = [
    `# Baymax groceries — ${plan.id}`,
    "",
    `Covers ${coveredDates}. Quantities include every listed meal. Prices are current estimates; substitutions are disabled.`,
    "",
  ];

  for (const store of plan.grocery.stores) {
    const title = store.store === "costco" ? "Costco delivery" : "Trader Joe's in-store";
    const subtotal = store.estimatedSubtotalUsd === null ? "partial pricing" : `$${store.estimatedSubtotalUsd.toFixed(2)}`;
    lines.push(`## ${title} — ${subtotal}`, "");
    for (const item of store.items) {
      const label = item.url ? `[${item.name}](${item.url})` : item.name;
      const boughtG = Math.round(item.packageG * item.packages);
      const cost = item.estimatedCostUsd === null ? "price unknown" : `$${item.estimatedCostUsd.toFixed(2)}`;
      lines.push(
        `- [ ] ${item.packages} × ${label} — need ${Math.round(item.shortfallG)}g; package total ${boughtG}g; ${cost}`,
      );
    }
    lines.push("");
  }

  lines.push("## Manual label check / unresolved", "");
  for (const item of plan.grocery.unresolved) {
    lines.push(`- [ ] ${item.name} — ${Math.round(item.shortfallG)}g (${item.reason})`);
  }
  lines.push("", "## Already covered at home", "");
  for (const item of plan.grocery.coveredByInventory) {
    lines.push(`- [x] ${item.name} — need ${Math.round(item.requiredG)}g; confirmed ${Math.round(item.availableInventoryG)}g`);
  }
  lines.push(
    "",
    "> Medical-allergy gate: verify the physical label at purchase; do not accept substitutions or products with an unsafe may-contain/shared-facility statement.",
    "",
  );
  return lines.join("\n");
}

if (args.includes("--help")) {
  help();
  process.exit(0);
}

const dbPath = defaultDbPath();
const dataDir = dirname(dbPath);
const readJson = (name: string) => Bun.file(join(dataDir, name)).json();
const [foods, meals, inventory, products, rawPreferences] = await Promise.all([
  readJson("foods.json"),
  readJson("meals.json"),
  readJson("inventory.json"),
  readJson("products.json"),
  readJson("preferences.json"),
]);
const preferences = planningPreferencesZ.parse(rawPreferences);
const busyPath = valueAfter("--busy");
const busy = busyPath ? await Bun.file(resolve(busyPath)).json() : [];
const extraDaysPath = valueAfter("--extra-days");
const extraDays = extraDaysPath ? await Bun.file(resolve(extraDaysPath)).json() : [];
const weekStart = valueAfter("--week") ?? nextWeekStart();

const client = new HealthClient({ dbPath });
try {
  const nutrition = client.nutrition();
  const latestStrength = client.workouts({ days: 120 }).find((workout) => {
    const type = workout.metadata?.type;
    return typeof type === "string" && preferences.training.split.includes(type);
  });
  const lastWorkoutType = typeof latestStrength?.metadata?.type === "string" ? latestStrength.metadata.type : null;

  const plan = createWeeklyPlan({
    weekStart,
    generatedAt: new Date().toISOString(),
    targetKcal: nutrition.targetKcal,
    proteinG: nutrition.proteinG,
    currentWeightLb: nutrition.currentWeightLb,
    nutritionMethod: `${nutrition.mode}: ${nutrition.method}`,
    lastWorkoutType,
    foods,
    meals,
    inventory,
    products,
    preferences,
    busy,
    extraDays,
  });

  if (args.includes("--stdout")) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const defaultOutput = join(dataDir, "plans", `${plan.id}.json`);
    const output = resolve(valueAfter("--output") ?? defaultOutput);
    mkdirSync(dirname(output), { recursive: true });
    await Bun.write(output, JSON.stringify(plan, null, 2) + "\n");
    const groceryOutput = resolve(valueAfter("--grocery-output") ?? join(dirname(output), `${plan.id}-groceries.md`));
    await Bun.write(groceryOutput, groceryMarkdown(plan));
    console.log(`wrote ${output}`);
    console.log(`wrote ${groceryOutput}`);
    console.log(
      `${plan.weekStart} → ${plan.weekEnd}: ${plan.training.sessions} lifts, ${plan.calendar.events.length} proposed calendar events`,
    );
    for (const store of plan.grocery.stores) {
      const subtotal = store.estimatedSubtotalUsd === null ? "partial pricing" : `$${store.estimatedSubtotalUsd.toFixed(2)}`;
      console.log(`${store.store}: ${store.items.length} items (${subtotal}, ${store.fulfillment})`);
    }
    console.log(`unresolved grocery mappings: ${plan.grocery.unresolved.length}`);
    console.log(`warnings: ${plan.warnings.length}`);
  }
} finally {
  client.close();
}
