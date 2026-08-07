import { z } from "zod";
import { KG_PER_LB } from "./nutrition.ts";

export const clinicalMetricZ = z.enum([
  "height",
  "body_mass",
  "bmi",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "body_temperature",
  "respiratory_rate",
  "oxygen_saturation",
  "heart_rate",
  "blood_glucose",
]);

export type ClinicalMetric = z.infer<typeof clinicalMetricZ>;

const localDateTimeZ = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

export const reviewedClinicalFileZ = z.object({
  schemaVersion: z.literal(1),
  records: z.array(
    z.object({
      sourceFile: z.string().min(1),
      localStart: localDateTimeZ,
      timeZone: z.string().min(1),
      precision: z.enum(["date", "minute"]),
      note: z.string().min(1),
      revision: z.number().int().positive().default(1),
      observations: z.array(
        z.object({
          metric: clinicalMetricZ,
          value: z.number().finite(),
          unit: z.string().min(1),
          group: z.string().min(1).optional(),
        }),
      ),
    }),
  ),
});

export type ReviewedClinicalFile = z.infer<typeof reviewedClinicalFileZ>;

export const clinicalMeasurementZ = z.object({
  id: z.string().min(1),
  syncVersion: z.number().int().positive(),
  metric: clinicalMetricZ,
  type: z.string().startsWith("HKQuantityTypeIdentifier"),
  value: z.number().finite(),
  unit: z.string().min(1),
  localStart: localDateTimeZ,
  localEnd: localDateTimeZ,
  timeZone: z.string().min(1),
  groupId: z.string().min(1).optional(),
  provenance: z.object({
    provider: z.string().min(1),
    sourceFile: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    extraction: z.enum(["embedded-text", "manual-review"]),
    encounterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    originalValue: z.number().finite(),
    originalUnit: z.string().min(1),
    note: z.string().optional(),
  }),
});

export type ClinicalMeasurement = z.infer<typeof clinicalMeasurementZ>;

export const clinicalBackfillFileZ = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  parser: z.literal("clinical-archive-v1"),
  measurements: z.array(clinicalMeasurementZ),
  report: z.object({
    acquisitions: z.number().int().nonnegative(),
    embeddedVitalSets: z.number().int().nonnegative(),
    reviewedVitalSets: z.number().int().nonnegative(),
    measurements: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
});

export type ClinicalBackfillFile = z.infer<typeof clinicalBackfillFileZ>;

const METRIC_DEFS: Record<ClinicalMetric, { hkType: string; unit: string; min: number; max: number }> = {
  height: { hkType: "HKQuantityTypeIdentifierHeight", unit: "m", min: 0.5, max: 2.5 },
  body_mass: { hkType: "HKQuantityTypeIdentifierBodyMass", unit: "kg", min: 10, max: 400 },
  bmi: { hkType: "HKQuantityTypeIdentifierBodyMassIndex", unit: "count", min: 5, max: 100 },
  blood_pressure_systolic: {
    hkType: "HKQuantityTypeIdentifierBloodPressureSystolic",
    unit: "mmHg",
    min: 20,
    max: 300,
  },
  blood_pressure_diastolic: {
    hkType: "HKQuantityTypeIdentifierBloodPressureDiastolic",
    unit: "mmHg",
    min: 20,
    max: 200,
  },
  body_temperature: { hkType: "HKQuantityTypeIdentifierBodyTemperature", unit: "degC", min: 30, max: 45 },
  respiratory_rate: { hkType: "HKQuantityTypeIdentifierRespiratoryRate", unit: "count/min", min: 2, max: 80 },
  oxygen_saturation: { hkType: "HKQuantityTypeIdentifierOxygenSaturation", unit: "%", min: 0, max: 1 },
  heart_rate: { hkType: "HKQuantityTypeIdentifierHeartRate", unit: "count/min", min: 20, max: 300 },
  blood_glucose: { hkType: "HKQuantityTypeIdentifierBloodGlucose", unit: "mg/dL", min: 10, max: 1000 },
};

export interface ClinicalSource {
  provider: string;
  providerSlug: string;
  sourceFile: string;
  sourceSha256: string;
}

interface InputObservation {
  metric: ClinicalMetric;
  value: number;
  unit: string;
  group?: string;
}

interface MeasurementSet {
  localStart: string;
  timeZone: string;
  precision: "date" | "minute";
  revision: number;
  extraction: "embedded-text" | "manual-review";
  note?: string;
  observations: InputObservation[];
}

function round(value: number, places = 8): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function canonicalValue(metric: ClinicalMetric, value: number, unit: string): number {
  const normalizedUnit = unit.trim().toLowerCase();
  let result: number;
  switch (metric) {
    case "height":
      if (["in", "inch", "inches"].includes(normalizedUnit)) result = value * 0.0254;
      else if (normalizedUnit === "cm") result = value / 100;
      else if (normalizedUnit === "m") result = value;
      else throw new Error(`Unsupported height unit: ${unit}`);
      break;
    case "body_mass":
      if (["lb", "lbs", "pound", "pounds"].includes(normalizedUnit)) result = value * KG_PER_LB;
      else if (normalizedUnit === "kg") result = value;
      else throw new Error(`Unsupported body-mass unit: ${unit}`);
      break;
    case "body_temperature":
      if (["degf", "f", "°f"].includes(normalizedUnit)) result = ((value - 32) * 5) / 9;
      else if (["degc", "c", "°c"].includes(normalizedUnit)) result = value;
      else throw new Error(`Unsupported temperature unit: ${unit}`);
      break;
    case "oxygen_saturation":
      if (["%", "percent"].includes(normalizedUnit)) result = value / 100;
      else if (normalizedUnit === "fraction") result = value;
      else throw new Error(`Unsupported oxygen-saturation unit: ${unit}`);
      break;
    case "blood_glucose":
      if (["mg/dl", "mg/dl glucose"].includes(normalizedUnit)) result = value;
      else if (["mmol/l", "mmol/l glucose"].includes(normalizedUnit)) result = value * 18.01559;
      else throw new Error(`Unsupported blood-glucose unit: ${unit}`);
      break;
    default:
      result = value;
  }

  const def = METRIC_DEFS[metric];
  if (result < def.min || result > def.max) {
    throw new Error(`${metric} value ${value} ${unit} is outside the parser safety bounds`);
  }
  return round(result);
}

function metricToken(metric: ClinicalMetric): string {
  return metric.replaceAll("_", "-");
}

function createMeasurements(set: MeasurementSet, source: ClinicalSource): ClinicalMeasurement[] {
  const encounterDate = set.localStart.slice(0, 10);
  const baseId = `baymax.clinical.${source.providerSlug}.${set.localStart}`;
  const seen = new Map<ClinicalMetric, number>();
  return set.observations.map((observation) => {
    const sequence = seen.get(observation.metric) ?? 0;
    seen.set(observation.metric, sequence + 1);
    const suffix = sequence === 0 ? "" : `.${sequence + 1}`;
    const id = `${baseId}.${metricToken(observation.metric)}${suffix}`;
    const def = METRIC_DEFS[observation.metric];
    return clinicalMeasurementZ.parse({
      id,
      syncVersion: set.revision,
      metric: observation.metric,
      type: def.hkType,
      value: canonicalValue(observation.metric, observation.value, observation.unit),
      unit: def.unit,
      localStart: set.localStart,
      localEnd: set.localStart,
      timeZone: set.timeZone,
      groupId: observation.group ? `${baseId}.${observation.group}` : undefined,
      provenance: {
        provider: source.provider,
        sourceFile: source.sourceFile,
        sourceSha256: source.sourceSha256,
        extraction: set.extraction,
        encounterDate,
        originalValue: observation.value,
        originalUnit: observation.unit,
        note: set.note,
      },
    });
  });
}

function expandYear(twoDigit: number): number {
  return twoDigit >= 70 ? 1900 + twoDigit : 2000 + twoDigit;
}

function localIso(date: string, time: string): string {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date);
  const timeMatch = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(time);
  if (!dateMatch || !timeMatch) throw new Error(`Unsupported Lehigh date/time: ${date} ${time}`);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3]!.toUpperCase();
  if (hour === 12) hour = 0;
  if (meridiem === "PM") hour += 12;
  return `${expandYear(Number(dateMatch[3]))}-${dateMatch[1]}-${dateMatch[2]}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function field(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

function observationsFromVitals(text: string): InputObservation[] {
  const observations: InputObservation[] = [];
  const height = field(text, /Height with Units:\s*([\d.]+)\s*in\.?/i);
  const weight = field(text, /Weight with Units:\s*([\d.]+)\s*lbs?\.?/i);
  const bmi = field(text, /\bBMI:\s*([\d.]+)/i);
  const systolic = field(text, /\bSystolic:\s*([\d.]+)/i) ?? field(text, /\bBP:\s*([\d.]+)\s*\//i);
  const diastolic = field(text, /\bDiastolic:\s*([\d.]+)/i) ?? field(text, /\bBP:\s*[\d.]+\s*\/\s*([\d.]+)/i);
  const temperature = field(text, /\bTemperature:\s*([\d.]+)/i);
  const respiration = field(text, /\bRespiration:\s*([\d.]+)/i);
  const oximetry = field(text, /\bOximetry:\s*([\d.]+)/i);
  const pulse = field(text, /\bPulse:\s*([\d.]+)/i);

  if (height !== undefined) observations.push({ metric: "height", value: height, unit: "in" });
  if (weight !== undefined) observations.push({ metric: "body_mass", value: weight, unit: "lb" });
  if (bmi !== undefined) observations.push({ metric: "bmi", value: bmi, unit: "count" });
  if (systolic !== undefined) observations.push({ metric: "blood_pressure_systolic", value: systolic, unit: "mmHg", group: "blood-pressure" });
  if (diastolic !== undefined) observations.push({ metric: "blood_pressure_diastolic", value: diastolic, unit: "mmHg", group: "blood-pressure" });
  if (temperature !== undefined) observations.push({ metric: "body_temperature", value: temperature, unit: "degF" });
  if (respiration !== undefined) observations.push({ metric: "respiratory_rate", value: respiration, unit: "count/min" });
  if (oximetry !== undefined) observations.push({ metric: "oxygen_saturation", value: oximetry, unit: "%" });
  if (pulse !== undefined) observations.push({ metric: "heart_rate", value: pulse, unit: "count/min" });
  return observations;
}

export interface ParsedLehighChart {
  measurements: ClinicalMeasurement[];
  vitalSets: number;
  warnings: string[];
}

/** Parse the full encounter notes in Lehigh's portal-generated Chart.pdf text. */
export function parseLehighChartText(text: string, source: ClinicalSource): ParsedLehighChart {
  const header = /^Encounter Date:\s*(\d{2}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2}\s+[AP]M)\s*$/gim;
  const matches = [...text.matchAll(header)];
  const measurements: ClinicalMeasurement[] = [];
  const warnings: string[] = [];
  let vitalSets = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const block = text.slice(match.index! + match[0].length, matches[i + 1]?.index ?? text.length);
    const vitalsStart = /\bObjective\s+Vitals\s+/i.exec(block);
    if (!vitalsStart) {
      warnings.push(`No vitals section found for encounter ${match[1]}`);
      continue;
    }
    const afterVitals = block.slice(vitalsStart.index + vitalsStart[0].length).split(/Provider's Exam Note|\nAssessment\b/i)[0]!;
    const setPattern = /([\s\S]*?)Date Taken:\s*(\d{2}\/\d{2}\/\d{2})\s+(\d{1,2}:\d{2}\s+[AP]M)/gi;
    const sets = [...afterVitals.matchAll(setPattern)];
    if (sets.length === 0) {
      warnings.push(`No dated vital set found for encounter ${match[1]}`);
      continue;
    }
    for (const setMatch of sets) {
      const observations = observationsFromVitals(setMatch[1]!);
      if (observations.length === 0) {
        warnings.push(`Dated vital set ${setMatch[2]} ${setMatch[3]} contained no recognized measurements`);
        continue;
      }
      const set: MeasurementSet = {
        localStart: localIso(setMatch[2]!, setMatch[3]!),
        timeZone: "America/New_York",
        precision: "minute",
        revision: 1,
        extraction: "embedded-text",
        observations,
      };
      measurements.push(...createMeasurements(set, source));
      vitalSets += 1;
    }
  }

  return { measurements, vitalSets, warnings };
}

export function parseReviewedClinicalFile(
  input: unknown,
  sources: Map<string, ClinicalSource>,
): { measurements: ClinicalMeasurement[]; vitalSets: number } {
  const reviewed = reviewedClinicalFileZ.parse(input);
  const measurements: ClinicalMeasurement[] = [];
  for (const record of reviewed.records) {
    const source = sources.get(record.sourceFile);
    if (!source) throw new Error(`Reviewed clinical record references a file absent from the manifest: ${record.sourceFile}`);
    measurements.push(
      ...createMeasurements(
        {
          localStart: record.localStart,
          timeZone: record.timeZone,
          precision: record.precision,
          revision: record.revision,
          extraction: "manual-review",
          note: record.note,
          observations: record.observations,
        },
        source,
      ),
    );
  }
  return { measurements, vitalSets: reviewed.records.length };
}

export function assertUniqueClinicalMeasurements(measurements: ClinicalMeasurement[]): void {
  const ids = new Set<string>();
  for (const measurement of measurements) {
    if (ids.has(measurement.id)) throw new Error(`Duplicate clinical measurement id: ${measurement.id}`);
    ids.add(measurement.id);
  }
}
