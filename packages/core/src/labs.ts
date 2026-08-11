import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClinicalSource } from "./clinical.ts";

const dateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const labStatusZ = z.enum(["optimal", "average", "outOfRange"]);

export const labResultZ = z.object({
  id: z.string().min(1),
  markerKey: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  marker: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  referenceRange: z.object({
    text: z.string().min(1),
    low: z.number().finite().nullable(),
    high: z.number().finite().nullable(),
  }),
  status: labStatusZ,
  collectedOn: dateZ,
  precision: z.literal("date"),
  provider: z.string().min(1),
  provenance: z.object({
    sourceFile: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    archiveMember: z.string().min(1),
    row: z.number().int().min(2),
    extraction: z.literal("embedded-csv"),
  }),
});

export type LabStatus = z.infer<typeof labStatusZ>;
export type LabResult = z.infer<typeof labResultZ>;

export const labArchiveZ = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  parser: z.literal("clinical-labs-v1"),
  results: z.array(labResultZ),
  report: z.object({
    acquisitions: z.number().int().nonnegative(),
    csvMembers: z.number().int().nonnegative(),
    results: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
});

export type LabArchive = z.infer<typeof labArchiveZ>;

const RYTHM_MARKER_KEYS: Record<string, string> = {
  "Uric Acid": "uric_acid",
  Fructosamine: "fructosamine",
  GGT: "ggt",
  "Alkaline Phosphatase (ALP)": "alkaline_phosphatase",
  ApoB: "apob",
  Creatinine: "creatinine",
  "Thyroid Stimulating Hormone": "tsh",
  "Free T3": "free_t3",
  Triglycerides: "triglycerides",
  SHBG: "shbg",
  "HDL Cholesterol": "hdl_cholesterol",
  "Total Cholesterol": "total_cholesterol",
  "hs-CRP (High-Sensitivity C-Reactive Protein)": "hs_crp",
  Albumin: "albumin",
  "Vitamin D": "vitamin_d",
  "Total Testosterone": "total_testosterone",
  Ferritin: "ferritin",
  Estrogen: "estrogen",
  "Free Testosterone": "free_testosterone",
  "LDL Cholesterol": "ldl_cholesterol",
  "eGFR (Estimated Glomerular Filtration Rate)": "egfr",
  "LDL/ApoB Ratio": "ldl_apob_ratio",
  "Total Cholesterol/HDL Ratio": "total_cholesterol_hdl_ratio",
  "Triglycerides/HDL Ratio": "triglycerides_hdl_ratio",
  "Remnant Cholesterol": "remnant_cholesterol",
};

function genericMarkerKey(marker: string): string {
  const key = marker
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) throw new Error(`Cannot derive a lab marker key from "${marker}"`);
  return key;
}

export function labMarkerKey(marker: string): string {
  return RYTHM_MARKER_KEYS[marker] ?? genericMarkerKey(marker);
}

/** Small RFC 4180 reader used at the clinical-import boundary. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV ended inside a quoted field");
  if (field.length || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.length > 0));
}

function parseReferenceRange(text: string): { text: string; low: number | null; high: number | null } {
  const trimmed = text.trim();
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const match = new RegExp(`^\\s*(${number})\\s*-\\s*(${number})\\s*$`).exec(trimmed);
  if (!match) return { text: trimmed, low: null, high: null };
  return { text: trimmed, low: Number(match[1]), high: Number(match[2]) };
}

function assertDate(date: string, context: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`${context}: invalid collection date "${date}"`);
  }
}

export function parseRythmLabCsv(
  text: string,
  source: ClinicalSource,
  archiveMember: string,
): LabResult[] {
  const rows = parseCsvRows(text);
  const expected = ["marker", "value", "unit", "reference_range", "status", "time"];
  if (rows.length === 0 || rows[0]!.map((cell) => cell.trim()).join("\u0000") !== expected.join("\u0000")) {
    throw new Error(`Rythm CSV ${archiveMember} has an unsupported header; expected ${expected.join(",")}`);
  }

  const memberToken = createHash("sha256").update(archiveMember).digest("hex").slice(0, 12);
  return rows.slice(1).map((cells, index) => {
    const rowNumber = index + 2;
    const context = `Rythm CSV ${archiveMember} row ${rowNumber}`;
    if (cells.length !== expected.length) throw new Error(`${context}: expected ${expected.length} columns, found ${cells.length}`);
    const [markerRaw, valueRaw, unitRaw, rangeRaw, statusRaw, dateRaw] = cells;
    const marker = markerRaw!.trim();
    const unit = unitRaw!.trim();
    const collectedOn = dateRaw!.trim();
    const value = Number(valueRaw);
    if (!marker) throw new Error(`${context}: marker is empty`);
    if (!Number.isFinite(value)) throw new Error(`${context}: value "${valueRaw}" is not numeric`);
    if (!unit) throw new Error(`${context}: unit is empty`);
    assertDate(collectedOn, context);
    const status = labStatusZ.parse(statusRaw!.trim());
    const markerKey = labMarkerKey(marker);

    return labResultZ.parse({
      id: `baymax.lab.${source.providerSlug}.${collectedOn}.${markerKey}.${memberToken}.${rowNumber}`,
      markerKey,
      marker,
      value,
      unit,
      referenceRange: parseReferenceRange(rangeRaw!),
      status,
      collectedOn,
      precision: "date",
      provider: source.provider,
      provenance: {
        sourceFile: source.sourceFile,
        sourceSha256: source.sourceSha256,
        archiveMember,
        row: rowNumber,
        extraction: "embedded-csv",
      },
    });
  });
}

export function assertUniqueLabResults(results: LabResult[]): void {
  const ids = new Set<string>();
  for (const result of results) {
    if (ids.has(result.id)) throw new Error(`Duplicate lab result id: ${result.id}`);
    ids.add(result.id);
  }
}
