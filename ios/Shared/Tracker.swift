import SwiftUI

// Shared by the app and the widget extension.

enum Palette {
    static let red = Color(red: 0.953, green: 0.286, blue: 0.231) // #F3493B
    static let redBright = Color(red: 0.996, green: 0.145, blue: 0.090) // #FE2517
    static let ink = Color(red: 0.067, green: 0.039, blue: 0.035) // #110A09
    static let paper = Color(red: 0.984, green: 0.969, blue: 0.953) // #FBF7F3
}

/// mDNS hostname, not an IP — the Mac's DHCP lease rotates and a hardcoded IP silently breaks sync.
let defaultServerURL = "http://Adams-MacBook-Air.local:4321"

/// The app saves the last /v1/tracker response here; the widget falls back to it
/// when it can't reach the Mac itself (widgets don't get the app's local-network access).
let trackerCache = FileManager.default
    .containerURL(forSecurityApplicationGroupIdentifier: "group.com.adamwax.baymax")?
    .appendingPathComponent("tracker.json")

struct TrackerDay: Decodable {
    let date: String
    let lifted: Bool
    let kcal: Double?
    let level: Int
}

/// GitHub-style, dimmed: deep red = lifted or ate at floor, brighter red = both. Sunday-aligned
/// columns; fills the frame it's given.
struct TrackerGrid: View {
    let days: [TrackerDay]
    private let gap: CGFloat = 3

    var body: some View {
        GeometryReader { geo in
            // Rows set the size, columns stretch to the exact width — edge to edge, like GitHub's.
            let h = (geo.size.height - 6 * gap) / 7
            let cols = max(1, Int((geo.size.width + gap) / (h + gap)))
            let w = (geo.size.width - CGFloat(cols - 1) * gap) / CGFloat(cols)
            let weeks = stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
            HStack(alignment: .top, spacing: gap) {
                ForEach(weeks.suffix(cols), id: \.first!.date) { week in
                    VStack(spacing: gap) {
                        ForEach(week, id: \.date) { day in
                            RoundedRectangle(cornerRadius: h / 5)
                                .fill(day.level == 2 ? AnyShapeStyle(Palette.red.mix(with: .black, by: 0.3)) : day.level == 1 ? AnyShapeStyle(Palette.red.mix(with: .black, by: 0.65)) : AnyShapeStyle(.quaternary))
                                .frame(width: w, height: h)
                                .accessibilityLabel("\(day.date): \(day.lifted ? "lifted" : "no lift"), \(day.kcal.map { "\(Int($0)) kcal" } ?? "no intake logged")")
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
