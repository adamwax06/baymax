<p align="center">
  <img src="branding/helmet.png" width="440" alt="Baymax helmet, pencil sketch">
</p>

# baymax

Healthmaxxing. A local, agent-first personal health platform with two data
streams: Apple Health (Apple Watch, Strava, Eight Sleep → iPhone sync app)
and hand-edited JSON logs (gym sessions, food, goals) — all landing
in a SQLite database on your Mac, exposed to coding agents through a typed
SDK, a CLI, and MCP tools. On top: an adaptive nutrition controller that
solves your real TDEE from your own intake + scale data and prescribes
calories toward your goals. No cloud, no accounts.

```
Watch / Strava / Eight Sleep / weigh-ins → Apple Health → iPhone app ─┐
gym log (hand-edited JSON) ─────────────────────── bun run import ────┤→ SQLite → SDK → CLI + MCP
food · goals · profile · allergies (JSON, read live) ─────────────────┘
```

## Quickstart (no phone needed)

```bash
bun install
bun run seed                                  # 60 days of realistic fixture data
bun run import                                # the committed gym + weigh-in logs
bun run health overview                       # the full picture in one call
bun run health lifts --exercise bench         # 4 years of strength progression
bun run health nutrition                      # adaptive calorie/protein targets
```

For real Apple Health data: `bun run dev` on the Mac, build `ios/` onto your
iPhone, tap Sync. Everything else — repo map, data model, logging flows,
how to add a metric, troubleshooting — is in **[AGENTS.md](AGENTS.md)**.
