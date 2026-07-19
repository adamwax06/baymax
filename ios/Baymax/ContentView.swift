import SwiftUI

// Warm-companion layout (greeting + summary tiles) rendered in Liquid Glass,
// palette from the hand-drawn icon: Baymax red, ink, warm paper. Numbers stay
// monospaced; SF Symbols only; red carries progress and alerts.

enum Palette {
    static let red = Color(red: 0.953, green: 0.286, blue: 0.231) // #F3493B
    static let redBright = Color(red: 0.996, green: 0.145, blue: 0.090) // #FE2517
    static let ink = Color(red: 0.067, green: 0.039, blue: 0.035) // #110A09
    static let paper = Color(red: 0.984, green: 0.969, blue: 0.953) // #FBF7F3
}

struct ContentView: View {
    @AppStorage("selectedTab") private var selectedTab = 0 // reopen where you left off

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Home", systemImage: "house.fill", value: 0) { HomeView() }
            Tab("Chat", systemImage: "message.fill", value: 1) { ComingSoonView(title: "Chat") }
            Tab("Log", systemImage: "plus.circle.fill", value: 2) { LogView() }
            Tab("Insights", systemImage: "chart.bar.fill", value: 3) { ComingSoonView(title: "Insights") }
            Tab("You", systemImage: "person.fill", value: 4) { ComingSoonView(title: "You") }
        }
        .tint(Palette.red)
    }
}

struct ComingSoonView: View {
    let title: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 14) {
            Image(decorative: "Helmet")
                .resizable()
                .scaledToFit()
                .frame(width: 72, height: 72)
            Text(title)
                .font(.title2.weight(.bold))
            Text("Coming soon")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(36)
        .glassEffect(.regular, in: .rect(cornerRadius: 32))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background((colorScheme == .dark ? Palette.ink : Palette.paper).ignoresSafeArea())
    }
}

struct HomeView: View {
    @StateObject private var engine = SyncEngine()
    @AppStorage("serverURL") private var serverURL = "http://192.168.1.10:4321"
    @Environment(\.colorScheme) private var colorScheme
    @State private var showTypes = false
    @State private var showOps = false

    private let tileColumns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                greeting
                sectionHeading("Today's Summary")
                summaryTiles
                syncBlock
                dataCard
                opsCard
                footer
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        // Backgrounds never affect layout sizing — the fixed-size decorative
        // blurs can't inflate the proposed width the way ZStack siblings do.
        .background(backdrop)
        .task { await engine.fetchToday(serverURL: serverURL) }
    }

    // MARK: backdrop

    private var backdrop: some View {
        ZStack {
            (colorScheme == .dark ? Palette.ink : Palette.paper)
                .ignoresSafeArea()
            Image(decorative: "Helmet")
                .resizable()
                .scaledToFit()
                .frame(width: 560)
                .blur(radius: 65)
                .opacity(colorScheme == .dark ? 0.4 : 0.45)
                .offset(x: 130, y: -270)
            Circle()
                .fill(Palette.red.opacity(colorScheme == .dark ? 0.22 : 0.15))
                .frame(width: 420)
                .blur(radius: 90)
                .offset(x: -150, y: 330)
                .ignoresSafeArea()
        }
    }

    // MARK: greeting

    private var greeting: some View {
        HStack(spacing: 14) {
            Image(decorative: "Helmet")
                .resizable()
                .scaledToFit()
                .frame(width: 52, height: 52)
            VStack(alignment: .leading, spacing: 2) {
                Text("Hey Adam")
                    .font(.title2.weight(.bold))
                Text("Ready to take on the day?")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(context.date, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(.top, 6)
    }

    // MARK: summary tiles

    private var summaryTiles: some View {
        LazyVGrid(columns: tileColumns, spacing: 14) {
            intakeTile
            proteinTile
            stepsTile
            sleepTile
            weightTile
            trainingTile
        }
    }

    private var intakeTile: some View {
        let logged = engine.today?.logged
        let target = engine.today?.targetKcal
        return tile(
            icon: "fork.knife",
            label: "Intake",
            value: logged.map { $0.kcal.formatted(.number.precision(.fractionLength(0))) } ?? "—",
            unit: "kcal",
            caption: target.map { "/ \($0.formatted(.number.precision(.fractionLength(0)))) target" } ?? "no target",
            progress: zip2(logged?.kcal, target).map { $0 / $1 }
        )
    }

    private var proteinTile: some View {
        let logged = engine.today?.logged
        let target = engine.today?.proteinG
        return tile(
            icon: "takeoutbag.and.cup.and.straw.fill",
            label: "Protein",
            value: logged.map { $0.protein.formatted(.number.precision(.fractionLength(0))) } ?? "—",
            unit: "g",
            caption: target.map { "/ \($0.formatted(.number.precision(.fractionLength(0))))g floor" } ?? "no target",
            progress: zip2(logged?.protein, target).map { $0 / $1 }
        )
    }

    private var stepsTile: some View {
        let todaySteps = engine.overview?.steps.buckets.last?.value
        return tile(
            icon: "figure.walk",
            label: "Steps",
            value: todaySteps.map { $0.formatted(.number.precision(.fractionLength(0)).grouping(.automatic)) } ?? "—",
            unit: "",
            caption: engine.overview?.steps.dailyAvg.map { "avg \($0.formatted(.number.grouping(.automatic))) / 7d" } ?? "",
            progress: todaySteps.map { $0 / 10_000 }
        )
    }

    private var sleepTile: some View {
        let night = engine.overview?.sleep.nights.last
        let minutes = night?.asleepMinutes
        return tile(
            icon: "bed.double.fill",
            label: "Sleep",
            value: minutes.map { "\(Int($0) / 60)h \(Int($0) % 60)m" } ?? "—",
            unit: "",
            caption: night.map { String($0.date.suffix(5)) } ?? "no data",
            progress: minutes.map { $0 / 480 }
        )
    }

    private var weightTile: some View {
        let weight = engine.overview?.weight
        return tile(
            icon: "scalemass.fill",
            label: "Weight",
            value: weight.map { $0.lb.formatted(.number.precision(.fractionLength(1))) } ?? "—",
            unit: "lb",
            caption: weight.map { String($0.date.suffix(5)) } ?? "no weigh-in",
            progress: nil
        )
    }

    private var trainingTile: some View {
        tile(
            icon: "dumbbell.fill",
            label: "Training",
            value: engine.overview.map { "\($0.workouts.count)" } ?? "—",
            unit: "",
            caption: "workouts / 7d",
            progress: nil
        )
    }

    private func tile(icon: String, label: String, value: String, unit: String, caption: String, progress: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(Palette.red)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.title3.weight(.bold).monospaced())
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if !unit.isEmpty {
                    Text(unit)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            if let progress {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary)
                        Capsule()
                            .fill(Palette.red)
                            .frame(width: geo.size.width * min(progress, 1))
                    }
                }
                .frame(height: 4)
                .accessibilityHidden(true)
            }
            if !caption.isEmpty {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    // MARK: sync

    private var syncBlock: some View {
        VStack(spacing: 12) {
            Button {
                Task { await engine.syncNow(serverURL: serverURL) }
            } label: {
                HStack(spacing: 10) {
                    if engine.syncing {
                        Circle()
                            .fill(.white)
                            .frame(width: 8, height: 8)
                            .modifier(PulseEffect())
                        Text("Syncing…")
                    } else {
                        Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .font(.body.weight(.bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.red)
            .disabled(engine.syncing)

            if !engine.statusLine.isEmpty || engine.lastError != nil || engine.lastSync != nil {
                VStack(alignment: .leading, spacing: 6) {
                    if !engine.statusLine.isEmpty {
                        Text(engine.statusLine)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    if let error = engine.lastError {
                        Text(error)
                            .font(.caption.monospaced())
                            .foregroundStyle(Palette.redBright)
                            .lineLimit(3)
                    }
                    HStack {
                        Text(engine.lastSync.map { "Last sync \($0.formatted(date: .omitted, time: .shortened))" } ?? "Not synced yet")
                        Spacer()
                        Text("\(engine.totalCount) records")
                    }
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))
            }
        }
    }

    // MARK: data & ops

    private var dataCard: some View {
        disclosureCard(title: "Synced data · \(engine.types.count) types", isOpen: $showTypes) {
            ForEach(engine.types, id: \.identifier) { type in
                HStack {
                    Text(SyncedTypes.shortName(type))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(engine.counts[type.identifier] ?? 0)")
                        .font(.footnote.monospaced())
                }
            }
        }
    }

    private var opsCard: some View {
        disclosureCard(title: "Server & tools", isOpen: $showOps) {
            TextField("http://<mac-ip>:4321", text: $serverURL)
                .font(.footnote.monospaced())
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(10)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
            opButton("Test connection") { await engine.testConnection(serverURL: serverURL) }
            opButton("Request Health access") { await engine.requestAccess() }
            opButton("Write nutrition → Health") { await engine.syncNutrition(serverURL: serverURL) }
            opButton("Backfill body weight") { await engine.backfillBodyWeight(serverURL: serverURL) }
            Button {
                engine.resetAnchors()
            } label: {
                Text("Reset sync anchors")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.redBright)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
    }

    private func disclosureCard(title: String, isOpen: Binding<Bool>, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy) { isOpen.wrappedValue.toggle() }
            } label: {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: isOpen.wrappedValue ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen.wrappedValue {
                content()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    private func opButton(_ label: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack {
                Text(label)
                    .font(.footnote.weight(.medium))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 4)
    }

    // MARK: chrome

    private func sectionHeading(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .padding(.leading, 4)
            .padding(.top, 4)
    }

    private var footer: some View {
        Text("Personal healthcare companion")
            .font(.caption2)
            .kerning(1.5)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
    }
}

private func zip2(_ a: Double?, _ b: Double?) -> (Double, Double)? {
    guard let a, let b else { return nil }
    return (a, b)
}

/// The one looping animation: a record-dot pulsing while syncing. Respects
/// Reduce Motion (opacity only, no movement).
private struct PulseEffect: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(dim ? 0.25 : 1)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: dim)
            .onAppear { dim = true }
    }
}

#Preview {
    ContentView()
}
