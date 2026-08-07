# Clinical records

This directory is the local-only archive for medical records that do not come
through Apple Health. Raw exports and every derived file remain ignored by Git;
only this README and the directory's `.gitignore` are versioned.

## Layout

```text
clinical/
  inbox/                         # newly downloaded files awaiting review
  sources/
    <provider-or-system>/
      <acquired-YYYY-MM-DD>/
        originals/               # untouched source exports
        manifest.local.json      # filenames, provenance, hashes, and notes
        extracted/               # optional local OCR/search sidecars
        structured-record.local.json
        reviewed-observations.local.json
  normalized/                    # validated, derived HealthKit backfill payloads
```

Preserve original exports byte-for-byte. Give organized copies descriptive
names, record their source filenames and SHA-256 hashes in the local manifest,
and put any parsed or normalized output under `normalized/`. Never commit raw
records, manifests, extracted text, or normalized clinical data.

For provider exports, prefer FHIR or C-CDA when available. Otherwise retain the
complete PDF plus all separately downloadable images or attachments.

The provider archive and Apple Health workflow are documented in
`docs/clinical.md`. Run `bun run clinical:import --check` to verify the archive
without writing derived output, or `bun run clinical:import` to refresh
`normalized/apple-health.json`.
