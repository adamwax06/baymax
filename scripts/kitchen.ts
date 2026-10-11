#!/usr/bin/env bun
// Kitchen state (docs/kitchen.md). inventory.json holds exact, append-only
// events (count/buy/move/share/toss/undo); lots on hand are derived from them
// plus the ingredient items logged in nutrition.json. Nothing is edited in
// place: a correction is a new event, and `undo` reverses one by id.
//
// usage: bun run kitchen show [--expiring 3] [--food id] [--json]
//        bun run kitchen count|buy <food> <amount> --where fridge|freezer|pantry [--thawed YYYY-MM-DD] [--est] [--note ..] [--at ..] [--source ..]
//        bun run kitchen move <food> [amount] --to fridge|freezer [--from ..]
//        bun run kitchen share|toss <food> <amount> [--lot id] [--note ..]
//        bun run kitchen undo <eventId> | log [--food id] | reconcile
// amount: grams ("907"), packages ("2pk", needs packageG), or units ("3ea", needs unitG). Add --dry-run to any write.

import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultDbPath } from "@baymax/core";

export type Item = { food: string; g?: number; count?: number; lot?: string; at?: string };
export type Meal = { id: string; name: string; slot?: string; meat?: string; try?: boolean; items: Item[]; notes?: string };
// fromFrozen: used straight from the freezer (blender, air fryer, toaster), so it never needs a thaw line.
export type ShelfLife = { fridgeDays?: number; freezerDays?: number; thawedDays?: number; pantryDays?: number; fromFrozen?: boolean };
export type Food = {
  id: string; name: string; weighed: string; unitG?: number; packageG?: number;
  per100g: Record<string, number>; allergyChecked?: string; shelfLife?: ShelfLife;
};
export type Lot = { id: string; food: string; where: Where; g: number; since: string; thawedOn?: string; est?: boolean; useBy?: string };

export const WHERE = ["fridge", "freezer", "pantry"] as const;
type Where = (typeof WHERE)[number];
const at = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "YYYY-MM-DD or YYYY-MM-DDTHH:MM");
export const eventZ = z
  .object({
    id: z.string(),
    at,
    type: z.enum(["count", "buy", "move", "share", "toss", "undo"]),
    food: z.string().optional(),
    g: z.number().nonnegative().optional(), // 0 only for a count ("we're out")
    where: z.enum(WHERE).optional(),
    to: z.enum(WHERE).optional(),
    lot: z.string().optional(),
    thawedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ref: z.string().optional(),
    est: z.boolean().optional(),
    source: z.string(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const need = (k: keyof typeof e) => e[k] === undefined && ctx.addIssue({ code: "custom", message: `${e.type} needs ${k}` });
    if (e.type === "undo") need("ref");
    else need("food");
    if (e.type === "count" || e.type === "buy") (need("g"), need("where"));
    if (e.type === "share" || e.type === "toss") need("g");
    if (e.g === 0 && e.type !== "count") ctx.addIssue({ code: "custom", message: `${e.type} needs g > 0` });
    if (e.type === "move") need("to");
  });
export type KitchenEvent = z.infer<typeof eventZ>;

export const dataDir = () => dirname(defaultDbPath());
export const grams = (it: Item, foods: Map<string, Food>) => it.g ?? (it.count ?? 0) * (foods.get(it.food)?.unitG ?? 0);
export const macro = (items: Item[], foods: Map<string, Food>, key: string) =>
  items.reduce((s, it) => s + ((foods.get(it.food)!.per100g[key] ?? 0) * grams(it, foods)) / 100, 0);
export const today = () => new Date().toLocaleDateString("sv-SE");
export const now = () => new Date().toLocaleString("sv-SE").slice(0, 16).replace(" ", "T");
const addDays = (date: string, n: number) => {
  const d = new Date(`${date.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

export async function load() {
  const dir = dataDir();
  const read = async (f: string, fallback: unknown): Promise<any> => {
    const file = Bun.file(join(dir, f));
    return (await file.exists()) ? file.json() : fallback;
  };
  const inv = await read("inventory.json", { events: [] });
  const foods = new Map<string, Food>(((await read("foods.json", [])) as Food[]).map((f) => [f.id, f]));
  const meals: Meal[] = await read("meals.json", []);
  const nutrition: any[] = await read("nutrition.json", []);
  const events = z.array(eventZ).parse(inv.events);
  return { dir, inv, events, foods, meals, nutrition };
}

export function useBy(lot: Lot, food: Food | undefined): string | undefined {
  const s = food?.shelfLife;
  if (!s) return undefined;
  const days =
    lot.where === "freezer" ? s.freezerDays
    : lot.where === "pantry" ? s.pantryDays
    : lot.thawedOn ? (s.thawedDays ?? s.fridgeDays)
    : s.fridgeDays;
  return days === undefined ? undefined : addDays(lot.thawedOn && lot.where === "fridge" ? lot.thawedOn : lot.since, days);
}

/** Replay events + intake items into lots. Intake before the first kitchen event is history, not stock. */
export function compute(events: KitchenEvent[], nutrition: any[], foods: Map<string, Food>) {
  const undone = new Set(events.filter((e) => e.type === "undo").map((e) => e.ref));
  const live = events.filter((e) => e.type !== "undo" && !undone.has(e.id));
  const start = live.map((e) => e.at).sort()[0] ?? "9999";
  const uses: (KitchenEvent | { type: "use"; at: string; food: string; g: number; lot?: string; id: string })[] = [];
  for (const day of nutrition)
    for (const dev of day.deviations ?? [])
      for (const it of dev.items ?? []) {
        const t = it.at ?? dev.at ?? `${day.date}T23:59`;
        if (t >= start) uses.push({ type: "use", at: t, food: it.food, g: grams(it, foods), lot: it.lot, id: `intake:${day.date}` });
      }
  const timeline = [...live, ...uses].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const lots: Lot[] = [];
  const drift: { at: string; food: string; where: string; computed: number; counted: number }[] = [];
  const warnings: string[] = [];
  const rank = { fridge: 0, pantry: 1, freezer: 2 };
  const take = (food: string, g: number, lot?: string, where?: Where) => {
    const pool = lots
      .filter((l) => l.food === food && l.g > 0 && (!lot || l.id === lot) && (!where || l.where === where))
      .sort((a, b) => rank[a.where] - rank[b.where] || (useBy(a, foods.get(food)) ?? "9").localeCompare(useBy(b, foods.get(food)) ?? "9"));
    const taken: Lot[] = [];
    let left = g;
    for (const l of pool) {
      const n = Math.min(l.g, left);
      if (n <= 0) break;
      l.g -= n;
      left -= n;
      taken.push({ ...l, g: n });
    }
    return { taken, short: left };
  };

  for (const e of timeline) {
    const food = e.food!;
    if (e.type === "count") {
      const at = lots.filter((l) => l.food === food && l.where === e.where && l.g > 0);
      drift.push({ at: e.at, food, where: e.where!, computed: Math.round(at.reduce((s, l) => s + l.g, 0)), counted: e.g! });
      for (const l of at) l.g = 0;
      lots.push({ id: e.id, food, where: e.where!, g: e.g!, since: e.at.slice(0, 10), thawedOn: e.thawedOn, est: e.est });
    } else if (e.type === "buy") {
      lots.push({ id: e.id, food, where: e.where!, g: e.g!, since: e.at.slice(0, 10), thawedOn: e.thawedOn, est: e.est });
    } else if (e.type === "move") {
      const { taken, short } = take(food, e.g ?? Infinity, e.lot, e.where);
      if (e.g && short > 0) warnings.push(`${e.id} move: ${Math.round(short)}g ${food} wasn't on hand`);
      const g = taken.reduce((s, l) => s + l.g, 0);
      if (!g) continue;
      const from = taken[0]!;
      lots.push({
        id: e.id, food, where: e.to!, g, est: taken.some((l) => l.est),
        since: e.to === "freezer" ? e.at.slice(0, 10) : from.since,
        thawedOn: from.where === "freezer" && e.to === "fridge" ? e.at.slice(0, 10) : from.thawedOn,
      });
    } else {
      const { short } = take(food, e.g!, e.lot);
      if (short > 0.5) warnings.push(`${e.id} ${e.type}: ${Math.round(short)}g ${food} more than on hand`);
    }
  }
  const onHand = lots.filter((l) => l.g > 0.5).map((l) => ({ ...l, g: Math.round(l.g), useBy: useBy(l, foods.get(l.food)) }));
  return { lots: onHand, drift, warnings };
}

export function totals(lots: Lot[]) {
  const m = new Map<string, number>();
  for (const l of lots) m.set(l.food, (m.get(l.food) ?? 0) + l.g);
  return m;
}

export function parseAmount(s: string | undefined, food: Food): { g?: number } {
  if (s === undefined) return {};
  const m = /^(\d+(?:\.\d+)?)(pk|ea|g)?$/.exec(s);
  if (!m) throw new Error(`bad amount "${s}" (use 907, 2pk or 3ea)`);
  const n = Number(m[1]);
  if (m[2] === "pk") {
    if (!food.packageG) throw new Error(`${food.id} has no packageG; give grams`);
    return { g: n * food.packageG };
  }
  if (m[2] === "ea") {
    if (!food.unitG) throw new Error(`${food.id} has no unitG; give grams`);
    return { g: n * food.unitG };
  }
  return { g: n };
}

export async function append(ev: Omit<KitchenEvent, "id">, dry = false) {
  const { dir, inv, events, foods } = await load();
  if (ev.food && !foods.has(ev.food)) throw new Error(`unknown food "${ev.food}" (see data/foods.json)`);
  if (ev.type === "undo" && !events.some((e) => e.id === ev.ref)) throw new Error(`no event ${ev.ref}`);
  const next = 1 + Math.max(0, ...events.map((e) => Number(e.id.slice(1)) || 0));
  const full = eventZ.parse({ id: `k${next}`, ...ev });
  if (!dry) await Bun.write(join(dir, "inventory.json"), JSON.stringify({ ...inv, events: [...events, full] }, null, 2) + "\n");
  return full;
}

const fmtLot = (l: Lot, foods: Map<string, Food>) =>
  `  ${String(l.g).padStart(5)}g${l.est ? "~" : " "} ${foods.get(l.food)?.name ?? l.food}  [${l.where}${l.thawedOn ? `, thawed ${l.thawedOn}` : ""}${l.useBy ? `, use by ${l.useBy}` : ""}] ${l.id}`;

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const bool = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? (rest.splice(i, 1), true) : false;
  };
  const dry = bool("--dry-run");
  const json = bool("--json");
  const common = () => ({ at: flag("--at") ?? now(), source: flag("--source") ?? "chat", note: flag("--note"), est: bool("--est") || undefined });
  const state = await load();
  const food = (id: string | undefined) => {
    const f = id && state.foods.get(id);
    if (!f) throw new Error(`unknown food "${id}" (see data/foods.json)`);
    return f;
  };
  const report = async (ev: KitchenEvent) => {
    console.log(`${dry ? "(dry run) " : ""}${ev.id} ${ev.type} ${ev.food ?? ev.ref} ${ev.g ? `${ev.g}g` : ""}`.trim());
    if (dry || !ev.food) return;
    const s = await load();
    const { lots } = compute(s.events, s.nutrition, s.foods);
    for (const l of lots.filter((l) => l.food === ev.food)) console.log(fmtLot(l, s.foods));
  };

  if (!cmd || cmd === "show") {
    const days = flag("--expiring");
    const only = flag("--food");
    const { lots, warnings } = compute(state.events, state.nutrition, state.foods);
    const horizon = days ? addDays(today(), Number(days)) : undefined;
    const shown = lots
      .filter((l) => (!only || l.food === only) && (!horizon || (l.useBy && l.useBy <= horizon)))
      .sort((a, b) => WHERE.indexOf(a.where) - WHERE.indexOf(b.where) || (a.useBy ?? "9").localeCompare(b.useBy ?? "9"));
    if (json) console.log(JSON.stringify({ lots: shown, warnings }, null, 2));
    else {
      for (const l of shown) console.log(fmtLot(l, state.foods));
      for (const w of warnings) console.log(`! ${w}`);
    }
  } else if (cmd === "count" || cmd === "buy") {
    const f = food(rest[0]);
    const where = flag("--where") as Where | undefined;
    await report(await append({ type: cmd, food: f.id, ...parseAmount(rest[1], f), where, thawedOn: flag("--thawed"), ...common() }, dry));
  } else if (cmd === "move") {
    const f = food(rest[0]);
    const to = flag("--to") as Where | undefined;
    const where = flag("--from") as Where | undefined;
    await report(await append({ type: "move", food: f.id, to, where, lot: flag("--lot"), ...parseAmount(rest[1], f), ...common() }, dry));
  } else if (cmd === "share" || cmd === "toss") {
    const f = food(rest[0]);
    await report(await append({ type: cmd, food: f.id, lot: flag("--lot"), ...parseAmount(rest[1], f), ...common() }, dry));
  } else if (cmd === "undo") {
    await report(await append({ type: "undo", ref: rest[0], ...common() }, dry));
  } else if (cmd === "log") {
    const only = flag("--food");
    for (const e of state.events.filter((e) => !only || e.food === only)) console.log(JSON.stringify(e));
  } else if (cmd === "reconcile") {
    const { drift } = compute(state.events, state.nutrition, state.foods);
    for (const d of drift.filter((d) => d.computed > 0))
      console.log(`${d.at} ${d.food} [${d.where}] computed ${d.computed}g, counted ${d.counted}g (${d.counted - d.computed >= 0 ? "+" : ""}${d.counted - d.computed}g)`);
  } else {
    console.error(`unknown command "${cmd}" (see the header of scripts/kitchen.ts)`);
    process.exit(1);
  }
}
