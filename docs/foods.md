# Foods & meals data model

The food and meal registries are committed, hand/agent-edited bare arrays,
read live with no DB import. The weekly planner joins them with product,
inventory, and preference data:

```
foods.json (ingredients, per-100g)
   ↑ referenced by id
meals.json (recipe book: food × grams)
   ↓ selected by the deterministic planner
plans/<ISO-week>.json (generated weekly snapshot)
nutrition.json (actual: today just {date, kcal}; may later log meal refs)

products.json (store package → food id) ─┐
inventory.json (trusted quantity on hand) ├→ weekly grocery proposal
preferences.json (targets + scheduling) ──┘
```

Meal and day totals are always derived from `foods.per100g × grams / 100`.
Generated plan artifacts materialize those totals as an audit snapshot, but
they are not hand-edited or treated as source data; regeneration replaces
them from the registries and current health target.

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

## `data/products.json` — exact purchasable packages

Each record maps one store SKU/package to a `foods.json` id. Package size is
used for ceiling/quantity math; price is an estimate with an as-of date.
`allergenStatus: "verified"` is required by the default planner. Nutrition
provenance is explicit: `exact-label`, `generic-food`, or `unknown`. A generic
mapping is allowed in the proposal but produces a warning so exact label
capture remains visible work. `substitutionPolicy` is currently always
`none`.

Costco products may be delivery-capable. Trader Joe's products produce a
manual shopping list because there is no ordering adapter in this slice.
See `docs/sunday-planner.md` for the planning and approval flow.

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
