<p align="center">
  <img src="branding/baymax-sketch.png" width="440" alt="Baymax helmet, pencil sketch">
</p>

# baymax

Healthmaxxing. A local, agent-first personal health data platform:
Apple Watch, Strava, and Eight Sleep flow through Apple Health into a SQLite
database on your Mac, exposed to coding agents through a typed SDK, a CLI, and
MCP tools. No cloud, no accounts.

```
Apple Watch / Strava / Eight Sleep → Apple Health → iPhone sync app → Hono → SQLite → SDK → CLI + MCP
```

## Quickstart (no phone needed)

```bash
bun install
bun run seed                                  # 60 days of realistic fixture data
bun run health status
bun run health sleep --days 7
bun run health trend --metric steps --days 30
```

For real data: `bun run dev` on the Mac, build `ios/` onto your iPhone, tap
Sync. Everything else — repo map, data model, how to add a metric, sync
internals, troubleshooting — is in **[AGENTS.md](AGENTS.md)**.
