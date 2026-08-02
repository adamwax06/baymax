import { describe, expect, test } from "bun:test";
import { createWeeklyPlan, type WeeklyPlanInput } from "../src/index.ts";

const foods = [
  {
    id: "pre",
    name: "Pre-workout food",
    weighed: "raw",
    per100g: { kcal: 500, protein: 10, carbs: 100, fat: 5, fiber: 10 },
  },
  {
    id: "post",
    name: "Post-workout food",
    weighed: "raw",
    per100g: { kcal: 500, protein: 50, carbs: 40, fat: 10, fiber: 5 },
  },
  {
    id: "main",
    name: "Main food",
    weighed: "raw",
    per100g: { kcal: 500, protein: 50, carbs: 40, fat: 10, fiber: 5 },
  },
  {
    id: "unit",
    name: "Unit food",
    weighed: "each",
    unitG: 50,
    per100g: { kcal: 500, protein: 50, carbs: 40, fat: 10, fiber: 5 },
  },
];

const meals = [
  { id: "pre-meal", name: "Pre meal", items: [{ food: "pre", g: 100 }] },
  { id: "post-meal", name: "Post meal", items: [{ food: "post", g: 100 }] },
  { id: "main-a", name: "Main A", items: [{ food: "main", g: 100 }] },
  { id: "main-b", name: "Main B", items: [{ food: "unit", count: 2 }] },
  { id: "main-c", name: "Main C", items: [{ food: "main", g: 100 }] },
];

const preferences = {
  timezone: "America/Los_Angeles",
  preferredStores: ["costco", "trader-joes"],
  nutrition: {
    mealsPerDay: 3,
    calorieTolerance: 50,
    fiberFloorG: 10,
    repeatPenalty: 1,
    proteinUpperMultiplier: 2,
    requiredTrainingMeals: ["pre-meal", "post-meal"],
    restDayExcludedMeals: ["pre-meal", "post-meal"],
  },
  training: {
    split: ["push", "pull", "legs"],
    weeklyPattern: [true, true, false, false, false, false, false],
    preferredStart: "17:00",
    alternateStarts: ["12:00", "18:30"],
    durationMin: 60,
    calendarBufferMin: 30,
  },
  mealTiming: {
    trainingBaseTimes: ["09:00"],
    restTimes: ["09:00", "13:00", "19:00"],
    preWorkoutMinutes: 75,
    postWorkoutMinutes: 15,
    eventDurationMin: 30,
  },
  grocery: {
    inventoryMaxAgeDays: 2,
    untrustedNotePatterns: ["unverified"],
    priceMaxAgeDays: 30,
    requireAllergenVerified: true,
    allowUnknownNutrition: false,
    substitutions: "none",
  },
};

const products = [
  {
    id: "costco-pre",
    food: "pre",
    store: "costco",
    name: "Exact pre food",
    packageG: 250,
    priceUsd: 3.33,
    priceAsOf: "2026-08-02",
    fulfillment: "delivery",
    priority: 1,
    allergenStatus: "verified",
    nutritionMatch: "exact-label",
    substitutionPolicy: "none",
  },
  {
    id: "tj-post",
    food: "post",
    store: "trader-joes",
    name: "Post food",
    packageG: 400,
    priceUsd: 2.55,
    priceAsOf: "2026-08-02",
    fulfillment: "in-store",
    priority: 1,
    allergenStatus: "verified",
    nutritionMatch: "generic-food",
    substitutionPolicy: "none",
  },
  {
    id: "tj-main",
    food: "main",
    store: "trader-joes",
    name: "Main food",
    packageG: 300,
    priceUsd: 1.11,
    priceAsOf: "2026-08-02",
    fulfillment: "in-store",
    priority: 1,
    allergenStatus: "verified",
    nutritionMatch: "generic-food",
    substitutionPolicy: "none",
  },
  {
    id: "unsafe-unit",
    food: "unit",
    store: "trader-joes",
    name: "Unreviewed unit food",
    packageUnits: 6,
    priceUsd: 1,
    fulfillment: "in-store",
    priority: 1,
    allergenStatus: "needs-review",
    nutritionMatch: "generic-food",
    substitutionPolicy: "none",
  },
];

function input(overrides: Partial<WeeklyPlanInput> = {}): WeeklyPlanInput {
  return {
    weekStart: "2026-08-03",
    generatedAt: "2026-08-02T12:00:00.000Z",
    targetKcal: 1500,
    proteinG: 100,
    lastWorkoutType: "legs",
    foods,
    meals,
    inventory: [],
    products,
    preferences,
    ...overrides,
  };
}

describe("weekly planner", () => {
  test("is deterministic and continues the lift split after the last workout", () => {
    const first = createWeeklyPlan(input());
    const second = createWeeklyPlan(input());

    expect(first).toEqual(second);
    expect(first.training.sessions).toBe(2);
    expect(first.days.map((day) => day.training?.type ?? null)).toEqual([
      "push",
      "pull",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(first.calendar.events).toHaveLength(23);
    expect(first.calendar.events.every((event) => event.status === "proposed")).toBe(true);
    expect(first.externalActions.costcoDoorDash).toContain("explicit approval");
  });

  test("uses fresh trusted inventory, ignores unverified inventory, and rounds money to cents", () => {
    const safeUnitProduct = {
      id: "safe-unit",
      food: "unit",
      store: "trader-joes",
      name: "Reviewed unit food",
      packageUnits: 6,
      priceUsd: 1.23,
      priceAsOf: "2026-08-02",
      fulfillment: "in-store",
      priority: 1,
      allergenStatus: "verified",
      nutritionMatch: "exact-label",
      substitutionPolicy: "none",
    };
    const plan = createWeeklyPlan(
      input({
        products: [...products, safeUnitProduct],
        inventory: [
          { food: "pre", g: 100, asOf: "2026-08-02" },
          { food: "post", g: 1000, asOf: "2026-08-02", note: "unverified freezer estimate" },
        ],
      }),
    );

    const pre = plan.grocery.stores.flatMap((store) => store.items).find((item) => item.food === "pre");
    const post = plan.grocery.stores.flatMap((store) => store.items).find((item) => item.food === "post");
    expect(pre?.trustedInventoryG).toBe(100);
    expect(pre?.packages).toBe(1);
    expect(pre?.estimatedCostUsd).toBe(3.33);
    expect(post?.trustedInventoryG).toBe(0);
    expect(plan.warnings.some((warning) => warning.includes("marked unverified"))).toBe(true);
    expect(plan.grocery.estimatedTotalUsd).toBe(12.78);
  });

  test("moves a lift to the first conflict-free alternate", () => {
    const plan = createWeeklyPlan(
      input({
        busy: [{ date: "2026-08-03", start: "16:45", end: "18:15", title: "Busy" }],
      }),
    );

    expect(plan.days[0]!.training?.start).toBe("12:00");
    expect(plan.calendar.busyContextProvided).toBe(true);
  });

  test("never substitutes a product that has not passed the allergy gate", () => {
    const plan = createWeeklyPlan(input());
    const unit = plan.grocery.unresolved.find((item) => item.food === "unit");

    expect(unit?.reason).toContain("allergy-verified");
    expect(plan.grocery.stores.flatMap((store) => store.items).some((item) => item.productId === "unsafe-unit")).toBe(
      false,
    );
    expect(plan.grocery.substitutions).toBe("none");
    expect(plan.grocery.estimatedTotalUsd).toBeNull();
  });

  test("includes explicitly planned extra days in grocery quantities without adding calendar events", () => {
    const baseline = createWeeklyPlan(input());
    const plan = createWeeklyPlan(
      input({ extraDays: [{ date: "2026-08-02", label: "Sunday", meals: ["pre-meal"] }] }),
    );

    const baselinePre = baseline.grocery.stores.flatMap((store) => store.items).find((item) => item.food === "pre");
    const pre = plan.grocery.stores.flatMap((store) => store.items).find((item) => item.food === "pre");
    expect(plan.extraDays[0]?.totals.kcal).toBe(500);
    expect(pre?.requiredG).toBe((baselinePre?.requiredG ?? 0) + 100);
    expect(plan.calendar.events).toHaveLength(baseline.calendar.events.length);
  });
});
