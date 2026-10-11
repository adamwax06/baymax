#!/usr/bin/env bun
// Meal plan (docs/kitchen.md). Days = fixed slots (breakfast, pre-lift toast,
// post-lift smoothie or nightcap) + two mains picked at random under the
// AGENTS.md calendar rules, preferring food already on hand (soonest use-by
// first). The plan lives in data/mealplan.json; `eat` writes the slot's exact
// items into nutrition.json, which is what subtracts them from the kitchen.
//
// usage: bun run plan draft [--from YYYY-MM-DD] [--days 3] [--rest d1,d2] [--seed N] [--write]
//        bun run plan show|check [--from d]
//        bun run plan swap <date> <slot> <mealId> | scale <date> <slot> <food> <g> | time <date> <slot> <HH:MM>
//        bun run plan eat <date> <slot|mealId> [--fraction 0.5] [--set food=g ...] [--add food=g ...] [--note ..]
//        bun run plan skip <date> <slot> | groceries [--from d] | calendar <date> [--json] | gcal <date> <slot> <eventId>

import { join } from "node:path";
import { type Food, type Item, type Lot, type Meal, compute, grams, load, macro, now, today, totals } from "./kitchen";

export type Slot = { slot: string; meal: string; items: Item[]; time: string; status: "planned" | "eaten" | "skipped"; fraction?: number; gcal?: string };
export type PlanDay = { date: string; lift: boolean; slots: Slot[] };
type Opts = { dates: string[]; rest: Set<string>; kcal: number; protein: number; rand: () => number; onHand?: Map<string, number>; expiring?: Set<string>; yesterday?: string[] };

const TIMES = {
  lift: { breakfast: "09:30", lunch: "12:30", "pre-lift": "14:45", "post-lift": "17:45", dinner: "19:30" },
  rest: { breakfast: "09:30", lunch: "12:30", afternoon: "15:30", dinner: "19:00", nightcap: "21:30" },
} as Record<string, Record<string, string>>;
const YOGURT_CAP_G = 450; // ~400g/day by the 10:1 rule, with slack for upsized nightcaps

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ (t + Math.imul(t ^ (t >>> 14), 47 | t));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function planDays(meals: Meal[], foods: Map<string, Food>, opts: Opts): PlanDay[] {
  const one = (slot: string) => meals.find((m) => m.slot === slot)!;
  const mains = meals.filter((m) => m.slot === "main");
  const stock = new Map(opts.onHand ?? []);
  const used = new Map<string, number>();
  const days: PlanDay[] = [];
  let yesterday = new Set(opts.yesterday ?? []);
  // Kitchen first: the share of a meal's protein already on hand (so the meat counts, not the
  // tortillas) outweighs variety (rand <= 3); anything about to expire outweighs all but the hard rules.
  const pantryFit = (m: Meal) => {
    const p = (it: Item, g: number) => ((foods.get(it.food)!.per100g.protein ?? 0) * g) / 100;
    const need = m.items.reduce((s, it) => s + p(it, grams(it, foods)), 0);
    const have = m.items.reduce((s, it) => s + p(it, Math.min(grams(it, foods), Math.max(0, stock.get(it.food) ?? 0))), 0);
    return (need ? 6 * (have / need) : 0) + (m.items.some((it) => opts.expiring?.has(it.food) && (stock.get(it.food) ?? 0) > 0) ? 10 : 0);
  };

  for (const date of opts.dates) {
    const lift = !opts.rest.has(date);
    const fixed = [one("breakfast"), one("pre-lift"), one(lift ? "post-lift" : "nightcap")];
    const fixedItems = fixed.flatMap((m) => m.items);
    let best: { score: number; pair: [Meal, Meal]; scale: number } | undefined;
    for (const a of mains)
      for (const b of mains) {
        if (a.id >= b.id || yesterday.has(a.id) || yesterday.has(b.id)) continue;
        if (a.meat && a.meat === b.meat) continue;
        const items = [...a.items, ...b.items];
        const k = macro([...fixedItems, ...items], foods, "kcal");
        const grainK = macro(items.filter((it) => foods.get(it.food)!.weighed === "dry"), foods, "kcal");
        // Flex rice/pasta toward the target, within 0.7x-1.4x of the recipe.
        const scale = grainK ? Math.min(1.4, Math.max(0.7, 1 + (opts.kcal - k) / grainK)) : 1;
        const p = macro([...fixedItems, ...items], foods, "protein");
        const score =
          Math.abs(k + grainK * (scale - 1) - opts.kcal) / 100 +
          Math.max(0, opts.protein - p) / 10 +
          2 * ((used.get(a.id) ?? 0) + (used.get(b.id) ?? 0)) +
          (a.try ? 1 : 0) + (b.try ? 1 : 0) -
          pantryFit(a) - pantryFit(b) +
          opts.rand() * 3;
        if (!best || score < best.score) best = { score, pair: [a, b], scale };
      }
    if (!best) throw new Error(`no valid mains for ${date}`);

    const scaled = (m: Meal) =>
      m.items.map((it) => (foods.get(it.food)!.weighed === "dry" && it.g ? { ...it, g: Math.round((it.g * best!.scale) / 10) * 10 } : it));
    // Bigger main at lunch: never leave the largest meal for last.
    const [lunch, dinner] = best.pair
      .map((m) => ({ meal: m.id, items: scaled(m) }))
      .sort((x, y) => macro(y.items, foods, "kcal") - macro(x.items, foods, "kcal"));
    const t = TIMES[lift ? "lift" : "rest"]!;
    const slot = (name: string, meal: string, items: Item[]): Slot => ({ slot: name, meal, items, time: t[name]!, status: "planned" });
    const slots = lift
      ? [slot("breakfast", fixed[0]!.id, fixed[0]!.items), slot("lunch", lunch!.meal, lunch!.items), slot("pre-lift", fixed[1]!.id, fixed[1]!.items),
         slot("post-lift", fixed[2]!.id, fixed[2]!.items), slot("dinner", dinner!.meal, dinner!.items)]
      : [slot("breakfast", fixed[0]!.id, fixed[0]!.items), slot("lunch", lunch!.meal, lunch!.items), slot("afternoon", fixed[1]!.id, fixed[1]!.items),
         slot("dinner", dinner!.meal, dinner!.items), slot("nightcap", fixed[2]!.id, fixed[2]!.items)];
    days.push({ date, lift, slots });
    for (const it of slots.flatMap((s) => s.items)) stock.set(it.food, (stock.get(it.food) ?? 0) - grams(it, foods));
    for (const m of best.pair) used.set(m.id, (used.get(m.id) ?? 0) + 1);
    yesterday = new Set(best.pair.map((m) => m.id));
  }
  return days;
}

const dayItems = (d: PlanDay) => d.slots.filter((s) => s.status !== "skipped").flatMap((s) => scaleItems(s.items, s.fraction ?? 1));
const scaleItems = (items: Item[], f: number) => (f === 1 ? items : items.map((it) => (it.g ? { ...it, g: Math.round(it.g * f) } : { ...it, count: (it.count ?? 0) * f })));

/** Rule check. Errors break AGENTS.md rules; warnings are macro/stock drift worth a look. */
export function check(days: PlanDay[], meals: Map<string, Meal>, foods: Map<string, Food>, opts: { kcal: number; protein: number; lots?: Lot[] }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  let prev: string[] = [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) {
    const mains = d.slots.filter((s) => s.status !== "skipped" && meals.get(s.meal)?.slot === "main");
    const meats = mains.map((s) => meals.get(s.meal)!.meat).filter(Boolean);
    if (new Set(meats).size < meats.length) errors.push(`${d.date}: same meat twice (${meats.join(", ")})`);
    for (const s of mains) if (prev.includes(s.meal)) errors.push(`${d.date}: ${s.meal} was also yesterday`);
    prev = mains.map((s) => s.meal);
    for (const s of d.slots) {
      if (!meals.has(s.meal)) errors.push(`${d.date} ${s.slot}: unknown meal ${s.meal}`);
      for (const it of s.items) {
        const f = foods.get(it.food);
        if (!f) errors.push(`${d.date} ${s.slot}: unknown food ${it.food}`);
        else if (!f.allergyChecked) errors.push(`${d.date} ${s.slot}: ${it.food} has never been allergy-checked`);
      }
    }
    const items = dayItems(d).filter((it) => foods.has(it.food));
    const yogurt = items.filter((it) => it.food.startsWith("greek-yogurt")).reduce((s, it) => s + grams(it, foods), 0);
    if (yogurt > YOGURT_CAP_G) warnings.push(`${d.date}: ${yogurt}g yogurt (cap ~400g)`);
    const k = macro(items, foods, "kcal");
    const p = macro(items, foods, "protein");
    if (Math.abs(k - opts.kcal) > 400) warnings.push(`${d.date}: ${Math.round(k)} kcal vs ${opts.kcal} target`);
    if (p < opts.protein - 15) warnings.push(`${d.date}: ${Math.round(p)}g protein vs ${opts.protein}g`);
  }
  // Every lot that expires inside the plan window should be eaten by then.
  if (opts.lots && sorted.length) {
    const last = sorted.at(-1)!.date;
    for (const l of opts.lots.filter((l) => l.useBy && l.useBy <= last && l.where !== "freezer")) {
      const eaten = sorted.filter((d) => d.date <= l.useBy!).flatMap(dayItems).filter((it) => it.food === l.food).reduce((s, it) => s + grams(it, foods), 0);
      if (eaten < l.g) warnings.push(`${l.food} (${l.g}g, ${l.where}) expires ${l.useBy} but the plan only uses ${Math.round(eaten)}g by then`);
    }
  }
  return { errors, warnings };
}

/** Plan need minus on hand. `tracked` = foods the kitchen has ever counted or bought; the rest are unknown, not out. */
export function groceries(days: PlanDay[], foods: Map<string, Food>, onHand: Map<string, number>, tracked: Set<string>) {
  const need = new Map<string, number>();
  for (const d of days) for (const s of d.slots.filter((s) => s.status === "planned")) for (const it of s.items) need.set(it.food, (need.get(it.food) ?? 0) + grams(it, foods));
  return [...need]
    .map(([id, g]) => {
      const f = foods.get(id)!;
      const short = Math.round(g - (onHand.get(id) ?? 0));
      return { id, name: f.name, tracked: tracked.has(id), need: Math.round(g), have: Math.round(onHand.get(id) ?? 0), buy: Math.max(0, short), packs: f.packageG && short > 0 ? Math.ceil(short / f.packageG) : undefined };
    })
    .filter((r) => r.buy > 0)
    .sort((a, b) => b.buy - a.buy);
}

/** Calendar events for one day, rendered from the plan (recipe, grams, 💊 on dinner, tonight's thaw line). */
export function calendar(days: PlanDay[], date: string, meals: Map<string, Meal>, foods: Map<string, Food>, lots: Lot[]) {
  const d = days.find((d) => d.date === date);
  if (!d) throw new Error(`no plan for ${date}`);
  const next = days.find((x) => x.date > date);
  const live = d.slots.filter((s) => s.status !== "skipped");
  const thaw: string[] = [];
  if (next) {
    const need = new Map<string, number>();
    for (const it of next.slots.filter((s) => s.status === "planned").flatMap((s) => s.items)) need.set(it.food, (need.get(it.food) ?? 0) + grams(it, foods));
    for (const [food, g] of need) {
      if (foods.get(food)!.shelfLife?.fromFrozen) continue;
      // Fridge/pantry stock left after today's still-planned meals eat from it.
      const later = d.slots.filter((s) => s.status === "planned").flatMap((s) => s.items).filter((it) => it.food === food).reduce((s, it) => s + grams(it, foods), 0);
      const thawed = lots.filter((l) => l.food === food && l.where !== "freezer").reduce((s, l) => s + l.g, 0) - later;
      const frozen = lots.filter((l) => l.food === food && l.where === "freezer").reduce((s, l) => s + l.g, 0);
      if (thawed < g && frozen > 0) thaw.push(`move ${Math.round(Math.min(frozen, g - thawed))}g ${foods.get(food)!.name} from the freezer to the fridge`);
    }
  }
  return live.map((s, i) => {
    const meal = meals.get(s.meal)!;
    const items = scaleItems(s.items, s.fraction ?? 1);
    const dinner = s.slot === "dinner";
    const lines = [
      `[baymax] ~${Math.round(macro(items, foods, "kcal"))} kcal / ${Math.round(macro(items, foods, "protein"))}P`,
      ...(dinner ? ["💊 TAKE WITH THIS MEAL: creatine 5g + vitamin D3 2,000 IU."] : []),
      ...items.map((it) => `• ${foods.get(it.food)!.name} — ${it.g ? `${it.g}g` : `${it.count}`}`),
      ...(meal.notes ? ["", meal.notes] : []),
      ...(i === live.length - 1 ? ["", `⚠️ BEFORE BED: ${thaw.length ? thaw.join("; ") : "nothing to thaw tonight"}.`] : []),
    ];
    const [h, m] = s.time.split(":").map(Number);
    const end = new Date(2000, 0, 1, h!, m! + 30).toTimeString().slice(0, 5);
    return { slot: s.slot, gcal: s.gcal, summary: `${meal.name}${dinner ? " + 💊 creatine & D3" : ""}`, start: `${date}T${s.time}:00`, end: `${date}T${end}:00`, description: lines.join("\n") };
  });
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const flags = (f: string) => {
    const out: string[] = [];
    for (let v = flag(f); v !== undefined; v = flag(f)) out.push(v);
    return out;
  };
  const { dir, foods, meals: mealList, events, nutrition } = await load();
  const meals = new Map(mealList.map((m) => [m.id, m]));
  const goals: any[] = await Bun.file(join(dir, "goals.json")).json().catch(() => []);
  const kcal = goals.find((g) => g.targetKcalOverride)?.targetKcalOverride ?? 3200;
  const protein = Number(flag("--protein") ?? 150);
  const planPath = join(dir, "mealplan.json");
  const plan: { days: PlanDay[] } = await Bun.file(planPath).json().catch(() => ({ days: [] }));
  const save = () => Bun.write(planPath, JSON.stringify({ days: plan.days.sort((a, b) => a.date.localeCompare(b.date)) }, null, 2) + "\n");
  const { lots } = compute(events, nutrition, foods);
  const onHand = totals(lots);
  const day = (date: string | undefined) => {
    const d = plan.days.find((d) => d.date === date);
    if (!d) throw new Error(`no plan for ${date}`);
    return d;
  };
  const slotOf = (d: PlanDay, name: string | undefined) => {
    const s = d.slots.find((s) => s.slot === name);
    if (!s) throw new Error(`${d.date} has no slot "${name}" (${d.slots.map((s) => s.slot).join(", ")})`);
    return s;
  };
  const pair = (s: string) => {
    const [food, g] = s.split("=");
    if (!foods.has(food!) || !(Number(g) > 0)) throw new Error(`bad food=g "${s}"`);
    return { food: food!, g: Number(g) };
  };
  const printDay = (d: PlanDay) => {
    const items = dayItems(d);
    console.log(`\n${d.date} (${d.lift ? "lift" : "rest"}) ${Math.round(macro(items, foods, "kcal"))} kcal / ${Math.round(macro(items, foods, "protein"))}P`);
    for (const s of d.slots) {
      const m = meals.get(s.meal);
      const tag = s.status === "planned" ? "" : ` [${s.status}${s.fraction && s.fraction !== 1 ? ` ${s.fraction}` : ""}]`;
      console.log(`  ${s.time} ${s.slot.padEnd(10)} ${m?.name ?? s.meal}${m?.try ? " (NEW)" : ""}  ${Math.round(macro(scaleItems(s.items, s.fraction ?? 1), foods, "kcal"))} kcal${tag}`);
    }
  };
  const report = () => {
    const { errors, warnings } = check(plan.days.filter((d) => d.date >= today()), meals, foods, { kcal, protein, lots });
    for (const e of errors) console.log(`ERROR ${e}`);
    for (const w of warnings) console.log(`warn  ${w}`);
    return errors.length;
  };

  if (cmd === "draft") {
    const from = flag("--from") ?? today();
    const n = Number(flag("--days") ?? 3);
    const dates = Array.from({ length: n }, (_, i) => {
      const d = new Date(`${from}T12:00:00`);
      d.setDate(d.getDate() + i);
      return d.toLocaleDateString("sv-SE");
    });
    const seed = Number(flag("--seed") ?? Date.now() % 1e9);
    const horizon = dates.at(-1)!;
    // Stock left once already-planned meals before the draft (e.g. the rest of today) have eaten.
    const stock = new Map(onHand);
    for (const it of plan.days.filter((d) => d.date >= today() && d.date < from).flatMap((d) => d.slots.filter((s) => s.status === "planned").flatMap((s) => s.items)))
      stock.set(it.food, (stock.get(it.food) ?? 0) - grams(it, foods));
    const expiring = new Set(lots.filter((l) => l.useBy && l.useBy >= from && l.useBy <= horizon && l.where !== "freezer").map((l) => l.food));
    const before = plan.days.filter((d) => d.date < from).at(-1);
    const yesterday = before?.slots.filter((s) => meals.get(s.meal)?.slot === "main").map((s) => s.meal);
    const drafted = planDays(mealList, foods, { dates, rest: new Set((flag("--rest") ?? "").split(",").filter(Boolean)), kcal, protein, rand: mulberry32(seed), onHand: stock, expiring, yesterday });
    const write = rest.includes("--write");
    if (write) {
      plan.days = [...plan.days.filter((d) => !dates.includes(d.date)), ...drafted];
      await save();
    }
    drafted.forEach(printDay);
    const window = [...plan.days.filter((d) => d.date >= today() && !dates.includes(d.date)), ...drafted];
    const { errors, warnings } = check(window, meals, foods, { kcal, protein, lots });
    for (const e of [...errors.map((e) => `ERROR ${e}`), ...warnings.map((w) => `warn  ${w}`)]) console.log(e);
    console.log(`\nseed ${seed}${write ? " — written to mealplan.json" : " — add --write to keep it"}`);
  } else if (cmd === "show" || cmd === "check") {
    const from = flag("--from") ?? today();
    if (cmd === "show") plan.days.filter((d) => d.date >= from).forEach(printDay);
    process.exit(report() ? 1 : 0);
  } else if (cmd === "swap") {
    const s = slotOf(day(rest[0]), rest[1]);
    const m = meals.get(rest[2]!);
    if (!m) throw new Error(`unknown meal "${rest[2]}" (see data/meals.json)`);
    Object.assign(s, { meal: m.id, items: m.items, status: "planned", fraction: undefined });
    await save();
    printDay(day(rest[0]));
    report();
  } else if (cmd === "scale") {
    const s = slotOf(day(rest[0]), rest[1]);
    const { food, g } = pair(`${rest[2]}=${rest[3]}`);
    const it = s.items.find((it) => it.food === food);
    if (it) Object.assign(it, { g, count: undefined });
    else s.items.push({ food, g });
    await save();
    printDay(day(rest[0]));
    report();
  } else if (cmd === "time") {
    const s = slotOf(day(rest[0]), rest[1]);
    if (!/^\d{2}:\d{2}$/.test(rest[2] ?? "")) throw new Error("time must be HH:MM");
    s.time = rest[2]!;
    day(rest[0]).slots.sort((a, b) => a.time.localeCompare(b.time));
    await save();
    printDay(day(rest[0]));
  } else if (cmd === "gcal") {
    slotOf(day(rest[0]), rest[1]).gcal = rest[2];
    await save();
  } else if (cmd === "skip") {
    slotOf(day(rest[0]), rest[1]).status = "skipped";
    await save();
    printDay(day(rest[0]));
  } else if (cmd === "eat") {
    const date = rest[0]!;
    const fraction = Number(flag("--fraction") ?? 1);
    const sets = flags("--set").map(pair);
    const adds = flags("--add").map(pair);
    const note = flag("--note");
    const planned = plan.days.find((d) => d.date === date)?.slots.find((s) => s.slot === rest[1]);
    const meal = meals.get(planned?.meal ?? rest[1]!);
    if (!planned && !meal && !adds.length) throw new Error(`"${rest[1]}" is neither a ${date} slot nor a meal id; or pass --add food=g`);
    let items: Item[] = (planned?.items ?? meal?.items ?? []).map((it) => ({ ...it }));
    for (const s of sets) {
      const it = items.find((it) => it.food === s.food);
      if (it) Object.assign(it, { g: s.g, count: undefined });
      else items.push(s);
    }
    items = [...scaleItems(items, fraction), ...adds];
    const at = flag("--at") ?? now();
    items = items.map((it) => ({ ...it, g: grams(it, foods), count: undefined, at }));
    const name = meal?.name ?? "Ad-hoc";
    const desc = `${at.slice(11)} ${name}${planned ? " per the plan" : ""}${fraction !== 1 ? `, ${fraction} of it` : ""}: ${items.map((it) => `${it.g}g ${foods.get(it.food)!.name}`).join(" + ")}.${note ? ` ${note}` : ""}`;
    const dev = { desc, at, items, ...Object.fromEntries(["kcal", "protein", "carbs", "fat"].map((k) => [k, Math.round(macro(items, foods, k))])) };
    const path = join(dir, "nutrition.json");
    let entry = nutrition.find((e) => e.date === date);
    if (!entry) nutrition.push((entry = { date, kcal: 0, protein: 0, carbs: 0, fat: 0, meals: [], method: "reported-as-eaten. DAY OPEN.", deviations: [], notes: "" }));
    entry.deviations = [...(entry.deviations ?? []), dev];
    for (const k of ["kcal", "protein", "carbs", "fat"]) entry[k] = (entry[k] ?? 0) + (dev as any)[k];
    nutrition.sort((a, b) => a.date.localeCompare(b.date));
    await Bun.write(path, JSON.stringify(nutrition, null, 2) + "\n");
    if (planned) {
      Object.assign(planned, { status: "eaten", fraction: fraction !== 1 ? fraction : undefined });
      await save();
    }
    console.log(`logged ${date}: ${desc} → ${(dev as any).kcal} kcal / ${(dev as any).protein}P (day ${entry.kcal} kcal / ${entry.protein}P)`);
  } else if (cmd === "groceries") {
    const from = flag("--from") ?? today();
    const rows = groceries(plan.days.filter((d) => d.date >= from), foods, onHand, new Set(events.map((e) => e.food!).filter(Boolean)));
    const line = (r: (typeof rows)[number]) => `  ${String(r.buy).padStart(5)}g ${r.name}${r.packs ? ` (${r.packs} pk)` : ""}  need ${r.need}, have ${r.have}`;
    console.log("Buy:");
    rows.filter((r) => r.tracked).forEach((r) => console.log(line(r)));
    console.log("Never counted (check the kitchen, then `kitchen count` or buy):");
    rows.filter((r) => !r.tracked).forEach((r) => console.log(`  ${String(r.need).padStart(5)}g ${r.name}`));
  } else if (cmd === "calendar") {
    const events = calendar(plan.days, rest[0]!, meals, foods, lots);
    if (rest.includes("--json")) console.log(JSON.stringify(events, null, 2));
    else for (const e of events) console.log(`\n${e.start.slice(11, 16)} ${e.summary}\n${e.description}`);
  } else {
    console.error(`unknown command "${cmd}" (see the header of scripts/plan.ts)`);
    process.exit(1);
  }
}
