import { z } from "zod";

const isoDateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const localTimeZ = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const nutrientRecordZ = z.record(z.number().finite().nonnegative());

export const planningFoodZ = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    weighed: z.enum(["raw", "cooked", "dry", "each"]).optional(),
    unitG: z.number().positive().optional(),
    per100g: nutrientRecordZ,
  })
  .passthrough()
  .superRefine((food, ctx) => {
    for (const nutrient of ["kcal", "protein", "carbs", "fat"]) {
      if (food.per100g[nutrient] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `missing per100g.${nutrient}`, path: ["per100g", nutrient] });
      }
    }
    if (food.weighed === "each" && food.unitG === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each foods require unitG", path: ["unitG"] });
    }
  });

const mealItemZ = z
  .object({
    food: z.string().min(1),
    g: z.number().positive().optional(),
    count: z.number().positive().optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.g === undefined) === (item.count === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provide exactly one of g or count" });
    }
  });

export const planningMealZ = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    items: z.array(mealItemZ).min(1),
    notes: z.string().optional(),
  })
  .passthrough();

export const planningInventoryZ = z.array(
  z
    .object({
      food: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      g: z.number().nonnegative().optional(),
      count: z.number().nonnegative().optional(),
      asOf: isoDateZ,
      note: z.string().optional(),
    })
    .passthrough()
    .refine((item) => item.food !== undefined || item.name !== undefined, "inventory item needs food or name"),
);

export const groceryStoreZ = z.enum(["costco", "trader-joes"]);

export const planningProductZ = z
  .object({
    id: z.string().min(1),
    food: z.string().min(1),
    store: groceryStoreZ,
    name: z.string().min(1),
    packageG: z.number().positive().optional(),
    packageUnits: z.number().int().positive().optional(),
    storeProductId: z.string().min(1).optional(),
    doorDashItemId: z.string().min(1).optional(),
    url: z.string().url().optional(),
    priceUsd: z.number().nonnegative().optional(),
    priceAsOf: isoDateZ.optional(),
    fulfillment: z.enum(["delivery", "in-store"]),
    priority: z.number().int().nonnegative(),
    allergenStatus: z.enum(["verified", "needs-review"]),
    nutritionMatch: z.enum(["exact-label", "generic-food", "unknown"]),
    labelChecked: isoDateZ.optional(),
    substitutionPolicy: z.literal("none"),
    notes: z.string().optional(),
  })
  .passthrough()
  .refine((product) => product.packageG !== undefined || product.packageUnits !== undefined, {
    message: "product needs packageG or packageUnits",
  });

export const planningPreferencesZ = z.object({
  timezone: z.string().min(1),
  preferredStores: z.array(groceryStoreZ).min(1),
  nutrition: z.object({
    mealsPerDay: z.number().int().min(3).max(7),
    calorieTolerance: z.number().positive(),
    fiberFloorG: z.number().nonnegative(),
    repeatPenalty: z.number().nonnegative(),
    proteinUpperMultiplier: z.number().min(1),
    requiredTrainingMeals: z.array(z.string().min(1)),
    restDayExcludedMeals: z.array(z.string().min(1)),
  }),
  training: z
    .object({
      split: z.array(z.string().min(1)).min(1),
      weeklyPattern: z.array(z.boolean()).length(7),
      preferredStart: localTimeZ,
      alternateStarts: z.array(localTimeZ),
      durationMin: z.number().int().positive(),
      calendarBufferMin: z.number().int().nonnegative(),
    })
    .refine((training) => training.weeklyPattern.some(Boolean), "weeklyPattern needs a training day"),
  mealTiming: z.object({
    trainingBaseTimes: z.array(localTimeZ),
    restTimes: z.array(localTimeZ),
    preWorkoutMinutes: z.number().int().nonnegative(),
    postWorkoutMinutes: z.number().int().nonnegative(),
    eventDurationMin: z.number().int().positive(),
  }),
  grocery: z.object({
    inventoryMaxAgeDays: z.number().int().nonnegative(),
    untrustedNotePatterns: z.array(z.string().min(1)),
    priceMaxAgeDays: z.number().int().nonnegative(),
    requireAllergenVerified: z.boolean(),
    allowUnknownNutrition: z.boolean(),
    substitutions: z.literal("none"),
  }),
});

export const planningBusyIntervalZ = z.object({
  date: isoDateZ,
  start: localTimeZ,
  end: localTimeZ,
  title: z.string().optional(),
});

export const planningExtraDayZ = z.object({
  date: isoDateZ,
  label: z.string().min(1).optional(),
  meals: z.array(z.string().min(1)).min(1),
});

export type PlanningFood = z.infer<typeof planningFoodZ>;
export type PlanningMeal = z.infer<typeof planningMealZ>;
export type PlanningInventory = z.infer<typeof planningInventoryZ>;
export type PlanningProduct = z.infer<typeof planningProductZ>;
export type PlanningPreferences = z.infer<typeof planningPreferencesZ>;
export type PlanningBusyInterval = z.infer<typeof planningBusyIntervalZ>;
export type PlanningExtraDay = z.infer<typeof planningExtraDayZ>;

export interface WeeklyPlanInput {
  weekStart: string;
  generatedAt: string;
  targetKcal: number;
  proteinG: number;
  currentWeightLb?: number | null;
  nutritionMethod?: string;
  lastWorkoutType?: string | null;
  foods: unknown;
  meals: unknown;
  inventory: unknown;
  products: unknown;
  preferences: unknown;
  busy?: unknown;
  extraDays?: unknown;
}

const DAY_MS = 86_400_000;
const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function parseDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateDiffDays(earlier: string, later: string): number {
  return Math.round((parseDate(later).getTime() - parseDate(earlier).getTime()) / DAY_MS);
}

function isoWeekId(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}

function fromMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundNutrients(nutrients: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(nutrients).map(([key, value]) => [key, round1(value)]));
}

function sumNutrients(rows: Record<string, number>[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}

export function mealNutrition(meal: PlanningMeal, foods: Map<string, PlanningFood>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of meal.items) {
    const food = foods.get(item.food);
    if (!food) throw new Error(`Unknown food ${item.food} in meal ${meal.id}`);
    const grams = item.g ?? item.count! * food.unitG!;
    for (const [key, per100g] of Object.entries(food.per100g)) {
      totals[key] = (totals[key] ?? 0) + (per100g * grams) / 100;
    }
  }
  return totals;
}

function combinations<T>(values: T[], count: number): T[][] {
  if (count === 0) return [[]];
  const result: T[][] = [];
  const walk = (start: number, chosen: T[]) => {
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (let i = start; i <= values.length - (count - chosen.length); i++) {
      chosen.push(values[i]!);
      walk(i + 1, chosen);
      chosen.pop();
    }
  };
  walk(0, []);
  return result;
}

interface MealChoice {
  meal: PlanningMeal;
  nutrients: Record<string, number>;
}

function selectMeals(
  training: boolean,
  meals: PlanningMeal[],
  nutritionByMeal: Map<string, Record<string, number>>,
  preferences: PlanningPreferences,
  targetKcal: number,
  proteinG: number,
  usage: Map<string, number>,
): MealChoice[] {
  const requiredIds = training ? preferences.nutrition.requiredTrainingMeals : [];
  const required = requiredIds.map((id) => {
    const meal = meals.find((candidate) => candidate.id === id);
    if (!meal) throw new Error(`Required training meal ${id} does not exist`);
    return meal;
  });
  if (required.length > preferences.nutrition.mealsPerDay) throw new Error("More required meals than mealsPerDay");

  const excluded = new Set(training ? requiredIds : preferences.nutrition.restDayExcludedMeals);
  const optional = meals.filter((meal) => !excluded.has(meal.id));
  const needed = preferences.nutrition.mealsPerDay - required.length;
  if (optional.length < needed) throw new Error(`Need ${needed} optional meals but only ${optional.length} are available`);

  const candidates = combinations(optional, needed).map((chosen) => {
    const selected = [...required, ...chosen];
    const totals = sumNutrients(selected.map((meal) => nutritionByMeal.get(meal.id)!));
    const kcal = totals.kcal ?? 0;
    const protein = totals.protein ?? 0;
    const fiber = totals.fiber ?? 0;
    const proteinUpper = proteinG * preferences.nutrition.proteinUpperMultiplier;
    const repeatCost = selected.reduce(
      (cost, meal) => cost + (usage.get(meal.id) ?? 0) * preferences.nutrition.repeatPenalty,
      0,
    );
    const score =
      Math.abs(kcal - targetKcal) +
      Math.max(0, proteinG - protein) * 25 +
      Math.max(0, preferences.nutrition.fiberFloorG - fiber) * 12 +
      Math.max(0, protein - proteinUpper) * 0.75 +
      repeatCost;
    return { selected, score, tie: selected.map((meal) => meal.id).sort().join("|") };
  });

  candidates.sort((a, b) => a.score - b.score || a.tie.localeCompare(b.tie));
  const winner = candidates[0];
  if (!winner) throw new Error("No valid meal combination found");
  for (const meal of winner.selected) usage.set(meal.id, (usage.get(meal.id) ?? 0) + 1);
  return winner.selected.map((meal) => ({ meal, nutrients: nutritionByMeal.get(meal.id)! }));
}

function intervalsOverlap(startA: number, endA: number, startB: number, endB: number, buffer: number): boolean {
  return startA - buffer < endB && endA + buffer > startB;
}

function selectLiftTime(
  date: string,
  preferences: PlanningPreferences,
  busy: PlanningBusyInterval[],
): { start: string; end: string; warning?: string } {
  const candidateTimes = [preferences.training.preferredStart, ...preferences.training.alternateStarts].filter(
    (time, index, all) => all.indexOf(time) === index,
  );
  const dayBusy = busy.filter((interval) => interval.date === date);
  for (const start of candidateTimes) {
    const startMin = toMinutes(start);
    const endMin = startMin + preferences.training.durationMin;
    const conflict = dayBusy.some((interval) =>
      intervalsOverlap(
        startMin,
        endMin,
        toMinutes(interval.start),
        toMinutes(interval.end),
        preferences.training.calendarBufferMin,
      ),
    );
    if (!conflict) return { start, end: fromMinutes(endMin) };
  }
  const start = preferences.training.preferredStart;
  return {
    start,
    end: fromMinutes(toMinutes(start) + preferences.training.durationMin),
    warning: `No conflict-free lift slot found on ${date}; preferred time retained for review`,
  };
}

function classifyMeal(meal: PlanningMeal): number {
  const text = `${meal.id} ${meal.name}`.toLowerCase();
  if (text.includes("scramble") || text.includes("yogurt bowl")) return 0;
  if (text.includes("nightcap")) return 3;
  if (text.includes("dinner") || text.includes("plate") || text.includes("melt")) return 2;
  return 1;
}

function scheduleMeals(
  date: string,
  selected: MealChoice[],
  training: { start: string; end: string } | null,
  preferences: PlanningPreferences,
) {
  const preId = preferences.nutrition.requiredTrainingMeals[0];
  const postId = preferences.nutrition.requiredTrainingMeals[1];
  const fixed = new Map<string, string>();
  if (training && preId) fixed.set(preId, fromMinutes(toMinutes(training.start) - preferences.mealTiming.preWorkoutMinutes));
  if (training && postId) fixed.set(postId, fromMinutes(toMinutes(training.end) + preferences.mealTiming.postWorkoutMinutes));

  const flexible = selected
    .filter(({ meal }) => !fixed.has(meal.id))
    .sort((a, b) => classifyMeal(a.meal) - classifyMeal(b.meal) || a.meal.id.localeCompare(b.meal.id));
  const availableTimes = training ? preferences.mealTiming.trainingBaseTimes : preferences.mealTiming.restTimes;
  if (availableTimes.length < flexible.length) {
    throw new Error(`Need ${flexible.length} meal times but only ${availableTimes.length} are configured`);
  }

  const times = new Map<string, string>();
  for (let i = 0; i < flexible.length; i++) times.set(flexible[i]!.meal.id, availableTimes[i]!);
  for (const [id, time] of fixed) times.set(id, time);

  return selected
    .map(({ meal, nutrients }) => ({
      id: meal.id,
      name: meal.name,
      time: times.get(meal.id)!,
      startLocal: `${date}T${times.get(meal.id)!}:00`,
      endLocal: `${date}T${fromMinutes(toMinutes(times.get(meal.id)!) + preferences.mealTiming.eventDurationMin)}:00`,
      nutrients: roundNutrients(nutrients),
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function productPackageG(product: PlanningProduct, food: PlanningFood): number | null {
  if (product.packageG !== undefined) return product.packageG;
  if (product.packageUnits !== undefined && food.unitG !== undefined) return product.packageUnits * food.unitG;
  return null;
}

function aggregateFoodNeeds(days: Array<{ meals: Array<{ id: string }> }>, meals: Map<string, PlanningMeal>, foods: Map<string, PlanningFood>) {
  const required = new Map<string, number>();
  for (const day of days) {
    for (const plannedMeal of day.meals) {
      const meal = meals.get(plannedMeal.id)!;
      for (const item of meal.items) {
        const food = foods.get(item.food)!;
        const grams = item.g ?? item.count! * food.unitG!;
        required.set(item.food, (required.get(item.food) ?? 0) + grams);
      }
    }
  }
  return required;
}

function buildGroceryPlan(
  weekStart: string,
  days: Array<{ meals: Array<{ id: string }> }>,
  foods: Map<string, PlanningFood>,
  meals: Map<string, PlanningMeal>,
  inventory: PlanningInventory,
  products: PlanningProduct[],
  preferences: PlanningPreferences,
) {
  const required = aggregateFoodNeeds(days, meals, foods);
  const trustedInventory = new Map<string, number>();
  const inventoryWarnings: string[] = [];
  for (const item of inventory) {
    if (!item.food || !required.has(item.food)) continue;
    const food = foods.get(item.food);
    if (!food) continue;
    const age = dateDiffDays(item.asOf, weekStart);
    const note = item.note ?? "";
    const pattern = preferences.grocery.untrustedNotePatterns.find((candidate) =>
      note.toLowerCase().includes(candidate.toLowerCase()),
    );
    const grams = item.g ?? (item.count !== undefined && food.unitG !== undefined ? item.count * food.unitG : undefined);
    if (grams === undefined || age > preferences.grocery.inventoryMaxAgeDays || pattern !== undefined) {
      inventoryWarnings.push(
        `${food.name}: inventory ignored (${grams === undefined ? "no quantity" : pattern ? `marked ${pattern}` : `${age} days old`})`,
      );
      continue;
    }
    trustedInventory.set(item.food, (trustedInventory.get(item.food) ?? 0) + grams);
  }

  const storeRank = new Map(preferences.preferredStores.map((store, index) => [store, index]));
  const storeItems = new Map<string, any[]>();
  const unresolved: any[] = [];
  const coveredByInventory: any[] = [];
  const warnings = [...inventoryWarnings];

  for (const [foodId, requiredG] of [...required.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const food = foods.get(foodId)!;
    const availableInventoryG = trustedInventory.get(foodId) ?? 0;
    const inventoryG = Math.min(requiredG, availableInventoryG);
    const shortfallG = Math.max(0, requiredG - inventoryG);
    if (shortfallG <= 0.05) {
      coveredByInventory.push({
        food: foodId,
        name: food.name,
        requiredG: round1(requiredG),
        trustedInventoryG: round1(inventoryG),
        availableInventoryG: round1(availableInventoryG),
      });
      continue;
    }

    const candidates = products
      .filter((product) => product.food === foodId)
      .filter((product) => !preferences.grocery.requireAllergenVerified || product.allergenStatus === "verified")
      .filter((product) => preferences.grocery.allowUnknownNutrition || product.nutritionMatch !== "unknown")
      .filter((product) => productPackageG(product, food) !== null)
      .sort(
        (a, b) =>
          (storeRank.get(a.store) ?? 999) - (storeRank.get(b.store) ?? 999) ||
          a.priority - b.priority ||
          a.id.localeCompare(b.id),
      );
    const product = candidates[0];
    if (!product) {
      unresolved.push({
        food: foodId,
        name: food.name,
        requiredG: round1(requiredG),
        trustedInventoryG: round1(inventoryG),
        shortfallG: round1(shortfallG),
        reason: "No allergy-verified product with a known package size",
      });
      continue;
    }

    const packageG = productPackageG(product, food)!;
    const packages = Math.ceil(shortfallG / packageG);
    const estimatedCostUsd = product.priceUsd === undefined ? null : roundMoney(product.priceUsd * packages);
    const item = {
      productId: product.id,
      food: foodId,
      name: product.name,
      store: product.store,
      fulfillment: product.fulfillment,
      requiredG: round1(requiredG),
      trustedInventoryG: round1(inventoryG),
      shortfallG: round1(shortfallG),
      packageG: round1(packageG),
      packageUnits: product.packageUnits ?? null,
      packages,
      estimatedCostUsd,
      storeProductId: product.storeProductId ?? null,
      doorDashItemId: product.doorDashItemId ?? null,
      url: product.url ?? null,
      nutritionMatch: product.nutritionMatch,
      substitutionPolicy: product.substitutionPolicy,
    };
    const items = storeItems.get(product.store) ?? [];
    items.push(item);
    storeItems.set(product.store, items);

    if (product.nutritionMatch !== "exact-label") {
      warnings.push(`${product.name}: product is mapped to ${product.nutritionMatch}, not a current physical label`);
    }
    if (product.priceAsOf && dateDiffDays(product.priceAsOf, weekStart) > preferences.grocery.priceMaxAgeDays) {
      warnings.push(`${product.name}: price is older than ${preferences.grocery.priceMaxAgeDays} days`);
    }
  }

  const stores = preferences.preferredStores
    .filter((store) => storeItems.has(store))
    .map((store) => {
      const items = storeItems.get(store)!;
      const knownCosts = items.map((item) => item.estimatedCostUsd).filter((cost): cost is number => cost !== null);
      return {
        store,
        fulfillment: store === "costco" ? "delivery-capable" : "manual-shopping-list",
        estimatedSubtotalUsd:
          knownCosts.length === items.length ? roundMoney(knownCosts.reduce((sum, cost) => sum + cost, 0)) : null,
        items,
      };
    });
  const knownSubtotals = stores.map((store) => store.estimatedSubtotalUsd).filter((cost): cost is number => cost !== null);

  return {
    substitutions: "none" as const,
    stores,
    coveredByInventory,
    unresolved,
    estimatedTotalUsd:
      unresolved.length === 0 && knownSubtotals.length === stores.length
        ? roundMoney(knownSubtotals.reduce((sum, cost) => sum + cost, 0))
        : null,
    warnings,
  };
}

export function createWeeklyPlan(input: WeeklyPlanInput) {
  const weekStart = isoDateZ.parse(input.weekStart);
  if (parseDate(weekStart).getUTCDay() !== 1) throw new Error(`weekStart must be a Monday: ${weekStart}`);
  if (!Number.isFinite(input.targetKcal) || input.targetKcal <= 0) throw new Error("targetKcal must be positive");
  if (!Number.isFinite(input.proteinG) || input.proteinG <= 0) throw new Error("proteinG must be positive");

  const foodsList = z.array(planningFoodZ).parse(input.foods);
  const mealsList = z.array(planningMealZ).parse(input.meals);
  const inventory = planningInventoryZ.parse(input.inventory);
  const products = z.array(planningProductZ).parse(input.products);
  const preferences = planningPreferencesZ.parse(input.preferences);
  const busy = z.array(planningBusyIntervalZ).parse(input.busy ?? []);
  const rawExtraDays = z.array(planningExtraDayZ).parse(input.extraDays ?? []);
  const foods = new Map(foodsList.map((food) => [food.id, food]));
  const meals = new Map(mealsList.map((meal) => [meal.id, meal]));
  if (foods.size !== foodsList.length) throw new Error("Duplicate food ids");
  if (meals.size !== mealsList.length) throw new Error("Duplicate meal ids");
  for (const product of products) {
    if (!foods.has(product.food)) throw new Error(`Product ${product.id} references unknown food ${product.food}`);
  }
  for (const extraDay of rawExtraDays) {
    for (const mealId of extraDay.meals) {
      if (!meals.has(mealId)) throw new Error(`Extra day ${extraDay.date} references unknown meal ${mealId}`);
    }
  }

  const nutritionByMeal = new Map(mealsList.map((meal) => [meal.id, mealNutrition(meal, foods)]));
  const usage = new Map<string, number>();
  const warnings: string[] = [];
  const split = preferences.training.split;
  const lastIx = input.lastWorkoutType ? split.indexOf(input.lastWorkoutType) : -1;
  let nextSplitIx = lastIx >= 0 ? (lastIx + 1) % split.length : 0;

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    const trainingDay = preferences.training.weeklyPattern[index]!;
    let training: { type: string; start: string; end: string; startLocal: string; endLocal: string; durationMin: number } | null = null;
    if (trainingDay) {
      const time = selectLiftTime(date, preferences, busy);
      if (time.warning) warnings.push(time.warning);
      const type = split[nextSplitIx]!;
      nextSplitIx = (nextSplitIx + 1) % split.length;
      training = {
        type,
        start: time.start,
        end: time.end,
        startLocal: `${date}T${time.start}:00`,
        endLocal: `${date}T${time.end}:00`,
        durationMin: preferences.training.durationMin,
      };
    }

    const selected = selectMeals(
      trainingDay,
      mealsList,
      nutritionByMeal,
      preferences,
      input.targetKcal,
      input.proteinG,
      usage,
    );
    const plannedMeals = scheduleMeals(date, selected, training, preferences);
    const totals = roundNutrients(sumNutrients(selected.map((choice) => choice.nutrients)));
    const dayWarnings: string[] = [];
    if (Math.abs((totals.kcal ?? 0) - input.targetKcal) > preferences.nutrition.calorieTolerance) {
      dayWarnings.push(`Calories differ from target by ${round1((totals.kcal ?? 0) - input.targetKcal)} kcal`);
    }
    if ((totals.protein ?? 0) < input.proteinG) dayWarnings.push(`Protein is below target by ${round1(input.proteinG - (totals.protein ?? 0))} g`);
    if ((totals.fiber ?? 0) < preferences.nutrition.fiberFloorG) {
      dayWarnings.push(`Fiber is below floor by ${round1(preferences.nutrition.fiberFloorG - (totals.fiber ?? 0))} g`);
    }
    return {
      date,
      day: dayNames[parseDate(date).getUTCDay()],
      training,
      meals: plannedMeals,
      totals,
      targetDelta: {
        kcal: round1((totals.kcal ?? 0) - input.targetKcal),
        proteinG: round1((totals.protein ?? 0) - input.proteinG),
        fiberG: round1((totals.fiber ?? 0) - preferences.nutrition.fiberFloorG),
      },
      warnings: dayWarnings,
    };
  });

  const extraDays = rawExtraDays.map((extraDay) => {
    const plannedMeals = extraDay.meals.map((mealId) => {
      const meal = meals.get(mealId)!;
      return {
        id: meal.id,
        name: meal.name,
        nutrients: roundNutrients(nutritionByMeal.get(meal.id)!),
      };
    });
    return {
      date: extraDay.date,
      day: dayNames[parseDate(extraDay.date).getUTCDay()],
      label: extraDay.label ?? null,
      meals: plannedMeals,
      totals: roundNutrients(sumNutrients(plannedMeals.map((meal) => meal.nutrients))),
    };
  });

  const calendar = days.flatMap((day) => {
    const events: any[] = day.meals.map((meal, index) => ({
      stableId: `baymax:${isoWeekId(weekStart)}:${day.date}:meal:${index + 1}`,
      type: "meal",
      title: meal.name,
      startLocal: meal.startLocal,
      endLocal: meal.endLocal,
      timezone: preferences.timezone,
      description: `${meal.id} — ${meal.nutrients.kcal ?? 0} kcal, ${meal.nutrients.protein ?? 0}g protein`,
      status: "proposed",
    }));
    if (day.training) {
      events.push({
        stableId: `baymax:${isoWeekId(weekStart)}:${day.date}:lift`,
        type: "lift",
        title: `${day.training.type[0]!.toUpperCase()}${day.training.type.slice(1)} workout`,
        startLocal: day.training.startLocal,
        endLocal: day.training.endLocal,
        timezone: preferences.timezone,
        description: `Baymax ${day.training.type} session; generated from the current split rotation`,
        status: "proposed",
      });
    }
    return events;
  });

  const grocery = buildGroceryPlan(weekStart, [...extraDays, ...days], foods, meals, inventory, products, preferences);
  warnings.push(...grocery.warnings);
  if (grocery.unresolved.length) warnings.push(`${grocery.unresolved.length} grocery items need an exact product mapping`);

  return {
    version: 1,
    id: isoWeekId(weekStart),
    mode: "dry-run" as const,
    generatedAt: input.generatedAt,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    timezone: preferences.timezone,
    healthSnapshot: {
      targetKcal: input.targetKcal,
      proteinG: input.proteinG,
      fiberFloorG: preferences.nutrition.fiberFloorG,
      currentWeightLb: input.currentWeightLb ?? null,
      nutritionMethod: input.nutritionMethod ?? null,
    },
    training: {
      lastCompletedType: input.lastWorkoutType ?? null,
      split,
      sessions: days.filter((day) => day.training !== null).length,
    },
    extraDays,
    days,
    grocery,
    calendar: {
      status: "proposed" as const,
      busyContextProvided: busy.length > 0,
      events: calendar,
    },
    externalActions: {
      googleCalendar: "proposal-only" as const,
      costcoDoorDash: "shopping-list-only; checkout requires preview and explicit approval" as const,
      traderJoes: "manual-shopping-list" as const,
    },
    warnings: [...new Set(warnings)],
  };
}
