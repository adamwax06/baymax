export const DAY_MS = 86_400_000;

export const round1 = (n: number): number => Math.round(n * 10) / 10;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-timezone YYYY-MM-DD for an epoch-ms timestamp. */
export function localDateStr(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-timezone ISO-ish "YYYY-MM-DD HH:MM" for an epoch-ms timestamp. */
export function localDateTimeStr(tsMs: number): string {
  const d = new Date(tsMs);
  return `${localDateStr(tsMs)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Every local date from `fromTs` through `toTs`, inclusive (DST-safe). */
export function localDateRange(fromTs: number, toTs: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(fromTs);
  cursor.setHours(12, 0, 0, 0); // noon avoids DST edge cases when stepping days
  const last = localDateStr(toTs);
  while (true) {
    const date = localDateStr(cursor.getTime());
    dates.push(date);
    if (date === last || dates.length > 4000) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}
