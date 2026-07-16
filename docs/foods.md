# Foods & meals data model

Two committed, hand/agent-edited files, same family as the other logs
(bare arrays, read live, no DB import). Composition chain:

```
foods.json (ingredients, per-100g)
   ↑ referenced by id
meals.json (recipe book: food × grams)
   ↑ referenced by id
mealplan.json (planned: days composing meals — future file)
nutrition.json (actual: today just {date, kcal}; may later log meal refs)
```

Totals (macros/micros for a meal, day, or plan) are **never stored** —
always derived from `foods.per100g × grams / 100` at read time, same
never-store-deriveables rule as the rest of the platform.

## `data/foods.json` — the ingredient registry

```json
{
  "id": "chicken-thigh",
  "name": "Chicken thigh, boneless skinless, raw",
  "brand": "Kirkland Signature",
  "store": "costco",
  "fdcId": 2646171,
  "fdcType": "Foundation",
  "weighed": "raw",
  "per100g": { "kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "fiber": 0,
    "sodium": 0, "potassium": 0, "calcium": 0, "iron": 0, "magnesium": 0,
    "zinc": 0, "vitD": 0, "vitC": 0, "ala": 0 },
  "packageG": 2720,
  "allergyChecked": "2026-07-16",
  "notes": ""
}
```

- **`id`** — kebab-case slug; the foreign key meals use. Renaming an id means
  updating every meal that references it (grep first).
- **`per100g`** — always per 100 g; only `kcal/protein/carbs/fat` are
  required. Micros are optional (Branded labels only carry the mandatory
  panel; Foundation foods have everything). Units: kcal; g for macros/fiber;
  mg for sodium/potassium/calcium/iron/magnesium/zinc/vitC; µg for vitD;
  g for ala (omega-3 α-linolenic — tracked because the fish allergy makes
  ALA the only dietary omega-3 route).
- **`weighed`**: `raw` | `cooked` | `dry` | `each` — the state the gram
  amounts refer to. This field is load-bearing: chicken loses ~25% water
  cooking, rice triples. Convention: meats raw, grains dry, unless noted.
  `each` is for unit foods (eggs) — then `per100g` still holds but
  `unitG` gives the per-unit weight.
- **`unitG`** (optional) — grams per unit for `each` foods (large egg ≈ 50).
- **`fdcId` + `fdcType`** — provenance pointer; the full 150-nutrient record
  is always one API call away, so we cache thin.
- **`packageG`** (optional) — package size for grocery-list math.
- **`allergyChecked`** — date the product label was verified against
  `profile.json → diet` (ingredients AND "may contain" warnings). Re-check
  when the diet registry changes.

## `data/meals.json` — the recipe book

```json
{
  "id": "post-lift-bowl",
  "name": "Post-lift chicken & rice bowl",
  "items": [
    { "food": "chicken-thigh", "g": 200 },
    { "food": "jasmine-rice", "g": 125 }
  ],
  "notes": "rice weighed dry"
}
```

- **`items[].food`** must be a `foods.json` id; **`g`** is grams in that
  food's `weighed` state. Unit foods may use `{ "food": "egg", "count": 3 }`
  instead of `g`.
- Meals are reusable units — the plan and (eventually) the intake log
  reference them by id. A one-off meal can live inline in the plan; only
  repeated meals earn an entry here.

## Derivation rules (for whatever computes totals)

- Meal total = Σ over items: `per100g × g / 100` (or `unitG × count`).
- Missing micro on any ingredient → that micro's meal total is reported as
  **incomplete**, not silently low. Macros are always complete (required).
- Validation at read: every `items[].food` resolves; a dangling ref is a
  loud error, not a skip.

## FDC curation footnote

Foundation records file energy under the Atwater nutrient IDs (`2047`
general / `2048` specific), not `1008` — check all three when extracting
kcal. See docs/nutrition.md for the full FDC playbook.
