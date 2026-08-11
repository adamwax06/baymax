import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  assertUniqueLabResults,
  assertUniqueClinicalMeasurements,
  clinicalBackfillFileZ,
  labArchiveZ,
  parseLehighChartText,
  parseRythmLabCsv,
  parseReviewedClinicalFile,
  type ClinicalSource,
  type LabResult,
} from "@baymax/core";

const manifestZ = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ name: z.string().min(1) }),
  acquiredAt: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

function argValue(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function extractPdfText(path: string): string {
  const result = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`pdftotext failed for ${basename(path)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

function zipCsvMembers(path: string): string[] {
  const result = Bun.spawnSync(["unzip", "-Z1", path]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`Could not list CSV files in ${basename(path)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout
    .toString()
    .split(/\r?\n/)
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .sort();
}

function extractZipMember(path: string, member: string): string {
  const result = Bun.spawnSync(["unzip", "-p", path, member]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`Could not read ${member} from ${basename(path)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

const repoRoot = resolve(import.meta.dir, "..");
const sourcesRoot = join(repoRoot, "data/clinical/sources");
const outputPath = resolve(argValue("--output") ?? join(repoRoot, "data/clinical/normalized/apple-health.json"));
const labOutputPath = resolve(argValue("--lab-output") ?? join(repoRoot, "data/clinical/normalized/labs.json"));
const checkOnly = Bun.argv.includes("--check");

function latestAcquisitionDirs(): string[] {
  if (!existsSync(sourcesRoot)) return [];
  return readdirSync(sourcesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((provider) => {
      const providerRoot = join(sourcesRoot, provider.name);
      const latest = readdirSync(providerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .at(-1);
      return latest ? join(providerRoot, latest) : undefined;
    })
    .filter((path): path is string => path !== undefined)
    .sort();
}

const sourceArg = argValue("--source");
const sourceDirs = sourceArg ? [resolve(sourceArg)] : latestAcquisitionDirs();
if (sourceDirs.length === 0) throw new Error(`No clinical acquisitions found under ${sourcesRoot}`);

const measurements = [] as ReturnType<typeof parseReviewedClinicalFile>["measurements"];
const labResults: LabResult[] = [];
const warnings: string[] = [];
let embeddedVitalSets = 0;
let reviewedVitalSets = 0;
let labAcquisitions = 0;
let csvMembers = 0;

for (const sourceDir of sourceDirs) {
  const manifestPath = join(sourceDir, "manifest.local.json");
  if (!existsSync(manifestPath)) throw new Error(`No clinical manifest at ${manifestPath}`);
  const manifest = manifestZ.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const providerSlug = basename(dirname(sourceDir));
  const acquisitionLabel = `${providerSlug}/${basename(sourceDir)}`;
  const sources = new Map<string, ClinicalSource>();

  for (const file of manifest.files) {
    const absolutePath = join(sourceDir, file.path);
    if (!existsSync(absolutePath)) throw new Error(`Manifest file is missing: ${absolutePath}`);
    const bytes = readFileSync(absolutePath);
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`Byte-count mismatch for ${file.path}; refusing to parse a changed original`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== file.sha256) {
      throw new Error(`SHA-256 mismatch for ${file.path}; refusing to parse a changed original`);
    }
    sources.set(file.path, {
      provider: manifest.source.name,
      providerSlug,
      sourceFile: relative(join(repoRoot, "data/clinical"), absolutePath),
      sourceSha256: actualHash,
    });
  }

  if (providerSlug === "lehigh-health-wellness") {
    const chartFile = manifest.files.find((file) => file.kind === "complete-chart");
    if (!chartFile) throw new Error("The Lehigh manifest has no complete-chart file");
    const chart = parseLehighChartText(
      extractPdfText(join(sourceDir, chartFile.path)),
      sources.get(chartFile.path)!,
    );
    measurements.push(...chart.measurements);
    embeddedVitalSets += chart.vitalSets;
    warnings.push(...chart.warnings.map((warning) => `${acquisitionLabel}: ${warning}`));
  }

  if (providerSlug === "rythm-health") {
    const archives = manifest.files.filter((file) => file.kind === "rythm-csv-archive");
    if (archives.length === 0) throw new Error("The Rythm manifest has no rythm-csv-archive file");
    labAcquisitions += 1;
    for (const archive of archives) {
      const absolutePath = join(sourceDir, archive.path);
      const source = sources.get(archive.path)!;
      const members = zipCsvMembers(absolutePath);
      if (members.length === 0) throw new Error(`${acquisitionLabel}: ${archive.path} contains no CSV files`);
      for (const member of members) {
        labResults.push(...parseRythmLabCsv(extractZipMember(absolutePath, member), source, member));
        csvMembers += 1;
      }
    }
  }

  const reviewedPath = join(sourceDir, "reviewed-observations.local.json");
  if (existsSync(reviewedPath)) {
    const reviewed = parseReviewedClinicalFile(JSON.parse(readFileSync(reviewedPath, "utf8")), sources);
    measurements.push(...reviewed.measurements);
    reviewedVitalSets += reviewed.vitalSets;
  } else if (providerSlug !== "rythm-health") {
    warnings.push(`${acquisitionLabel}: no reviewed-observations.local.json found`);
  }
}

measurements.sort(
  (a, b) => a.localStart.localeCompare(b.localStart) || a.type.localeCompare(b.type),
);
assertUniqueClinicalMeasurements(measurements);
labResults.sort((a, b) => a.collectedOn.localeCompare(b.collectedOn) || a.marker.localeCompare(b.marker));
assertUniqueLabResults(labResults);

const output = clinicalBackfillFileZ.parse({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  parser: "clinical-archive-v1",
  measurements,
  report: {
    acquisitions: sourceDirs.length,
    embeddedVitalSets,
    reviewedVitalSets,
    measurements: measurements.length,
    warnings,
  },
});

const labOutput = labArchiveZ.parse({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  parser: "clinical-labs-v1",
  results: labResults,
  report: {
    acquisitions: labAcquisitions,
    csvMembers,
    results: labResults.length,
    warnings: [],
  },
});

if (!checkOnly) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  mkdirSync(dirname(labOutputPath), { recursive: true });
  writeFileSync(labOutputPath, `${JSON.stringify(labOutput, null, 2)}\n`);
}

const counts = Object.groupBy(measurements, (measurement) => measurement.metric);
const labCounts = Object.groupBy(labResults, (result) => result.status);
console.log(
  JSON.stringify(
    {
      mode: checkOnly ? "check" : "write",
      output: checkOnly ? null : outputPath,
      labOutput: checkOnly ? null : labOutputPath,
      acquisitions: sourceDirs.map((sourceDir) => relative(sourcesRoot, sourceDir)),
      embeddedVitalSets,
      reviewedVitalSets,
      measurements: measurements.length,
      byMetric: Object.fromEntries(Object.entries(counts).map(([metric, entries]) => [metric, entries?.length ?? 0])),
      labResults: labResults.length,
      byLabStatus: Object.fromEntries(Object.entries(labCounts).map(([status, entries]) => [status, entries?.length ?? 0])),
      warnings,
    },
    null,
    2,
  ),
);
