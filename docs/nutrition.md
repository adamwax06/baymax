# Nutrition loop

Adaptive calorie/protein targets for the body-weight goal. The controller:
prescribe → eat → weigh in → re-estimate → adjust. All formulas are named in
tool output; the model coaches, the code computes.

## Files (committed, hand- or agent-edited)

- `data/profile.json` — who Adam is: birthdate, height, sex, activity factor,
  and `diet`. **`diet` is binding for every agent**: `allergies` are medical —
  never suggest these foods and check "may contain / shared facility" labels
  when curating any food list (e.g. the planned `foods.json`); `avoid` is
  ingredient-level; `explicitlyOk` lists
  edge cases that are safe (don't over-restrict). Read it before suggesting
  ANY food, meal, or product, in any context.
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

## Honest limits

Energy balance (~3500 kcal/lb) is an approximation; water weight makes daily
scale readings noisy (the trend uses least-squares over the window, and
"current weight" is a 7-day average). The estimator is only as good as
logging adherence — the tool tells you when it's blind.
