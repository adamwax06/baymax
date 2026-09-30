import SwiftUI
import WidgetKit

// Lift + Eat grid on the iPhone home screen — and the Mac desktop via macOS's
// iPhone-widgets support. Fetches /v1/tracker from the Mac, else the app's cached copy.

struct TrackerEntry: TimelineEntry {
    let date: Date
    let days: [TrackerDay]
}

struct TrackerProvider: TimelineProvider {
    func placeholder(in context: Context) -> TrackerEntry { TrackerEntry(date: .now, days: []) }

    func getSnapshot(in context: Context, completion: @escaping (TrackerEntry) -> Void) {
        Task { completion(TrackerEntry(date: .now, days: await fetch())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TrackerEntry>) -> Void) {
        Task {
            let entry = TrackerEntry(date: .now, days: await fetch())
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(30 * 60))))
        }
    }

    // ponytail: default server URL only (the app's setting isn't shared); fine while it never changes.
    private func fetch() async -> [TrackerDay] {
        var request = URLRequest(url: URL(string: defaultServerURL)!.appendingPathComponent("v1/tracker"))
        request.timeoutInterval = 5 // a hung request gets the widget killed and it never draws
        let live = try? await URLSession.shared.data(for: request).0
        guard let data = live ?? trackerCache.flatMap({ try? Data(contentsOf: $0) }) else { return [] }
        return (try? JSONDecoder().decode([TrackerDay].self, from: data)) ?? []
    }
}

struct TrackerWidgetView: View {
    let entry: TrackerEntry

    var body: some View {
        Group {
            if entry.days.isEmpty {
                Text("Open Baymax to load").font(.caption).foregroundStyle(.secondary)
            } else {
                TrackerGrid(days: entry.days)
            }
        }
        .padding(12)
        .containerBackground(.background, for: .widget)
    }
}

@main
struct BaymaxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BaymaxTracker", provider: TrackerProvider()) { TrackerWidgetView(entry: $0) }
            .configurationDisplayName("Lift + Eat")
            .description("Light red: lifted or ate at target. Full red: both.")
            .supportedFamilies([.systemMedium])
            .contentMarginsDisabled()
    }
}
