import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema.ts";

export type BaymaxDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

export function defaultDbPath(): string {
  return process.env.BAYMAX_DB ?? join(import.meta.dir, "../../..", "data", "baymax.db");
}

export function openDb(opts: { path?: string; readonly?: boolean } = {}): BaymaxDb {
  const path = opts.path ?? defaultDbPath();
  if (opts.readonly && path !== ":memory:" && !existsSync(path)) {
    throw new Error(
      `No database at ${path}. Run \`bun run seed\` for fixture data, or start the server (\`bun run dev\`) and sync from the iPhone app.`,
    );
  }
  const client = new Database(path, opts.readonly ? { readonly: true } : { create: true });
  client.exec("PRAGMA busy_timeout = 5000;");
  if (!opts.readonly) client.exec("PRAGMA foreign_keys = ON;");
  return drizzle(client, { schema });
}

export function migrateDb(db: BaymaxDb): void {
  migrate(db, { migrationsFolder: join(import.meta.dir, "..", "drizzle") });
}
