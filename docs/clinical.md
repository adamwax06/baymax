# Clinical-record backfill

Clinical exports are local source material. Baymax preserves the originals,
extracts an allowlisted set of numeric measurements, and sends those
measurements to the iPhone for an explicit one-time HealthKit write. Apple
Health then becomes the durable measurement store; the next normal sync pulls
the new HealthKit samples back into SQLite.

Raw charts, manifests, reviewed values, and normalized output are ignored by
Git. Diagnoses, medications, allergies, immunizations, narrative notes, and
PDFs never leave `data/clinical/` through this workflow.

## Archive pipeline

Each provider keeps its latest acquisition under the same local-only layout:

```text
data/clinical/sources/<provider>/<acquired-date>/
  manifest.local.json
  originals/...
  extracted/...                       # optional OCR/search sidecars
  structured-record.local.json        # optional non-HealthKit extraction
  reviewed-observations.local.json    # visually confirmed quantities
```

`bun run clinical:import` performs four guarded steps:

1. Select the latest acquisition for each provider and verify every archived
   original against its manifest byte count and SHA-256 hash.
2. Run provider-specific parsers where one exists. The Lehigh adapter uses
   `pdftotext -layout` to parse dated `Objective > Vitals` blocks.
3. Merge explicitly reviewed measurements from scanned/handwritten forms.
   Handwriting is never trusted to OCR for numeric health data.
4. Validate units, timestamps, plausible machine-safety bounds, unique stable
   IDs, and the output schema before writing
   `data/clinical/normalized/apple-health.json`.

The Lehigh export produces 45 measurements across seven vital sets. The
Advocare abstract release adds 89 visually reviewed measurements across 15
dated sets: longitudinal pediatric/adolescent vitals plus one fasting blood
glucose result. The combined payload contains 134 measurements. Blood pressure
is written to HealthKit as a systolic/diastolic correlation.

Supported types are height, body mass, BMI, systolic and diastolic blood
pressure, body temperature, respiratory rate, oxygen saturation, and heart
rate, plus blood glucose. Values are converted to the canonical units in the
metric registry before they reach the phone.

General lab panels, allergies, diagnoses, medications, immunizations,
screenings, and narrative notes stay in the local structured extraction.
HealthKit clinical-record objects are read-only to third-party apps, so Baymax
cannot recreate them as allergy, condition, medication, immunization, or lab
FHIR records. Blood glucose is the only lab value in this release with a
matching writable HealthKit quantity type.

## Run the backfill

```bash
bun run clinical:import --check   # verify and show counts; write nothing
bun run clinical:import           # refresh normalized/apple-health.json
bun run dev
```

Rebuild/install the iOS app after adding new write types. In the app:

1. Open **Server & tools**.
2. Tap **Request Health access** and allow the requested measurement types.
3. Tap **Backfill clinical measurements**.
4. Tap **Sync** so the HealthKit-owned samples flow back into Baymax.

Each measurement has a stable HealthKit sync identifier, sync version, source
file, provider, source SHA-256, original unit/value, and extraction method.
Re-running the backfill is idempotent. The HealthKit source is Baymax because
the iPhone app performed the write; the original provider remains in sample
metadata.

## New providers

Do not guess a provider format in advance. Archive the untouched export and
manifest first, then add either a provider-specific parser or a visually
reviewed observation file against the files that actually arrived. Prefer FHIR
or C-CDA over PDF when the provider offers it. The normalized HealthKit payload
and iPhone writer are shared; only extraction needs a new adapter.
