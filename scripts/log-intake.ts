#!/usr/bin/env bun
// Append/replace a day's plan-derived intake in data/nutrition.json.
// Adherence protocol: Adam eats the planned meals exactly and reports
// deviations, so the day's plan IS the intake record (docs/nutrition.md).
//
// usage: bun run intake <mealId>... [--date YYYY-MM-DD]   (date defaults to today)

import { join } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const dateIx = args.indexOf("--date");
const date = dateIx >= 0 ? args.splice(dateIx, 2)[1]! : new Date().toLocaleDateString("sv-SE");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date: ${date}`);
const mealIds = args;
if (!mealIds.length) {
  console.error("usage: bun run intake <mealId>... [--date YYYY-MM-DD]");
  process.exit(1);
}

const foods = new Map<string, any>((await Bun.file(join(root, "data/foods.json")).json()).map((f: any) => [f.id, f]));
const meals = new Map<string, any>((await Bun.file(join(root, "data/meals.json")).json()).map((m: any) => [m.id, m]));

// Sum every numeric key present in per100g (macros + micros alike), so new
// nutrients in foods.json flow through without touching this script.
// Units follow foods.json/FDC: g for macros/fiber/ala, mg for minerals+vitC, µg for vitD.
const tot: Record<string, number> = {};
for (const id of mealIds) {
  const meal = meals.get(id);
  if (!meal) throw new Error(`unknown meal: ${id} (see data/meals.json)`);
  for (const it of meal.items) {
    const fd = foods.get(it.food);
    if (!fd) throw new Error(`unknown food ${it.food} in meal ${id}`);
    const g = it.g ?? it.count * fd.unitG;
    for (const [key, per] of Object.entries(fd.per100g as Record<string, number>)) {
      tot[key] = (tot[key] ?? 0) + per * (g / 100);
    }
  }
}

const path = join(root, "data/nutrition.json");
const log: any[] = await Bun.file(path).json();
const round1 = (n: number) => Math.round(n * 10) / 10;
const entry: Record<string, unknown> = { date };
for (const macro of ["kcal", "protein", "carbs", "fat"]) entry[macro] = Math.round(tot[macro] ?? 0);
for (const [key, v] of Object.entries(tot)) {
  if (!(key in entry)) entry[key] = round1(v);
}
entry.meals = mealIds;
entry.method = "plan-derived"; // not measured: assumes adherence per protocol
const ix = log.findIndex((e) => e.date === date);
if (ix >= 0) log[ix] = entry;
else log.push(entry);
log.sort((a, b) => a.date.localeCompare(b.date));
await Bun.write(path, JSON.stringify(log, null, 2) + "\n");
console.log(
  `${ix >= 0 ? "replaced" : "logged"} ${date}: ${entry.kcal} kcal P${entry.protein} C${entry.carbs} F${entry.fat} fiber${entry.fiber} (${mealIds.length} meals, ${Object.keys(tot).length} nutrients)`,
);
