import Foundation
import HealthKit

/// Persists HKQueryAnchors in UserDefaults, keyed by type identifier.
/// Anchors advance only after the server acks a batch (see SyncEngine), so a
/// failed or interrupted sync just resumes from the last acked page.
enum AnchorStore {
    private static func key(_ type: HKSampleType) -> String { "anchor.\(type.identifier)" }

    static func load(for type: HKSampleType) -> HKQueryAnchor? {
        let defaults = UserDefaults.standard
        // String branch: legacy base64 format from pre-cleanup builds; deletable
        // once every device has synced (save writes Data).
        let data = defaults.data(forKey: key(type))
            ?? defaults.string(forKey: key(type)).flatMap { Data(base64Encoded: $0) }
        guard let data else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    static func save(_ anchor: HKQueryAnchor, for type: HKSampleType) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: key(type))
    }

    /// Forget all anchors: the next sync re-sends full history (harmless — the
    /// server upserts on HealthKit UUID).
    static func resetAll() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("anchor.") {
            defaults.removeObject(forKey: key)
        }
    }
}
