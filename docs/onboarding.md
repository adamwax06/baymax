# Adopting baymax: standardizing your data into Apple Health

baymax has one routing rule: **measurements live in Apple Health; ledgers and
intent live in JSON files.** Onboarding is mostly getting your existing data
on the right side of that line. (This repo ships with its author's data in
the committed JSON files — replace it with yours.)

## 1. Personalize the files

- `data/profile.json` — your biometrics, activity factor, and **your** diet
  registry (allergies are binding for every agent; see docs/nutrition.md)
- `data/goals.json` — your targets (docs/goals.md)
- `data/weights.json` → `{"sessions": []}`, `data/nutrition.json` → `[]`,
  `data/foods.json` / `data/meals.json` → `[]`
- `ios/project.yml` — your bundle id; `ios/Signing.xcconfig` — your team id
- `.env` — your own free FDC API key (docs/nutrition.md)

## 2. Route live data into Apple Health

Every fitness app and device you use should write to Apple Health — the
setting is usually called "Sync with Apple Health" or "Connected apps"
(Strava, Eight Sleep, Oura, WHOOP, scale apps, sleep apps all have it).
Honest expectation: most apps write **going forward only** — enabling the
toggle rarely backfills history. Manual entries (weight, etc.) go straight
into the Health app or via Siri ("log my weight, 170 pounds").

Then build the app (AGENTS.md → Human setup), grant read access, and sync.
Check `health status` → `unregisteredTypes` and `health sources` to see what
your devices actually write; extend the metric registry with the 2-line
recipe (AGENTS.md → How to add a metric).

## 3. Backfill historical data

For history trapped in spreadsheets, notes, or non-syncing apps:

- **Body weight** (the machinery already exists): format your history as
  `[{"date": "YYYY-MM-DD", "lb": 170.0}]` into `data/bodyweight.json`, run
  `bun run dev`, tap **Backfill Body Weight into Health** in the app, Sync,
  then delete the file. Dedup-guarded; safe to re-tap. This writes real
  HealthKit samples, so Apple Health becomes the permanent home.
- **Other sample types** (historical heart rate, sleep, etc.): copy the
  ~40-line pattern — `GET /v1/backfill/bodyweight` in `apps/server/src/app.ts`
  plus `backfillBodyWeight` in `ios/Baymax/SyncEngine.swift`. Add the type to
  `SyncedTypes.shareTypes`; `NSHealthUpdateUsageDescription` is already set.
- **Lifting history**: does NOT go into Apple Health (no set/rep/load model
  exists there — docs/weights.md). Structure it into `data/weights.json`
  instead; any format an agent can read can be converted (this repo's history
  was migrated from five years of free-text Apple Notes in one pass).
- **Food/intake history**: usually not worth backfilling — the TDEE estimator
  (docs/nutrition.md) only uses recent paired intake + weigh-ins.

## 4. Verify

```bash
bun test && bun run health status    # sources should show YOUR devices
bun run health overview              # the whole picture
```

The inspection loop in AGENTS.md ("The inspection step") is the ongoing
version of this document: every new device or app you add gets discovered,
registered, and routed the same way.
