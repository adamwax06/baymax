# Nutrition loop

Adaptive calorie/protein targets for the body-weight goal. The controller:
prescribe → eat → weigh in → re-estimate → adjust. All formulas are named in
tool output; the model coaches, the code computes.

## Files (committed, hand- or agent-edited)

- `data/profile.json` — who Adam is: birthdate, height, sex, activity factor,
  and `diet`. **`diet` is binding for every agent** — read it before
  suggesting ANY food, meal, or product, in any context. Tier semantics:
  `allergies` are medical (never suggest; check "may contain / shared
  facility" labels when curating any food list), `avoid` is ingredient-level,
  `explicitlyOk` marks safe edge cases (don't over-restrict).
- `data/goals.json` — what Adam is chasing (bare array). The nutrition loop
  uses the `body_mass` goal: `targetLb` + `ratePerWeekLb`.
- `data/nutrition.json` — daily intake, one line per day, appended by you or
  by an agent you told what you ate:

```json
[
  { "date": "2026-07-16", "kcal": 2950, "protein": 155 }
]
```

`kcal` is required; other macros are optional and logged for the future
(currently only `kcal` is consumed).

**Read semantics differ, on purpose**: `nutrition.json`, `profile.json`, and
`goals.json` are read live at query time — edits are visible immediately.
Weigh-ins in `bodyweight.json` flow through the database, so they only count
after `bun run import`. Log weight → import → ask. All of these files are
located next to the database, so a `BAYMAX_DB` override relocates them too.

## How targets are computed (`health nutrition` / `health_nutrition`)

1. **Seed mode** (until enough data): Mifflin-St Jeor BMR × activity factor,
   plus the goal surplus (`ratePerWeekLb × 3500 / 7`). Protein: 0.9 g/lb.
2. **Empirical mode** (automatic once the last 21 days contain ≥12 logged
   intake days and ≥5 weigh-ins): TDEE is *solved from your own data* —
   `avg(logged kcal) − weight-trend(lb/day) × 3500` — then the same goal
   surplus applies. The estimate tightens every week you log.

The tool reports which mode it's in, the method, observed vs target rate,
adherence, and staleness notes. It never invents scores and never switches
modes silently.

## Food label data (FDA FoodData Central)

Nutrition facts for branded products (incl. Trader Joe's and Kirkland items)
come from the free FDA FoodData Central API. The key lives in `.env` at the
repo root as `FDC_API_KEY` (gitignored; Bun auto-loads it —
`Bun.env.FDC_API_KEY`). Search endpoint:

```
GET https://api.nal.usda.gov/fdc/v1/foods/search?api_key=$FDC_API_KEY&query=<terms>&dataType=Foundation,SR%20Legacy
```

(`dataType=Branded` for packaged products — see the playbook below for
which database to use when.)

Convention: FDC is queried at **curation time** (building the planned
`foods.json`, estimating a logged deviation) and results are cached into
files — never a live dependency at meal-planning or query time. `DEMO_KEY`
works for one-off checks (30 req/hr); our key allows 3,600/hr (read the
`X-RateLimit-Remaining` header).

### FDC playbook (it's five databases in one — pick the right one)

| dataType | What | Use for |
|---|---|---|
| `Foundation` | Generic whole foods, USDA lab-analyzed, per 100g, richest profiles | **First choice for staples**: chicken thighs, eggs, rice, potatoes |
| `SR Legacy` | Classic USDA database, frozen 2018, per 100g | Fallback when Foundation lacks the food |
| `Branded` | ~380k label-derived products (incl. Trader Joe's, Kirkland) | Packaged/store-brand items only |
| `Survey (FNDDS)` | Foods as-eaten with cooking method ("chicken, grilled") | Estimating restaurant/deviation meals |

Rules of thumb:
- Search generic staples with `dataType=Foundation,SR Legacy`; only use
  `Branded` for actual packaged products. Search returns abridged nutrients —
  fetch `/v1/food/{fdcId}` for the full record before caching.
- **Normalize everything cached into foods.json to per-100g** (Branded records
  carry both per-serving and per-100g; per-100g matches food-scale grams).
- Energy = nutrient `1008` (kcal); ignore the kJ twin. Beware label rounding
  on Branded small servings (protein "0g" on a 5g serving) — per-100g values
  suffer less.
- Branded is messy: stale/discontinued products, wrong brand owners, fuzzy
  search relevance. Always eyeball the match and verify against the physical
  label before trusting it for an allergy-constrained pantry.
- Bulk needs (thousands of records) → download their CSV dumps instead of
  hammering the API. Our scale (~30 staples) never gets close.

## Honest limits

Energy balance (~3500 kcal/lb) is an approximation; water weight makes daily
scale readings noisy (the trend uses least-squares over the window, and
"current weight" is a 7-day average — or the latest weigh-in when the last
week is empty, with a staleness note). The estimator is only as good as
logging adherence — the tool tells you when it's blind.
