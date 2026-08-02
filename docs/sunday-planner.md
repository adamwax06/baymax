# Sunday weekly planner

The Sunday planner turns current Baymax state into one deterministic,
auditable proposal for the next week:

```
HealthClient nutrition target + latest completed lift
                         + foods + meals + preferences
                         + inventory + store products
                         + optional Calendar busy intervals
                                      ↓
                   data/plans/<ISO-week>.json
                   data/plans/<ISO-week>-groceries.md
                   ├─ seven days of meals and derived macros
                   ├─ PPL lift rotation and proposed event times
                   ├─ inventory-aware package quantities
                   ├─ Costco delivery-capable list
                   └─ Trader Joe's manual shopping list
```

## Run it

```bash
bun run sunday-plan --dry-run
bun run sunday-plan --week 2026-08-03 --dry-run
bun run sunday-plan --week 2026-08-03 --busy /tmp/busy.json --dry-run
bun run sunday-plan --week 2026-08-03 --extra-days data/plans/2026-W32-extra-days.json --dry-run
bun run sunday-plan --week 2026-08-03 --stdout
```

The default week is the current Monday when run on Monday, otherwise the next
Monday. The artifact path is `data/plans/<ISO-week>.json`; `--output` can
override it. A checkout-friendly Markdown list is written beside it; use
`--grocery-output` to override that path. `--dry-run` is intentionally redundant today: every invocation
is proposal-only, and the flag makes that contract obvious in an automation.

The optional busy file is an array of local intervals:

```json
[
  { "date": "2026-08-03", "start": "16:30", "end": "18:00", "title": "Work" }
]
```

An optional extra-days file adds already-planned meals outside the Monday–Sunday
window to grocery quantities without creating duplicate calendar events:

```json
[
  { "date": "2026-08-02", "label": "Sunday recovery day", "meals": ["rest-yogurt-bowl", "rest-beef-plate"] }
]
```

The planner tries the preferred lift time, then configured alternates, with a
buffer around existing events. If every candidate conflicts, it retains the
preferred time and emits a warning instead of silently dropping the lift.

## Inputs and invariants

- `data/preferences.json` owns meal count, calorie tolerance, fiber floor,
  required workout meals, PPL cadence, event times, store order, inventory
  freshness, and strict no-substitution behavior.
- `data/foods.json` is the nutrition registry. `data/meals.json` composes food
  ids and gram/count amounts. All macro totals are derived.
- `data/products.json` maps a food id to an exact store package. Allergy status,
  nutrition provenance, package size, price date, fulfillment, and product ids
  travel into the plan.
- `data/inventory.json` only reduces purchases when the item has a usable
  quantity, is recent enough, and lacks an untrusted note such as `unverified`
  or `estimate`. Ignored inventory becomes a warning.
- Grocery quantities always round packages up. Products that fail the allergy
  or nutrition gate become unresolved; the planner never swaps in another item.
- Meal selection is deterministic. It minimizes calorie distance, strongly
  penalizes missing protein/fiber, and adds a repetition penalty across the week.
- The first planned lift follows the most recent completed type in the configured
  split, so a completed legs session yields push next.

## Approval boundary

The current implementation performs no external writes:

- Google Calendar events are proposals with stable ids. The stable id is the
  future idempotency key for create/update/delete reconciliation.
- Costco is a delivery-capable shopping list, not a cart or order.
- Trader Joe's is a manual shopping list.
- DoorDash checkout must remain `order preview` → show the total → explicit
  human approval → `order submit`. A scheduled task must never submit directly.

This split lets a native Codex Scheduled task safely regenerate the plan every
Sunday now. Calendar apply, Costco cart reconciliation, and post-haul inventory
updates can be added as separate adapters without putting network side effects
inside the deterministic planner.

## Current data-quality meaning

`nutritionMatch: "exact-label"` means the package label matches the food
nutrition record. `generic-food` means the product identity/package is known
but calories are still supplied by a generic ingredient entry. Those products
are usable for a shopping proposal and deliberately emit warnings. Any
unresolved item makes the overall grocery total unknown; known store subtotals
remain visible rather than pretending the partial cart is the full cost.
