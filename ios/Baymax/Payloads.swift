import Foundation
import HealthKit

// Codable mirrors of the Zod schemas in apps/server/src/payloads.ts.
// Timestamps are epoch milliseconds UTC.

struct SourcePayload: Encodable {
    let bundleId: String
    let name: String?
}

struct DevicePayload: Encodable {
    let name: String?
    let manufacturer: String?
    let model: String?
    let hardwareVersion: String?
    let softwareVersion: String?

    static func from(_ device: HKDevice?) -> DevicePayload? {
        guard let device else { return nil }
        return DevicePayload(
            name: device.name,
            manufacturer: device.manufacturer,
            model: device.model,
            hardwareVersion: device.hardwareVersion,
            softwareVersion: device.softwareVersion
        )
    }
}

struct SamplePayload: Encodable {
    let uuid: String
    let type: String
    let value: Double?
    let unit: String?
    let start: Int64
    let end: Int64
    let source: SourcePayload
    let device: DevicePayload?
    let metadata: [String: JSONValue]?

    /// Returns nil for sample classes we don't sync (the server's registry
    /// decodes category values and workout activity types; we send raw data).
    static func from(_ sample: HKSample) -> SamplePayload? {
        let value: Double?
        let unit: String?
        switch sample {
        case let quantity as HKQuantitySample:
            guard let hkUnit = SyncedTypes.unit(for: HKQuantityTypeIdentifier(rawValue: quantity.quantityType.identifier)) else { return nil }
            value = quantity.quantity.doubleValue(for: hkUnit)
            unit = hkUnit.unitString
        case let category as HKCategorySample:
            value = Double(category.value)
            unit = nil
        default:
            return nil
        }
        let source = sample.sourceRevision.source
        return SamplePayload(
            uuid: sample.uuid.uuidString,
            type: sample.sampleType.identifier,
            value: value,
            unit: unit,
            start: Int64(sample.startDate.timeIntervalSince1970 * 1000),
            end: Int64(sample.endDate.timeIntervalSince1970 * 1000),
            source: SourcePayload(bundleId: source.bundleIdentifier, name: source.name),
            device: DevicePayload.from(sample.device),
            metadata: JSONValue.dict(sample.metadata)
        )
    }
}

struct WorkoutPayload: Encodable {
    let uuid: String
    let activityTypeRaw: Int
    let start: Int64
    let end: Int64
    let duration: Double // seconds
    let distanceMeters: Double?
    let activeEnergyKcal: Double?
    let source: SourcePayload
    let device: DevicePayload?
    let metadata: [String: JSONValue]?

    init(_ workout: HKWorkout) {
        // iOS 18+ deprecates totalDistance/totalEnergyBurned, but statistics(for:)
        // can be nil for third-party workouts (Strava) — try both, tolerate neither.
        let distance = workout.statistics(for: HKQuantityType(.distanceWalkingRunning))?.sumQuantity()
            ?? workout.statistics(for: HKQuantityType(.distanceCycling))?.sumQuantity()
            ?? workout.totalDistance
        let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()
            ?? workout.totalEnergyBurned
        let source = workout.sourceRevision.source
        uuid = workout.uuid.uuidString
        activityTypeRaw = Int(workout.workoutActivityType.rawValue)
        start = Int64(workout.startDate.timeIntervalSince1970 * 1000)
        end = Int64(workout.endDate.timeIntervalSince1970 * 1000)
        duration = workout.duration
        distanceMeters = distance?.doubleValue(for: .meter())
        activeEnergyKcal = energy?.doubleValue(for: .kilocalorie())
        self.source = SourcePayload(bundleId: source.bundleIdentifier, name: source.name)
        device = DevicePayload.from(workout.device)
        metadata = JSONValue.dict(workout.metadata)
    }
}

struct SampleBatch: Encodable {
    let samples: [SamplePayload]
    let deleted: [String]
}

struct WorkoutBatch: Encodable {
    let workouts: [WorkoutPayload]
    let deleted: [String]
}

/// HealthKit metadata values are String/NSNumber/Bool/Date/HKQuantity; encode
/// them JSON-safely without dropping anything (unknowns become descriptions).
enum JSONValue: Encodable {
    case string(String)
    case number(Double)
    case bool(Bool)

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        }
    }

    static func from(_ any: Any) -> JSONValue {
        switch any {
        case let s as String: return .string(s)
        case let d as Date: return .string(ISO8601DateFormatter().string(from: d))
        case let b as Bool: return .bool(b)
        case let n as NSNumber: return .number(n.doubleValue)
        default: return .string(String(describing: any))
        }
    }

    static func dict(_ metadata: [String: Any]?) -> [String: JSONValue]? {
        guard let metadata, !metadata.isEmpty else { return nil }
        return metadata.mapValues { JSONValue.from($0) }
    }
}
