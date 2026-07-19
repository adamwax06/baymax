import HealthKit

/// The Swift half of the metric registry. Each entry mirrors one in
/// packages/core/src/registry.ts and the HKUnit's unitString must match the
/// registry's `unit` (the server logs a warning on mismatch). To sync a new
/// HealthKit type: add a line here + a registry entry, then rebuild the app.
enum SyncedTypes {
    static let quantities: [(id: HKQuantityTypeIdentifier, unit: HKUnit)] = [
        (.heartRate, HKUnit.count().unitDivided(by: .minute())),
        (.restingHeartRate, HKUnit.count().unitDivided(by: .minute())),
        (.walkingHeartRateAverage, HKUnit.count().unitDivided(by: .minute())),
        (.heartRateVariabilitySDNN, .secondUnit(with: .milli)),
        (.heartRateRecoveryOneMinute, HKUnit.count().unitDivided(by: .minute())),
        (.stepCount, .count()),
        (.distanceWalkingRunning, .meter()),
        (.distanceCycling, .meter()),
        (.activeEnergyBurned, .kilocalorie()),
        (.basalEnergyBurned, .kilocalorie()),
        (.appleExerciseTime, .minute()),
        (.appleStandTime, .minute()),
        (.vo2Max, HKUnit(from: "ml/kg*min")),
        (.respiratoryRate, HKUnit.count().unitDivided(by: .minute())),
        (.oxygenSaturation, .percent()),
        (.bodyMass, .gramUnit(with: .kilo)),
        (.bodyFatPercentage, .percent()),
        (.bodyMassIndex, .count()),
        (.runningSpeed, HKUnit.meter().unitDivided(by: .second())),
        (.runningPower, .watt()),
    ]

    static let categories: [HKCategoryTypeIdentifier] = [
        .sleepAnalysis,
        .highHeartRateEvent,
        .lowHeartRateEvent,
        .irregularHeartRhythmEvent,
    ]

    /// Everything we request read access for and sync, workouts included.
    static var readTypes: Set<HKSampleType> {
        var types = Set<HKSampleType>()
        for q in quantities { types.insert(HKQuantityType(q.id)) }
        for c in categories { types.insert(HKCategoryType(c)) }
        types.insert(HKWorkoutType.workoutType())
        return types
    }

    /// Write access: body mass (weigh-in backfill) plus the dietary types the
    /// nutrition mirror writes (plan-derived intake from the server).
    static var shareTypes: Set<HKSampleType> {
        [
            HKQuantityType(.bodyMass),
            HKQuantityType(.dietaryEnergyConsumed),
            HKQuantityType(.dietaryProtein),
            HKQuantityType(.dietaryCarbohydrates),
            HKQuantityType(.dietaryFatTotal),
            HKQuantityType(.dietaryFiber),
            HKQuantityType(.dietaryCalcium),
            HKQuantityType(.dietaryIron),
            HKQuantityType(.dietaryMagnesium),
            HKQuantityType(.dietaryPotassium),
            HKQuantityType(.dietarySodium),
            HKQuantityType(.dietaryZinc),
            HKQuantityType(.dietaryVitaminD),
            HKQuantityType(.dietaryVitaminC),
        ]
    }

    static func unit(for id: HKQuantityTypeIdentifier) -> HKUnit? {
        quantities.first { $0.id == id }?.unit
    }

    static func shortName(_ type: HKSampleType) -> String {
        type.identifier
            .replacingOccurrences(of: "HKQuantityTypeIdentifier", with: "")
            .replacingOccurrences(of: "HKCategoryTypeIdentifier", with: "")
            .replacingOccurrences(of: "HKWorkoutTypeIdentifier", with: "Workouts")
    }
}
