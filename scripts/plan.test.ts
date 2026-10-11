import { expect, test } from "bun:test";
import { join } from "node:path";
import { check, mulberry32, planDays } from "./plan";

const root = join(import.meta.dir, "..");
const meals = await Bun.file(join(root, "data/meals.json")).json();
const foods = new Map<string, any>((await Bun.file(join(root, "data/foods.json")).json()).map((f: any) => [f.id, f]));
const byId = new Map<string, any>(meals.map((m: any) => [m.id, m]));
const dates = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const opts = (seed: number) => ({ dates, rest: new Set(["2026-10-14"]), kcal: 3200, protein: 150, rand: mulberry32(seed) });

test("drafts obey the calendar rules across many seeds", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const days = planDays(meals, foods, opts(seed));
    expect(check(days, byId, foods, { kcal: 3200, protein: 150 }).errors).toEqual([]);
    for (const d of days) {
      expect(d.slots[0]!.meal).toBe("yogurt-honey-bowl");
      expect(d.slots.filter((s) => byId.get(s.meal).slot === "main")).toHaveLength(2);
      expect(d.slots.some((s) => s.slot === (d.lift ? "post-lift" : "nightcap"))).toBe(true);
    }
  }
});

test("check catches rule breaks", () => {
  const [d1, d2] = planDays(meals, foods, opts(1));
  const dinner = d2!.slots.find((s) => s.slot === "dinner")!;
  dinner.meal = d1!.slots.find((s) => s.slot === "lunch")!.meal; // repeat yesterday's main
  dinner.items = [{ food: "pistachios-not-a-food", g: 10 }];
  const { errors } = check([d1!, d2!], byId, foods, { kcal: 3200, protein: 150 });
  expect(errors.some((e) => e.includes("was also yesterday"))).toBe(true);
  expect(errors.some((e) => e.includes("unknown food"))).toBe(true);
});

test("expiring food on hand gets planned first", () => {
  const onHand = new Map([["ground-chicken", 600]]);
  let hits = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const [d] = planDays(meals, foods, { ...opts(seed), dates: ["2026-10-12"], onHand, expiring: new Set(["ground-chicken"]) });
    if (d!.slots.some((s) => s.items.some((it) => it.food === "ground-chicken"))) hits++;
  }
  expect(hits).toBeGreaterThan(40);
});

test("every plannable food has been allergy-checked", () => {
  for (const m of meals.filter((m: any) => m.slot))
    for (const it of m.items) expect(foods.get(it.food)?.allergyChecked, `${m.id}: ${it.food}`).toBeTruthy();
});
