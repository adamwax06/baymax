import { expect, test } from "bun:test";
import { join } from "node:path";
import { compute, eventZ, type KitchenEvent } from "./kitchen";

const foods = new Map<string, any>((await Bun.file(join(import.meta.dir, "../data/foods.json")).json()).map((f: any) => [f.id, f]));
const ev = (e: Partial<KitchenEvent>) => eventZ.parse({ source: "test", ...e });

test("buy, thaw, eat, share and undo replay into exact lots", () => {
  const events = [
    ev({ id: "k1", at: "2026-10-11T10:00", type: "buy", food: "shrimp-raw", g: 907, where: "freezer" }),
    ev({ id: "k2", at: "2026-10-11T20:00", type: "move", food: "shrimp-raw", g: 300, to: "fridge" }),
    ev({ id: "k3", at: "2026-10-12T09:00", type: "toss", food: "shrimp-raw", g: 100 }),
    ev({ id: "k4", at: "2026-10-12T09:05", type: "undo", ref: "k3" }),
  ];
  const nutrition = [
    { date: "2026-10-10", deviations: [{ items: [{ food: "shrimp-raw", g: 999 }] }] }, // before the first event: history, ignored
    { date: "2026-10-12", deviations: [{ at: "2026-10-12T19:00", items: [{ food: "shrimp-raw", g: 250 }] }] },
  ];
  const { lots, warnings } = compute(events, nutrition, foods);
  const fridge = lots.find((l) => l.where === "fridge")!;
  expect(fridge.g).toBe(50); // 300 thawed - 250 eaten (the toss was undone)
  expect(fridge.thawedOn).toBe("2026-10-11");
  expect(fridge.useBy).toBe("2026-10-13"); // shrimp: 2 days after thawing
  expect(lots.find((l) => l.where === "freezer")!.g).toBe(607);
  expect(warnings).toEqual([]);
});

test("a count resets the food and records drift", () => {
  const events = [
    ev({ id: "k1", at: "2026-10-11T10:00", type: "buy", food: "gnocchi", g: 500, where: "pantry" }),
    ev({ id: "k2", at: "2026-10-12T10:00", type: "count", food: "gnocchi", g: 0.5, where: "pantry" }),
  ];
  const nutrition = [{ date: "2026-10-11", deviations: [{ at: "2026-10-11T14:30", items: [{ food: "gnocchi", g: 250 }] }] }];
  const { lots, drift } = compute(events, nutrition, foods);
  expect(drift).toEqual([{ at: "2026-10-12T10:00", food: "gnocchi", where: "pantry", computed: 250, counted: 0.5 }]);
  expect(lots).toEqual([]); // Nanda's half shows up as -250g drift, not phantom stock
});

test("events are validated", () => {
  expect(() => eventZ.parse({ id: "k1", at: "2026-10-11", type: "buy", food: "honey", source: "t" })).toThrow();
  expect(() => eventZ.parse({ id: "k1", at: "10/11", type: "toss", food: "honey", g: 5, source: "t" })).toThrow();
  expect(() => eventZ.parse({ id: "k1", at: "2026-10-11", type: "undo", source: "t" })).toThrow();
});
