# Weights log format

`data/weights.json` is the **source of truth** for gym sessions and manual
body-weight entries (committed by deliberate choice — edit it from the GitHub
app on your phone, or locally). After editing: `git pull` if you edited on
GitHub, then `bun scripts/import-weights.ts` to load it into the health
database. The file is authoritative: imports upsert by date-keyed UUID *and*
delete anything previously imported that's no longer in the file — so edits,
fixes, and deletions all sync on the next run. Re-running is always safe.

## Shape

```json
{
  "bodyWeight": [
    { "date": "2026-07-14", "lb": 168.4 }
  ],
  "sessions": [
    {
      "date": "2026-07-13",
      "type": "push",
      "gym": "hearst",
      "exercises": [
        { "name": "Bench Press",       "sets": [{ "lb": 160, "reps": [6, 6] }] },
        { "name": "DB Lateral Raises", "sets": [{ "lb": 20, "perSide": true, "reps": [10, 10, 10] }] },
        { "name": "Incline Flies",     "sets": [{ "lb": 75, "reps": [8] }, { "lb": 85, "reps": [6] }] },
        { "name": "Pullups",           "sets": [{ "bodyweight": true, "reps": [9, 6] }] },
        { "name": "Pistol Squats",     "sets": [{ "reps": [5, 4, 4] }] }
      ],
      "notes": "felt strong"
    }
  ]
}
```

## Rules

- **`sets`** is an array of same-weight runs. `{ "lb": 160, "reps": [6, 6] }`
  means two sets at 160. A weight change mid-exercise is a second entry
  (the old "75 for 8 and 85 for 6" becomes two entries).
- **`lb`** is the load in pounds. Omit it and set `"bodyweight": true` for
  BW exercises; omit both for unloaded movements (reps-only).
- **`perSide: true`** means `lb` is per hand/side (the old "20's" notation
  for dumbbell pairs and unilateral work).
- **`reps`** are numbers (decimals allowed for half reps).
- **`date`** is `YYYY-MM-DD`. Two sessions on one date are two array entries.
- **`type`** (push/pull/legs/…), **`gym`**, and **`notes`** are optional
  free-form strings. Per-exercise `"notes"` is also allowed for anything the
  structure can't say (assisted reps, equipment quirks).
- **`name`** is free-form and is the analysis key: entries with the same name
  chart as one progression. Names were migrated exactly as written in the old
  Apple Notes — different machines at different gyms intentionally have
  different names. Rename freely in this file to merge or split histories;
  re-import rewrites the database to match.

## How it lands in the database

- `bodyWeight` → `body_mass` samples (lb→kg, original lb kept in metadata),
  source `weights-json` ("Weights Log"), timestamped noon local.
- `sessions` → `workouts` rows (traditional_strength_training, default
  17:00 local, 60 min), with `{type, gym, exercises, notes}` preserved in the
  workout's `metadata` JSON.

Example progression query (CLI: `sqlite3 data/baymax.db` or the MCP
`health_query` tool):

```sql
SELECT date(w.start_ts/1000,'unixepoch','localtime') AS day,
       json_extract(s.value,'$.lb') AS lb, json_extract(s.value,'$.reps') AS reps
FROM workouts w, json_each(w.metadata,'$.exercises') e, json_each(e.value,'$.sets') s
WHERE json_extract(e.value,'$.name') = 'Bench Press'
ORDER BY day;
```
