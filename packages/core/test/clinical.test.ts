import { describe, expect, test } from "bun:test";
import { parseLehighChartText, parseReviewedClinicalFile, parseRythmLabCsv, type ClinicalSource } from "../src/index.ts";

const source: ClinicalSource = {
  provider: "Lehigh University Health & Wellness Center",
  providerSlug: "lehigh-health-wellness",
  sourceFile: "sources/lehigh-health-wellness/2026-08-04/originals/complete-chart.pdf",
  sourceSha256: "a".repeat(64),
};

describe("clinical record parsing", () => {
  test("parses Rythm CSV rows without reinterpreting source status or ranges", () => {
    const csv = `marker,value,unit,reference_range,status,time
Fructosamine,326,umol/L,205 - 285,outOfRange,2026-08-07
"Triglycerides/HDL Ratio",1.03,pct,1.25 - 2.5,optimal,2026-08-07
`;
    const parsed = parseRythmLabCsv(csv, { ...source, provider: "Rythm Health", providerSlug: "rythm-health" }, "results.csv");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.markerKey).toBe("fructosamine");
    expect(parsed[0]!.referenceRange).toEqual({ text: "205 - 285", low: 205, high: 285 });
    expect(parsed[0]!.provenance.row).toBe(2);
    expect(parsed[1]!.markerKey).toBe("triglycerides_hdl_ratio");
    expect(parsed[1]!.value).toBeLessThan(parsed[1]!.referenceRange.low!);
    expect(parsed[1]!.status).toBe("optimal");
  });

  test("rejects changed Rythm columns and unsupported source statuses", () => {
    const rythm = { ...source, provider: "Rythm Health", providerSlug: "rythm-health" };
    expect(() => parseRythmLabCsv("marker,value\nApoB,90\n", rythm, "bad.csv")).toThrow(/unsupported header/);
    expect(() =>
      parseRythmLabCsv(
        "marker,value,unit,reference_range,status,time\nApoB,90,mg/dL,0 - 90,kindOfFine,2026-08-07\n",
        rythm,
        "bad.csv",
      ),
    ).toThrow();
  });

  test("parses every dated Lehigh vital set and converts to HealthKit units", () => {
    const text = `
Encounter Date: 01/31/25 02:45 PM

Objective
Vitals
Height with Units: 73 in. Weight with Units: 163 lbs. BMI: 21.5
BP: 98/60 Postural: Sitting
Temperature: 97.6
Respiration: 16
Oximetry: 98
Pulse: 108
Vitals Entered By: test on 01/31/25 Date Taken: 01/31/25 02:43 PM

Provider's Exam Note
Normal exam

Encounter Date: 12/16/24 11:30 AM

Objective
Vitals
BP: 68/43 Postural: Sitting
Temperature: 98.3 Respiration: 16 Oximetry: 98 Pulse: 112
Vitals Entered By: test on 12/16/24 Date Taken: 12/16/24 11:41 AM
BP: 117/73 Postural: Sitting
Temperature: 98.4 Respiration: 16 Oximetry: 100 Pulse: 105
Vitals Entered By: test on 12/16/24 Date Taken: 12/16/24 12:31 PM

Provider's Exam Note
Normal exam
`;

    const parsed = parseLehighChartText(text, source);
    expect(parsed.vitalSets).toBe(3);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.measurements).toHaveLength(21);

    const weight = parsed.measurements.find((measurement) => measurement.metric === "body_mass")!;
    expect(weight.value).toBeCloseTo(73.93555631, 8);
    expect(weight.unit).toBe("kg");
    expect(weight.localStart).toBe("2025-01-31T14:43:00");

    const temperature = parsed.measurements.find(
      (measurement) => measurement.metric === "body_temperature" && measurement.localStart === "2024-12-16T11:41:00",
    )!;
    expect(temperature.value).toBeCloseTo(36.83333333, 8);
    expect(temperature.unit).toBe("degC");

    const oxygen = parsed.measurements.find(
      (measurement) => measurement.metric === "oxygen_saturation" && measurement.localStart === "2024-12-16T12:31:00",
    )!;
    expect(oxygen.value).toBe(1);
    expect(oxygen.unit).toBe("%");

    const pressure = parsed.measurements.filter((measurement) => measurement.localStart === "2025-01-31T14:43:00" && measurement.groupId);
    expect(pressure).toHaveLength(2);
    expect(new Set(pressure.map((measurement) => measurement.groupId)).size).toBe(1);
  });

  test("accepts explicitly reviewed values for scanned handwritten forms", () => {
    const scanSource = { ...source, sourceFile: "sources/lehigh/originals/physical.pdf", sourceSha256: "b".repeat(64) };
    const parsed = parseReviewedClinicalFile(
      {
        schemaVersion: 1,
        records: [
          {
            sourceFile: "originals/physical.pdf",
            localStart: "2024-06-09T12:00:00",
            timeZone: "America/New_York",
            precision: "date",
            note: "Visually reviewed",
            observations: [
              { metric: "height", value: 72, unit: "in" },
              { metric: "body_mass", value: 160, unit: "lb" },
              { metric: "blood_pressure_systolic", value: 112, unit: "mmHg", group: "blood-pressure" },
              { metric: "blood_pressure_diastolic", value: 58, unit: "mmHg", group: "blood-pressure" },
              { metric: "blood_glucose", value: 5, unit: "mmol/L" },
            ],
          },
        ],
      },
      new Map([["originals/physical.pdf", scanSource]]),
    );

    expect(parsed.vitalSets).toBe(1);
    expect(parsed.measurements).toHaveLength(5);
    expect(parsed.measurements.every((measurement) => measurement.provenance.extraction === "manual-review")).toBe(true);
    expect(parsed.measurements.find((measurement) => measurement.metric === "height")?.value).toBe(1.8288);
    expect(parsed.measurements.find((measurement) => measurement.metric === "blood_glucose")?.value).toBeCloseTo(90.07795, 5);
  });

  test("rejects implausible OCR-like values instead of writing them", () => {
    expect(() =>
      parseReviewedClinicalFile(
        {
          schemaVersion: 1,
          records: [
            {
              sourceFile: "originals/physical.pdf",
              localStart: "2024-06-09T12:00:00",
              timeZone: "America/New_York",
              precision: "date",
              note: "Bad OCR",
              observations: [{ metric: "blood_pressure_systolic", value: 1120, unit: "mmHg" }],
            },
          ],
        },
        new Map([["originals/physical.pdf", source]]),
      ),
    ).toThrow("outside the parser safety bounds");
  });
});
