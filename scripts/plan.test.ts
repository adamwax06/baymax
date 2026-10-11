import { expect, test } from "bun:test";
import { join } from "node:path";
import { mulberry32, planDays } from "./plan";

const root = join(import.meta.dir, "..");
const meals = await Bun.file(join(root, "data/meals.json")).json();
const foods = new Map<string, any>((await Bun.file(join(root, "data/foods.json")).json()).map((f: any) => [f.id, f]));
const profile = await Bun.file(join(root, "data/profile.json")).json();

test("plans obey the calendar rules across many seeds", () => {
  const dates = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  for (let seed = 1; seed <= 200; seed++) {
    const days = planDays(meals, foods, { dates, rest: new Set(["2026-10-14"]), kcal: 3200, protein: 150, rand: mulberry32(seed) });
    let prev: string[] = [];
    for (const d of days) {
      const mains = d.meals.filter((m) => m.meal.slot === "main").map((m) => m.meal);
      expect(mains).toHaveLength(2);
      const meats = mains.map((m) => m.meat).filter(Boolean);
      expect(new Set(meats).size).toBe(meats.length); // one of each meat per day
      for (const m of mains) expect(prev).not.toContain(m.id); // no main on consecutive days
      prev = mains.map((m) => m.id);
      expect(Math.abs(d.kcal - 3200)).toBeLessThan(450);
      expect(d.meals[0]!.meal.id).toBe("yogurt-honey-bowl");
      expect(d.meals.some((m) => m.meal.slot === (d.lift ? "post-lift" : "nightcap"))).toBe(true);
    }
  }
});

test("every plannable food has been allergy-checked against the profile", () => {
  expect(profile.diet.allergies.length).toBeGreaterThan(0);
  for (const m of meals.filter((m: any) => m.slot))
    for (const it of m.items) expect(foods.get(it.food)?.allergyChecked, `${m.id}: ${it.food}`).toBeTruthy();
});
