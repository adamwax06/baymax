# Kitchen + meal plan

**Principle:** code holds exact state and enforces the rules; the LLM is the
interface. Anything said in chat ("Nanda ate half the gnocchi", "I had like
250g marinara") becomes one validated, typed change. No number lives only in
prose. Nothing is edited in place: corrections are new events, so every
number has a reason and anything can be undone.

```
receipts / photos / chat ──→ bun run kitchen ──→ inventory.json (events) ─┐
meals.json + on hand ──────→ bun run plan draft ─→ mealplan.json ─────────┤
mealplan slot eaten ───────→ bun run plan eat ──→ nutrition.json items ───┴→ lots on hand
mealplan.json ─────────────→ bun run plan calendar → gcal events (pushed by the agent)
```

## Objects

| Object | Where | Fields |
|---|---|---|
| Food | `foods.json` | per100g, `weighed`, `unitG`, `packageG`, `allergyChecked`, `shelfLife { fridgeDays, freezerDays, thawedDays, pantryDays, fromFrozen }` |
| Meal | `meals.json` | items `[{food, g \| count}]`, `slot`, `meat`, `try` (docs/foods.md) |
| Kitchen event | `inventory.json → events` | `{ id, at, type, food, g, where, to, lot, thawedOn, ref, est, source, note }` |
| Lot | derived | one pack: food, grams left, where, since, thawedOn, **useBy** (from shelfLife) |
| Plan day | `mealplan.json → days` | `{ date, lift, slots[{ slot, meal, items, time, status, fraction, gcal }] }` |
| Intake | `nutrition.json` | home meals carry `deviations[].items [{food, g, at}]`; restaurant meals carry macros only |

`inventory.json → legacy` is the pre-October diary of notes, kept for history only.

Kitchen event types:
- `count` is a photo check or audit. It resets that food at that location and records drift. `g: 0` means out.
- `buy` is a receipt or order line. It creates a lot.
- `move` is freezer → fridge (sets `thawedOn`) or fridge → freezer (refreeze).
- `share` is someone else eating it. `toss` is spoiled or thrown out.
- `undo` reverses one event by id.

Eating isn't an event. It's derived from intake items, so it's never entered twice.
Intake dated before the first kitchen event is history and doesn't subtract.

**On hand = last count + buys − intake items − shares − tosses, per lot.**
Consumption comes out of the fridge first, then the pantry, then the freezer, oldest use-by first, unless an item names a `lot`.

## Precision rules
- Grams are in the food's `weighed` state (raw meat, dry grains). Unit foods take `3ea`, packages take `2pk`.
- Every event is Zod-validated on write. Unknown food ids are rejected.
- Guesses are marked `est` (shown with `~`). The next `count` overrides them, and `kitchen reconcile` shows the drift.

## Commands

```bash
bun run kitchen show [--expiring 3] [--food id]
bun run kitchen buy shrimp-raw 907 --where freezer --source receipt
bun run kitchen count chipotle-chicken-kirkland 457 --where fridge --thawed 2026-10-08 --est
bun run kitchen move chipotle-chicken-kirkland 300 --to fridge     # thaw
bun run kitchen share gnocchi 250 --note Nanda
bun run kitchen toss spinach 60
bun run kitchen undo k11 | log [--food id] | reconcile             # all writes take --dry-run

bun run plan draft --from 2026-10-12 --days 3 [--rest 2026-10-14] [--seed N] --write
bun run plan show | check
bun run plan swap 2026-10-14 dinner honey-garlic-chicken-bowl
bun run plan scale 2026-10-11 lunch chipotle-chicken-kirkland 457
bun run plan time 2026-10-11 lunch 13:00
bun run plan eat 2026-10-11 lunch [--fraction 0.5] [--set marinara-raos=250] [--add honey=10]
bun run plan eat 2026-10-11 snack --add greek-yogurt-whole=150     # ad hoc, no slot
bun run plan away 2026-10-15 2026-10-16 --note "Tahoe trip"         # no meals planned or bought
bun run plan skip 2026-10-11 nightcap
bun run plan groceries                                             # need minus on hand
bun run plan calendar 2026-10-12 --json                            # events to push
bun run plan gcal 2026-10-12 dinner <eventId>
```

`draft` picks two mains a day, **kitchen first**: the share of a meal's protein already on hand (after meals already planned before the draft) outweighs variety, and a fridge or pantry lot about to expire outweighs everything except the hard rules. Randomness only breaks ties. New (`try`) meals come up less often, rice/pasta flex to land near the kcal target, and it knows yesterday's mains from the plan.

## Rules enforced in code
`plan check` (and every draft) reports **errors** for:
- an unknown or never-allergy-checked food
- the same meat twice in a day
- a main repeated from yesterday

It reports **warnings** for:
- a day more than 400 kcal off target
- protein short of target
- more than ~400g of yogurt in a day
- a fridge or pantry lot expiring before the plan uses it

The calendar render puts the 💊 line on dinner. The before-bed line lists freezer food the next day needs, skipping `fromFrozen` foods and counting the rest of today's planned meals.

## Costco Same-Day (Instacart)
Groceries default to Costco Same-Day. `bun run costco` runs Instacart's own persisted GraphQL
inside Adam's logged-in Chrome (hashes are read from the site's operation-hashes chunk
each run, so redeploys don't break it). Foods map to SKUs with `foods.json → costco { id, g, name }`.

```bash
bun run costco show                  # cart contents + catalog-price estimate
bun run costco cart [--dry-run]      # plan groceries (Buy list) → packs → cart; never lowers a quantity, safe to rerun
bun run costco add honey 1
```
Never-counted foods and foods without a SKU are skipped and listed. **Checkout isn't automated yet.**
The cart is filled, then Adam taps checkout (or the agent clicks through after he OKs the total).
When the order arrives, log each line with `kitchen buy … --source costco`.

## Autopilot (runbook for a scheduled task)
Run nightly (~21:00) as a Codex Scheduled task against this repo (AGENTS.md → Automations):
1. `bun run plan show`. Mark known trips/eating-out days with `plan away` (check the calendar for travel).
2. Make sure the next 3 non-away days are planned: `plan draft --from <first unplanned> --days N --write`. If `plan check` reports errors, redraft with another seed. Read the warnings and give expiring lots a slot (`plan swap`).
3. For each new or changed day, render `plan calendar <date> --json` and create or update the gcal events. Meals are `transparent`; reuse `slot.gcal` ids, then `plan gcal` new ones.
4. `bun run costco cart` for the window. If anything was added, message Adam the cart summary and total so he can check out.
5. If the last photo count is over ~7 days old, ask Adam for fridge/freezer/pantry photos and `kitchen count` from them.

## Not built yet
- Autonomous checkout (needs the InitializeCheckout/FinalizeCheckout variables, captured from one real checkout) plus a spend cap.
- Morning check-in and auto-redraft when a slot is skipped.
- Receipt ingestion straight from email (today the agent reads the photo and runs `kitchen buy`).
