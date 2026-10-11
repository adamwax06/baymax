#!/usr/bin/env bun
// Draft a few days of meals from data/meals.json and print the grocery list.
// Each day = fixed slots (breakfast, pre-lift toast, post-lift smoothie or
// nightcap) + two random mains, constrained by the AGENTS.md calendar rules:
// one of each meat per day, no main on consecutive days, close to the kcal
// target with enough protein. Rice/pasta portions flex to close the gap.
//
// usage: bun run plan [--from YYYY-MM-DD] [--days 3] [--rest 2026-10-14,...] [--seed N] [--json]
// ponytail: grocery list is the full need, not need minus inventory; subtract once inventory is a snapshot.

import { join } from "node:path";

type Item = { food: string; g?: number; count?: number };
type Meal = { id: string; name: string; slot?: string; meat?: string; try?: boolean; items: Item[] };
type Food = { id: string; name: string; weighed: string; unitG?: number; packageG?: number; per100g: Record<string, number> };
export type Day = { date: string; lift: boolean; meals: { slot: string; meal: Meal; items: Item[] }[]; kcal: number; protein: number };

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ (t + Math.imul(t ^ (t >>> 14), 47 | t));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const grams = (it: Item, foods: Map<string, Food>) => it.g ?? (it.count ?? 0) * (foods.get(it.food)!.unitG ?? 0);
const macro = (items: Item[], foods: Map<string, Food>, key: string) =>
  items.reduce((s, it) => s + ((foods.get(it.food)!.per100g[key] ?? 0) * grams(it, foods)) / 100, 0);

export function planDays(
  meals: Meal[],
  foods: Map<string, Food>,
  opts: { dates: string[]; rest: Set<string>; kcal: number; protein: number; rand: () => number },
): Day[] {
  const one = (slot: string) => meals.find((m) => m.slot === slot)!;
  const mains = meals.filter((m) => m.slot === "main");
  const used = new Map<string, number>();
  const days: Day[] = [];
  let yesterday = new Set<string>();

  for (const date of opts.dates) {
    const lift = !opts.rest.has(date);
    const fixed = [one("breakfast"), one("pre-lift"), one(lift ? "post-lift" : "nightcap")];
    const fixedK = macro(fixed.flatMap((m) => m.items), foods, "kcal");
    const fixedP = macro(fixed.flatMap((m) => m.items), foods, "protein");

    let best: { score: number; pair: [Meal, Meal]; scale: number } | undefined;
    for (const a of mains)
      for (const b of mains) {
        if (a.id >= b.id || yesterday.has(a.id) || yesterday.has(b.id)) continue;
        if (a.meat && a.meat === b.meat) continue;
        const items = [...a.items, ...b.items];
        const k = fixedK + macro(items, foods, "kcal");
        const grainK = macro(items.filter((it) => foods.get(it.food)!.weighed === "dry"), foods, "kcal");
        // Flex rice/pasta toward the target, within 0.7x-1.4x of the recipe.
        const scale = grainK ? Math.min(1.4, Math.max(0.7, 1 + (opts.kcal - k) / grainK)) : 1;
        const kcal = k + grainK * (scale - 1);
        const p = fixedP + macro(items, foods, "protein");
        const score =
          Math.abs(kcal - opts.kcal) / 100 +
          Math.max(0, opts.protein - p) / 10 +
          2 * ((used.get(a.id) ?? 0) + (used.get(b.id) ?? 0)) +
          (a.try ? 1 : 0) + (b.try ? 1 : 0) +
          opts.rand() * 3;
        if (!best || score < best.score) best = { score, pair: [a, b], scale };
      }
    if (!best) throw new Error(`no valid mains for ${date}`);

    const scaled = (m: Meal) =>
      m.items.map((it) =>
        foods.get(it.food)!.weighed === "dry" && it.g ? { ...it, g: Math.round((it.g * best!.scale) / 10) * 10 } : it,
      );
    // Bigger main at lunch: never leave the largest meal for last.
    const [lunch, dinner] = best.pair
      .map((m) => ({ meal: m, items: scaled(m) }))
      .sort((x, y) => macro(y.items, foods, "kcal") - macro(x.items, foods, "kcal"));
    const order = [
      { slot: "breakfast", meal: fixed[0]!, items: fixed[0]!.items },
      { slot: "lunch", ...lunch! },
      { slot: lift ? "pre-lift" : "afternoon", meal: fixed[1]!, items: fixed[1]!.items },
      ...(lift ? [{ slot: "post-lift", meal: fixed[2]!, items: fixed[2]!.items }] : []),
      { slot: "dinner", ...dinner! },
      ...(lift ? [] : [{ slot: "nightcap", meal: fixed[2]!, items: fixed[2]!.items }]),
    ];
    const all = order.flatMap((o) => o.items);
    days.push({ date, lift, meals: order, kcal: Math.round(macro(all, foods, "kcal")), protein: Math.round(macro(all, foods, "protein")) });
    for (const m of best.pair) used.set(m.id, (used.get(m.id) ?? 0) + 1);
    yesterday = new Set(best.pair.map((m) => m.id));
  }
  return days;
}

export function groceryList(days: Day[], foods: Map<string, Food>) {
  const need = new Map<string, number>();
  for (const it of days.flatMap((d) => d.meals.flatMap((m) => m.items)))
    need.set(it.food, (need.get(it.food) ?? 0) + grams(it, foods));
  return [...need].map(([id, g]) => ({ id, name: foods.get(id)!.name, g: Math.round(g) })).sort((a, b) => b.g - a.g);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const arg = (flag: string) => {
    const i = Bun.argv.indexOf(flag);
    return i >= 0 ? Bun.argv[i + 1] : undefined;
  };
  const from = arg("--from") ?? new Date().toLocaleDateString("sv-SE");
  const n = Number(arg("--days") ?? 3);
  const dates = Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString("sv-SE");
  });
  const meals: Meal[] = await Bun.file(join(root, "data/meals.json")).json();
  const foods = new Map<string, Food>((await Bun.file(join(root, "data/foods.json")).json()).map((f: Food) => [f.id, f]));
  const goals: any[] = await Bun.file(join(root, "data/goals.json")).json();
  const kcal = goals.find((g) => g.targetKcalOverride)?.targetKcalOverride ?? 3200;
  const seed = Number(arg("--seed") ?? Date.now() % 1e9);
  const days = planDays(meals, foods, {
    dates,
    rest: new Set((arg("--rest") ?? "").split(",").filter(Boolean)),
    kcal,
    protein: Number(arg("--protein") ?? 150),
    rand: mulberry32(seed),
  });
  const list = groceryList(days, foods);

  if (Bun.argv.includes("--json")) {
    console.log(JSON.stringify({ seed, kcal, days, groceries: list }, null, 2));
  } else {
    for (const d of days) {
      console.log(`\n${d.date} (${d.lift ? "lift" : "rest"}) ${d.kcal} kcal / ${d.protein}P`);
      for (const m of d.meals) {
        const k = Math.round(macro(m.items, foods, "kcal"));
        console.log(`  ${m.slot.padEnd(10)} ${m.meal.name}${m.meal.try ? " (NEW)" : ""}  ${k} kcal`);
      }
    }
    console.log(`\nGroceries (full need; strike what's on hand) — seed ${seed}`);
    for (const g of list) console.log(`  ${String(g.g).padStart(5)}g  ${g.name}`);
  }
}
