import { z } from "zod";

/**
 * The wire protocol between the iPhone app and the ingest server — the single
 * TypeScript source of truth (payload types are inferred from these schemas).
 * Mirrored in Swift by ios/Baymax/Payloads.swift. Timestamps are epoch
 * milliseconds UTC.
 */

const sourceZ = z.object({
  bundleId: z.string().min(1),
  name: z.string().nullish(),
});

const deviceZ = z.object({
  name: z.string().nullish(),
  manufacturer: z.string().nullish(),
  model: z.string().nullish(),
  hardwareVersion: z.string().nullish(),
  softwareVersion: z.string().nullish(),
});

const sampleZ = z.object({
  uuid: z.string().min(1),
  type: z.string().min(1),
  value: z.number().finite().nullish(),
  unit: z.string().nullish(),
  start: z.number().int(),
  end: z.number().int(),
  source: sourceZ,
  device: deviceZ.nullish(),
  metadata: z.record(z.unknown()).nullish(),
});

const workoutZ = z.object({
  uuid: z.string().min(1),
  activityTypeRaw: z.number().int(),
  start: z.number().int(),
  end: z.number().int(),
  duration: z.number().nonnegative(), // seconds
  distanceMeters: z.number().nullish(),
  activeEnergyKcal: z.number().nullish(),
  source: sourceZ,
  device: deviceZ.nullish(),
  metadata: z.record(z.unknown()).nullish(),
});

export const sampleBatchZ = z.object({
  samples: z.array(sampleZ).max(5000),
  deleted: z.array(z.string()).default([]),
});

export const workoutBatchZ = z.object({
  workouts: z.array(workoutZ).max(1000),
  deleted: z.array(z.string()).default([]),
});

export type SourcePayload = z.infer<typeof sourceZ>;
export type DevicePayload = z.infer<typeof deviceZ>;
export type SamplePayload = z.infer<typeof sampleZ>;
export type WorkoutPayload = z.infer<typeof workoutZ>;
