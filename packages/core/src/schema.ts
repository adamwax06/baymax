import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bundleId: text("bundle_id").notNull().unique(),
  name: text("name"),
});

export const devices = sqliteTable("devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Canonical JSON of the five fields below; SQLite UNIQUE treats NULLs as
  // distinct, so uniqueness lives on the serialized key.
  deviceKey: text("device_key").notNull().unique(),
  name: text("name"),
  manufacturer: text("manufacturer"),
  model: text("model"),
  hardwareVersion: text("hardware_version"),
  softwareVersion: text("software_version"),
});

export const samples = sqliteTable(
  "samples",
  {
    hkUuid: text("hk_uuid").primaryKey(),
    type: text("type").notNull(), // full HealthKit identifier
    value: real("value"), // quantity value in the unit below; raw int for category samples
    unit: text("unit"), // unit string as sent by the device; NULL for category samples
    startTs: integer("start_ts").notNull(), // epoch ms UTC
    endTs: integer("end_ts").notNull(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    deviceId: integer("device_id").references(() => devices.id),
    metadata: text("metadata"), // raw HealthKit metadata JSON, NULL if empty
  },
  (t) => [index("idx_samples_type_start").on(t.type, t.startTs)],
);

export const workouts = sqliteTable(
  "workouts",
  {
    hkUuid: text("hk_uuid").primaryKey(),
    activityTypeRaw: integer("activity_type_raw").notNull(), // HKWorkoutActivityType, name decoded on read
    startTs: integer("start_ts").notNull(),
    endTs: integer("end_ts").notNull(),
    durationS: real("duration_s").notNull(),
    distanceM: real("distance_m"),
    activeEnergyKcal: real("active_energy_kcal"),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id),
    deviceId: integer("device_id").references(() => devices.id),
    metadata: text("metadata"),
  },
  (t) => [index("idx_workouts_start").on(t.startTs)],
);
