import { z } from "zod";

/**
 * The wire protocol between the iPhone app and this server — the single
 * source of truth, mirrored by ios/Baymax/Payloads.swift. Timestamps are
 * epoch milliseconds UTC.
 */

const sourceZ = z.object({
  bundleId: z.string().min(1),
  name: z.string().nullish(),
});

const deviceZ = z
  .object({
    name: z.string().nullish(),
    manufacturer: z.string().nullish(),
    model: z.string().nullish(),
    hardwareVersion: z.string().nullish(),
    softwareVersion: z.string().nullish(),
  })
  .nullish();

export const sampleBatchZ = z.object({
  samples: z
    .array(
      z.object({
        uuid: z.string().min(1),
        type: z.string().min(1),
        value: z.number().finite().nullish(),
        unit: z.string().nullish(),
        start: z.number().int(),
        end: z.number().int(),
        source: sourceZ,
        device: deviceZ,
        metadata: z.record(z.unknown()).nullish(),
      }),
    )
    .max(5000),
  deleted: z.array(z.string()).default([]),
});

export const workoutBatchZ = z.object({
  workouts: z
    .array(
      z.object({
        uuid: z.string().min(1),
        activityTypeRaw: z.number().int(),
        start: z.number().int(),
        end: z.number().int(),
        duration: z.number().nonnegative(), // seconds
        distanceMeters: z.number().nullish(),
        activeEnergyKcal: z.number().nullish(),
        source: sourceZ,
        device: deviceZ,
        metadata: z.record(z.unknown()).nullish(),
      }),
    )
    .max(1000),
  deleted: z.array(z.string()).default([]),
});
