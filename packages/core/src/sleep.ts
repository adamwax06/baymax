import { and, eq, gte, type SQL } from "drizzle-orm";
import type { BaymaxDb } from "./db.ts";
import { samples, sources } from "./schema.ts";
import { DAY_MS, localDateStr, localDateTimeStr } from "./time.ts";
import type { SleepNight } from "./types.ts";

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
const IN_BED = 0;
const STAGE_BY_VALUE: Record<number, keyof SleepNight["stages"]> = {
  1: "unspecified",
  2: "awake",
  3: "core",
  4: "deep",
  5: "rem",
};
const ASLEEP_VALUES = new Set([1, 3, 4, 5]);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Groups sleepAnalysis samples into noon-to-noon local "nights", per source.
 * A night's date is the local day it started (11pm Jul 14 and 1am Jul 15 both
 * land on night "2026-07-14"). Sources are never merged: Apple Watch and
 * Eight Sleep each get their own row per night.
 */
export function deriveSleepNights(
  db: BaymaxDb,
  opts: { days: number; source?: string; now?: number },
): SleepNight[] {
  const now = opts.now ?? Date.now();
  const conds: SQL[] = [eq(samples.type, SLEEP_TYPE), gte(samples.startTs, now - (opts.days + 1) * DAY_MS)];
  if (opts.source) conds.push(eq(sources.bundleId, opts.source));
  const rows = db
    .select({
      value: samples.value,
      startTs: samples.startTs,
      endTs: samples.endTs,
      source: sources.bundleId,
      sourceName: sources.name,
    })
    .from(samples)
    .innerJoin(sources, eq(samples.sourceId, sources.id))
    .where(and(...conds))
    .orderBy(samples.startTs)
    .all();

  const acc = new Map<string, SleepNight & { _start: number; _end: number }>();
  for (const r of rows) {
    if (r.value == null) continue;
    const night = localDateStr(r.startTs - DAY_MS / 2);
    const key = `${night}|${r.source}`;
    let n = acc.get(key);
    if (!n) {
      n = {
        night,
        source: r.source,
        sourceName: r.sourceName,
        inBedMinutes: 0,
        asleepMinutes: 0,
        stages: { core: 0, deep: 0, rem: 0, awake: 0, unspecified: 0 },
        bedtime: "",
        waketime: "",
        efficiency: null,
        _start: r.startTs,
        _end: r.endTs,
      };
      acc.set(key, n);
    }
    const minutes = (r.endTs - r.startTs) / 60_000;
    const value = r.value;
    if (value === IN_BED) n.inBedMinutes += minutes;
    if (ASLEEP_VALUES.has(value)) n.asleepMinutes += minutes;
    const stage = STAGE_BY_VALUE[value];
    if (stage) n.stages[stage] += minutes;
    n._start = Math.min(n._start, r.startTs);
    n._end = Math.max(n._end, r.endTs);
  }

  const oldestNight = localDateStr(now - opts.days * DAY_MS);
  return [...acc.values()]
    .filter((n) => n.night >= oldestNight)
    .sort((a, b) => (a.night === b.night ? a.source.localeCompare(b.source) : b.night.localeCompare(a.night)))
    .map(({ _start, _end, ...n }) => ({
      ...n,
      inBedMinutes: round1(n.inBedMinutes),
      asleepMinutes: round1(n.asleepMinutes),
      stages: Object.fromEntries(Object.entries(n.stages).map(([k, v]) => [k, round1(v)])) as SleepNight["stages"],
      bedtime: localDateTimeStr(_start),
      waketime: localDateTimeStr(_end),
      efficiency: n.inBedMinutes > 0 ? Math.round((n.asleepMinutes / n.inBedMinutes) * 100) / 100 : null,
    }));
}
