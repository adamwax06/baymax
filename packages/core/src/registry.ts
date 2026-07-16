/**
 * The metric registry: the one file to edit when adding support for a
 * HealthKit type. Each entry needs a matching line in ios/Baymax/SyncedTypes.swift
 * (with an HKUnit whose unitString matches `unit`). The schema never changes.
 */

export type AggregationKind = "sum" | "avg" | "latest" | "sleep";

export interface MetricDef {
  /** Friendly name used by CLI/MCP/SDK, e.g. "heart_rate". */
  name: string;
  /** Full HealthKit identifier, e.g. "HKQuantityTypeIdentifierHeartRate". */
  hkType: string;
  kind: "quantity" | "category";
  /** Storage/display unit (matches the HKUnit the phone converts to); null for category types. */
  unit: string | null;
  /** How `trend` aggregates per day. For category metrics, "sum" counts events. */
  aggregation: AggregationKind;
  description: string;
  /** Raw HealthKit category value -> name; only for category metrics. */
  categoryValues?: Record<number, string>;
}

export const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

// The three structures below describe the same raw HealthKit sleep values —
// keep them in lockstep. SLEEP_VALUES decodes names for display; the stage
// map and asleep set drive night derivation in sleep.ts.
const SLEEP_VALUES: Record<number, string> = {
  0: "inBed",
  1: "asleepUnspecified",
  2: "awake",
  3: "asleepCore",
  4: "asleepDeep",
  5: "asleepREM",
};

export const SLEEP_IN_BED = 0;
export const SLEEP_STAGE_BY_VALUE: Record<number, "unspecified" | "awake" | "core" | "deep" | "rem"> = {
  1: "unspecified",
  2: "awake",
  3: "core",
  4: "deep",
  5: "rem",
};
export const SLEEP_ASLEEP_VALUES: ReadonlySet<number> = new Set([1, 3, 4, 5]);

export const METRICS: readonly MetricDef[] = [
  { name: "heart_rate", hkType: "HKQuantityTypeIdentifierHeartRate", kind: "quantity", unit: "count/min", aggregation: "avg", description: "Heart rate (bpm) from whatever wearable is active (check health_sources for provenance)" },
  { name: "resting_heart_rate", hkType: "HKQuantityTypeIdentifierRestingHeartRate", kind: "quantity", unit: "count/min", aggregation: "avg", description: "Daily resting heart rate (bpm)" },
  { name: "walking_heart_rate_avg", hkType: "HKQuantityTypeIdentifierWalkingHeartRateAverage", kind: "quantity", unit: "count/min", aggregation: "avg", description: "Average walking heart rate (bpm)" },
  { name: "heart_rate_variability", hkType: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", kind: "quantity", unit: "ms", aggregation: "avg", description: "Heart rate variability SDNN (ms), mostly measured during sleep" },
  { name: "heart_rate_recovery", hkType: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute", kind: "quantity", unit: "count/min", aggregation: "avg", description: "1-minute heart rate recovery after workouts (bpm)" },
  { name: "steps", hkType: "HKQuantityTypeIdentifierStepCount", kind: "quantity", unit: "count", aggregation: "sum", description: "Step count. iPhone and Watch both record; trend uses the dominant source to avoid double counting" },
  { name: "distance_walking_running", hkType: "HKQuantityTypeIdentifierDistanceWalkingRunning", kind: "quantity", unit: "m", aggregation: "sum", description: "Walking + running distance (meters)" },
  { name: "distance_cycling", hkType: "HKQuantityTypeIdentifierDistanceCycling", kind: "quantity", unit: "m", aggregation: "sum", description: "Cycling distance (meters)" },
  { name: "active_energy", hkType: "HKQuantityTypeIdentifierActiveEnergyBurned", kind: "quantity", unit: "kcal", aggregation: "sum", description: "Active energy burned (kcal)" },
  { name: "basal_energy", hkType: "HKQuantityTypeIdentifierBasalEnergyBurned", kind: "quantity", unit: "kcal", aggregation: "sum", description: "Resting/basal energy burned (kcal)" },
  { name: "exercise_minutes", hkType: "HKQuantityTypeIdentifierAppleExerciseTime", kind: "quantity", unit: "min", aggregation: "sum", description: "Apple exercise ring minutes" },
  { name: "stand_minutes", hkType: "HKQuantityTypeIdentifierAppleStandTime", kind: "quantity", unit: "min", aggregation: "sum", description: "Apple stand minutes" },
  { name: "vo2_max", hkType: "HKQuantityTypeIdentifierVO2Max", kind: "quantity", unit: "mL/min·kg", aggregation: "latest", description: "Estimated VO2 max (mL/kg/min), updated after outdoor walks/runs" },
  { name: "respiratory_rate", hkType: "HKQuantityTypeIdentifierRespiratoryRate", kind: "quantity", unit: "count/min", aggregation: "avg", description: "Respiratory rate (breaths/min), measured during sleep" },
  { name: "oxygen_saturation", hkType: "HKQuantityTypeIdentifierOxygenSaturation", kind: "quantity", unit: "%", aggregation: "avg", description: "Blood oxygen saturation (0-1 fraction as %); Watch SE has no sensor but other devices may write it" },
  { name: "body_mass", hkType: "HKQuantityTypeIdentifierBodyMass", kind: "quantity", unit: "kg", aggregation: "latest", description: "Body weight (kg)" },
  { name: "body_fat", hkType: "HKQuantityTypeIdentifierBodyFatPercentage", kind: "quantity", unit: "%", aggregation: "latest", description: "Body fat percentage (0-1 fraction as %)" },
  { name: "bmi", hkType: "HKQuantityTypeIdentifierBodyMassIndex", kind: "quantity", unit: "count", aggregation: "latest", description: "Body mass index" },
  { name: "running_speed", hkType: "HKQuantityTypeIdentifierRunningSpeed", kind: "quantity", unit: "m/s", aggregation: "avg", description: "Running speed (m/s), recorded during running workouts" },
  { name: "running_power", hkType: "HKQuantityTypeIdentifierRunningPower", kind: "quantity", unit: "W", aggregation: "avg", description: "Running power (watts), recorded during running workouts" },
  { name: "sleep", hkType: SLEEP_TYPE, kind: "category", unit: null, aggregation: "sleep", description: "Sleep stages from sleep trackers (Eight Sleep, Watch, …). Queried as noon-to-noon nights, reported per source (never merged)", categoryValues: SLEEP_VALUES },
  { name: "high_heart_rate_events", hkType: "HKCategoryTypeIdentifierHighHeartRateEvent", kind: "category", unit: null, aggregation: "sum", description: "High heart rate notifications (event count)" },
  { name: "low_heart_rate_events", hkType: "HKCategoryTypeIdentifierLowHeartRateEvent", kind: "category", unit: null, aggregation: "sum", description: "Low heart rate notifications (event count)" },
  { name: "irregular_rhythm_events", hkType: "HKCategoryTypeIdentifierIrregularHeartRhythmEvent", kind: "category", unit: null, aggregation: "sum", description: "Irregular rhythm notifications (event count)" },
];

export function metricByName(name: string): MetricDef | undefined {
  return METRICS.find((m) => m.name === name);
}

export function metricByHkType(hkType: string): MetricDef | undefined {
  return METRICS.find((m) => m.hkType === hkType);
}

/** HKWorkoutActivityType raw values -> friendly names (common subset; falls back to unknown_<raw>). */
export const WORKOUT_ACTIVITY_TYPES: Record<number, string> = {
  1: "american_football", 2: "archery", 3: "australian_football", 4: "badminton",
  5: "baseball", 6: "basketball", 7: "bowling", 8: "boxing", 9: "climbing",
  10: "cricket", 11: "cross_training", 12: "curling", 13: "cycling",
  16: "elliptical", 17: "equestrian_sports", 18: "fencing", 19: "fishing",
  20: "functional_strength_training", 21: "golf", 22: "gymnastics", 23: "handball",
  24: "hiking", 25: "hockey", 26: "hunting", 27: "lacrosse", 28: "martial_arts",
  29: "mind_and_body", 31: "paddle_sports", 32: "play", 33: "preparation_and_recovery",
  34: "racquetball", 35: "rowing", 36: "rugby", 37: "running", 38: "sailing",
  39: "skating_sports", 40: "snow_sports", 41: "soccer", 42: "softball", 43: "squash",
  44: "stair_climbing", 45: "surfing_sports", 46: "swimming", 47: "table_tennis",
  48: "tennis", 49: "track_and_field", 50: "traditional_strength_training",
  51: "volleyball", 52: "walking", 53: "water_fitness", 54: "water_polo",
  55: "water_sports", 56: "wrestling", 57: "yoga", 58: "barre", 59: "core_training",
  60: "cross_country_skiing", 61: "downhill_skiing", 62: "flexibility",
  63: "high_intensity_interval_training", 64: "jump_rope", 65: "kickboxing",
  66: "pilates", 67: "snowboarding", 68: "stairs", 69: "step_training",
  70: "wheelchair_walk_pace", 71: "wheelchair_run_pace", 72: "tai_chi",
  73: "mixed_cardio", 74: "hand_cycling", 75: "disc_sports", 76: "fitness_gaming",
  77: "dance", 78: "social_dance", 79: "pickleball", 80: "cooldown",
  82: "swim_bike_run", 83: "transition", 84: "underwater_diving", 3000: "other",
};

export function workoutActivityName(raw: number): string {
  return WORKOUT_ACTIVITY_TYPES[raw] ?? `unknown_${raw}`;
}
