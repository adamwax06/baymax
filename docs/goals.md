# Goals

`data/goals.json` (committed, hand-edited, bare array) records what Adam is
chasing. Read live at query time — edit and ask, no import.

## Goal flavors

- **Lift**: `{ "id", "lift": "Bench Press", "target": { "lb": 225, "reps": 1 }, "deadline"?, "notes"? }`
  — pace is measured in **estimated 1RM**: compare the target (weight×reps →
  Epley e1RM) against `e1rmLb` from `health_lifts` / `health lifts`. Pace
  milestones live in `notes` (human-set, agent-checked).
- **Body weight**: `{ "id", "metric": "body_mass", "targetLb", "ratePerWeekLb", "notes"? }`
  — consumed by `health_nutrition`, which derives daily calorie/protein
  targets from it (docs/nutrition.md).
- **Run (planned, not yet used)**: `{ "run": { "miles": 1 }, "target": { "time": "6:00" } }`
  — best direct effort at the distance, else Riegel equivalence from any run.

## Answering "am I on pace?"

There is no goals tool yet (by choice — two goals don't earn one). The recipe:
read `goals.json`, get the current measure (`health_lifts` e1rmLb for lifts,
`health_nutrition` observed rate + current weight for body weight), compare
against the target/pace notes, and say so plainly. Goal history = git history
of this file. Achieved goals: delete the entry or keep it as a trophy — the
data doesn't care.
