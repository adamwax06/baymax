# DoorDash ordering (dd-cli)

Adam Wax has an approved DoorDash CLI (`dd-cli`) account, off the waitlist as of
2026-07-29. Installed at `~/.local/bin/dd-cli` (on PATH via `.zshrc`), logged in
via `dd-cli login` (credentials cached in the macOS Keychain — no need to
re-run unless a call fails with an expired-token error). The Claude Code skill
is registered at `~/.claude/skills/dd-cli-usage/`.

Repo: https://github.com/doordash-oss/doordash-cli

## How ordering works here

Chat-driven, no app UI: ask an agent session to order something, and it shells
out to `dd-cli` directly (`search` → `menu`/`restaurant-item-details` → `cart`
→ `order preview` → confirm with Adam → `order submit`). No baymax
server/iOS changes — full in-app ordering (search/menu/cart screens) was
scoped and explicitly deferred.

`bun run sunday-plan --dry-run` can now produce a Costco grocery proposal
from planned meals. It deliberately stops before cart creation. The generated
artifact carries the Costco product id, package count, current price estimate,
and `substitutionPolicy: "none"`; a future apply command can resolve the
DoorDash item id and build the cart without changing planner behavior.

Every candidate item gets cross-checked against `data/profile.json` allergies
before being proposed — restaurant items are less controlled than home-cooked
`meals.json` recipes. `restaurant-item-details` exposes swappable
ingredients/modifiers (e.g. "No Cheese," meat choice), which can be used to
pick an allergen-free version instead of just avoiding the item outright.

Orders get logged as a deviation entry in `data/nutrition.json` (see
`docs/nutrition.md`), with macros **estimated** from the menu description —
see caveat below.

## Known dd-cli gaps (filed upstream)

- **No calorie/macro data anywhere in `menu` or `restaurant-item-details`
  output** — confirmed by testing, not just reading docs: even McDonald's
  (FDA-mandated calorie disclosure) returns no such field. DoorDash's own
  Menu API supports partner-submitted calorie ranges and the consumer app
  shows them when present; dd-cli doesn't surface it. Filed as
  [doordash-oss/doordash-cli#41](https://github.com/doordash-oss/doordash-cli/issues/41).
  Net effect: DoorDash orders will always be an *estimated* deviation, never
  an exact macro entry.
- **`address list` omits the unit/apartment number** (e.g. "Apt 3307") even
  though it's on the DoorDash account and used correctly at delivery time —
  purely a CLI display gap. Already filed as
  [doordash-oss/doordash-cli#27](https://github.com/doordash-oss/doordash-cli/issues/27).
  Default delivery address: 8 10th St #3307, San Francisco, CA 94103.

## Safety

`order submit` moves real money. Always run `order preview` and show Adam the
total, then wait for explicit confirmation before submitting — never
auto-order.
