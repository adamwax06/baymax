---
name: tj
description: Build a Trader Joe's grocery list from Adam's meals with live prices/availability at his store (Hayes Valley #226). Use when asked for a grocery/shopping list, "what should I buy", TJ prices, or whether TJ carries something.
---

# Trader Joe's grocery list

## Tools

`bun run tj <search terms>` — searches products available at Adam's TJ's
(store 226, 788 Laguna St; override with `TJ_STORE=<code>`). Output per line:
`$price  name  size  category  #sku`. It drives Adam's real Chrome via
AppleScript (TJ's API blocks everything else), so Chrome must be running and
this Bash call needs sandbox disabled. If it reports Chrome blocked
scripting, tell Adam to enable View > Developer > Allow JavaScript from
Apple Events.

## Workflow

1. Scope: ask how many days if not stated (default a week). Meals live in
   `data/meals.json` (ingredient refs by food id + grams), foods in
   `data/foods.json`.
2. Aggregate grams per food across the planned meals, subtract what's on hand
   in `data/inventory.json` (treat entries as estimates — an `asOf` older
   than ~a week or an UNVERIFIED note means confirm with Adam, don't trust
   silently), then convert the remainder to purchasable units using the
   package size from the `tj` search result (round up).
   After a haul: when Adam sends a receipt photo, update `inventory.json`
   from it (overwrite amounts, set `asOf`) — it's a snapshot, not a ledger.
3. Search each item with `bun run tj`. Not everything maps 1:1 — pick the
   closest product and say so. Items with no match go in a "not at TJ's"
   section, don't silently drop them.
4. **Allergy gate (medical, never skip):** check `data/profile.json` diet
   before finalizing. Currently: no avocado fruit (refined avocado oil IS
   fine), no watermelon, no banana, no bell peppers (jalapeños/hot
   sauce/paprika/salsa are safe), soy protein isolate questionable. For
   packaged foods also consider may-contain/shared-facility risk — pea
   protein is the biggest hidden one. Read the profile fresh each time; it
   changes.
5. Output: list grouped by category with price each and estimated total.
   "Available" means the store carries it, not live shelf stock — say so if
   asked.
6. If Adam wants it on his phone, write the list to Apple Reminders or Notes
   via `osascript` (sandbox disabled).
