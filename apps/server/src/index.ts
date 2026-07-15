import { networkInterfaces } from "node:os";
import { migrateDb, openDb } from "@baymax/core";
import { createApp } from "./app.ts";

const db = openDb();
migrateDb(db);

const port = Number(process.env.PORT ?? 4321);
Bun.serve({ hostname: "0.0.0.0", port, fetch: createApp(db).fetch });

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === "IPv4" && !i.internal)?.address;
console.log(`baymax server listening on http://0.0.0.0:${port}`);
if (lanIp) console.log(`iPhone app server URL: http://${lanIp}:${port}`);
