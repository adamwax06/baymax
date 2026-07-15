import Foundation
import HealthKit

@MainActor
final class SyncEngine: ObservableObject {
    static let pageLimit = 2000

    private let store = HKHealthStore()
    private let defaults = UserDefaults.standard

    @Published var syncing = false
    @Published var statusLine = ""
    @Published var lastError: String?
    @Published var lastSync: Date?
    @Published var counts: [String: Int] = [:] // type identifier -> records sent (cumulative)

    /// Types sorted for a stable UI and deterministic sync order.
    let types = SyncedTypes.readTypes.sorted { $0.identifier < $1.identifier }

    init() {
        lastSync = defaults.object(forKey: "lastSync") as? Date
        for type in types {
            counts[type.identifier] = defaults.integer(forKey: "count.\(type.identifier)")
        }
    }

    var totalCount: Int { counts.values.reduce(0, +) }

    func requestAccess() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            lastError = "Health data is not available on this device"
            return
        }
        do {
            try await store.requestAuthorization(toShare: [], read: SyncedTypes.readTypes)
            statusLine = "Health access requested"
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func testConnection(serverURL: String) async {
        do {
            try await api(serverURL).ping()
            statusLine = "Server reachable ✓"
            lastError = nil
        } catch {
            lastError = "Ping failed: \(error.localizedDescription)"
        }
    }

    func syncNow(serverURL: String) async {
        guard !syncing else { return }
        syncing = true
        lastError = nil
        defer {
            syncing = false
            statusLine = lastError == nil ? "Sync complete" : statusLine
        }
        do {
            let api = try api(serverURL)
            for type in types {
                try await sync(type: type, api: api)
            }
            lastSync = Date()
            defaults.set(lastSync, forKey: "lastSync")
        } catch {
            lastError = error.localizedDescription
        }
    }

    func resetAnchors() {
        AnchorStore.resetAll()
        for type in types {
            counts[type.identifier] = 0
            defaults.removeObject(forKey: "count.\(type.identifier)")
        }
        statusLine = "Anchors reset — next sync re-sends full history"
    }

    private func api(_ serverURL: String) throws -> ApiClient {
        guard let url = URL(string: serverURL), url.scheme != nil else {
            throw ApiClient.ApiError(message: "Invalid server URL")
        }
        return ApiClient(baseURL: url)
    }

    /// Anchored paging loop: each page is POSTed and the anchor is persisted
    /// only after the server acks with a 2xx (ack-then-advance). Replays after
    /// a failure are harmless — the server upserts on HealthKit UUID.
    private func sync(type: HKSampleType, api: ApiClient) async throws {
        var anchor = AnchorStore.load(for: type)
        while true {
            statusLine = "Syncing \(SyncedTypes.shortName(type)) (\(counts[type.identifier] ?? 0) sent)…"
            let descriptor = HKAnchoredObjectQueryDescriptor(
                predicates: [HKSamplePredicate.sample(type: type)],
                anchor: anchor,
                limit: Self.pageLimit
            )
            let result = try await descriptor.result(for: store)
            let deleted = result.deletedObjects.map { $0.uuid.uuidString }

            if !result.addedSamples.isEmpty || !deleted.isEmpty {
                if type == HKWorkoutType.workoutType() {
                    let workouts = result.addedSamples.compactMap { $0 as? HKWorkout }.map(WorkoutPayload.init)
                    try await api.post("v1/ingest/workouts", body: WorkoutBatch(workouts: workouts, deleted: deleted))
                } else {
                    let samples = result.addedSamples.compactMap(SamplePayload.from)
                    try await api.post("v1/ingest/samples", body: SampleBatch(samples: samples, deleted: deleted))
                }
            }

            AnchorStore.save(result.newAnchor, for: type)
            anchor = result.newAnchor
            if !result.addedSamples.isEmpty {
                let newCount = (counts[type.identifier] ?? 0) + result.addedSamples.count
                counts[type.identifier] = newCount
                defaults.set(newCount, forKey: "count.\(type.identifier)")
            }
            if result.addedSamples.count + deleted.count < Self.pageLimit { break }
        }
    }
}
