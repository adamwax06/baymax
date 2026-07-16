// Adaptive nutrition targets: seed from Mifflin-St Jeor, switch to an
// empirical energy-balance TDEE once enough paired intake + weigh-in data
// exists. All formulas are named in the output; nothing is a black box.

export const KCAL_PER_LB = 3500;

/** Mifflin-St Jeor BMR (kcal/day). */
export function mifflinStJeor(kg: number, cm: number, ageYears: number, sex: "male" | "female"): number {
  return 10 * kg + 6.25 * cm - 5 * ageYears + (sex === "male" ? 5 : -161);
}

export function ageYears(birthdate: string, nowMs: number): number {
  const b = new Date(birthdate + "T00:00:00");
  const now = new Date(nowMs);
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

/** Least-squares slope over (tsMs, value) points, in value-units per day. */
export function slopePerDay(points: { ts: number; value: number }[]): number | null {
  if (points.length < 2) return null;
  const days = points.map((p) => p.ts / 86_400_000);
  const meanX = days.reduce((a, b) => a + b, 0) / days.length;
  const meanY = points.reduce((a, p) => a + p.value, 0) / points.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < points.length; i++) {
    num += (days[i]! - meanX) * (points[i]!.value - meanY);
    den += (days[i]! - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

/**
 * Energy-balance TDEE: what you ate minus what the scale says you stored.
 * TDEE = avg intake − slope(lb/day) × 3500.
 */
export function empiricalTdee(avgKcal: number, weightSlopeLbPerDay: number): number {
  return avgKcal - weightSlopeLbPerDay * KCAL_PER_LB;
}

/** Calorie target for a desired rate of weight change. */
export function targetKcal(tdee: number, ratePerWeekLb: number): number {
  return Math.round((tdee + (ratePerWeekLb * KCAL_PER_LB) / 7) / 10) * 10;
}

/** Daily protein target: 0.9 g per lb of body weight. */
export function proteinTarget(weightLb: number): number {
  return Math.round(0.9 * weightLb);
}
