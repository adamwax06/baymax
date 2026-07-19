import SwiftUI

// In-gym workout logging. Opens on the suggested day type with the last
// session of that type pre-filled (ghosting) — bump the numbers between sets
// and save. weights.json on the Mac stays the source of truth; the server
// appends and re-imports.

struct LogView: View {
    @AppStorage("serverURL") private var serverURL = "http://192.168.1.10:4321"
    @Environment(\.colorScheme) private var colorScheme

    @State private var template: Template?
    @State private var dayType = "push"
    @State private var drafts: [DraftExercise] = []
    @State private var status: String?
    @State private var errorText: String?
    @State private var saving = false
    @State private var pendingCount = UserDefaults.standard.stringArray(forKey: "pendingWorkouts")?.count ?? 0

    private let coreTypes = ["push", "pull", "legs"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                typePicker
                ForEach($drafts) { $exercise in
                    exerciseCard($exercise)
                }
                addExercise
                saveBlock
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background((colorScheme == .dark ? Palette.ink : Palette.paper).ignoresSafeArea())
        .task {
            await flushQueue()
            await loadTemplate()
        }
    }

    // MARK: pieces

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Log workout")
                    .font(.title2.weight(.bold))
                Text(Date.now, format: .dateTime.weekday(.wide).month().day())
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(.top, 6)
    }

    private var typePicker: some View {
        Picker("Day", selection: $dayType) {
            ForEach(coreTypes, id: \.self) { Text($0.capitalized).tag($0) }
        }
        .pickerStyle(.segmented)
        .onChange(of: dayType) { prefill() }
    }

    private func exerciseCard(_ exercise: Binding<DraftExercise>) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(exercise.wrappedValue.name)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    drafts.removeAll { $0.id == exercise.wrappedValue.id }
                } label: {
                    Label("Remove exercise", systemImage: "xmark")
                        .labelStyle(.iconOnly)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
            ForEach(exercise.sets) { $set in
                HStack(spacing: 8) {
                    TextField("lb", text: $set.lb)
                        .keyboardType(.decimalPad)
                        .frame(width: 64)
                        .multilineTextAlignment(.trailing)
                        .padding(8)
                        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                    Text(set.perSide ? "lb/side ×" : "lb ×")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    TextField("8, 8", text: $set.reps)
                        .keyboardType(.numbersAndPunctuation)
                        .padding(8)
                        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
                    Button {
                        exercise.wrappedValue.sets.removeAll { $0.id == set.id }
                    } label: {
                        Label("Remove set", systemImage: "minus.circle")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
                .font(.body.monospaced())
            }
            Button {
                let last = exercise.wrappedValue.sets.last
                exercise.wrappedValue.sets.append(
                    DraftSet(lb: last?.lb ?? "", reps: "", perSide: last?.perSide ?? false, bodyweight: last?.bodyweight ?? false))
            } label: {
                Label("Add set", systemImage: "plus")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.red)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    private var addExercise: some View {
        Menu {
            ForEach(template?.exerciseNames ?? [], id: \.self) { name in
                Button(name) {
                    drafts.append(DraftExercise(name: name, sets: [DraftSet(lb: "", reps: "", perSide: false, bodyweight: false)]))
                }
            }
        } label: {
            Label("Add exercise", systemImage: "plus.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.red)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
        }
    }

    private var saveBlock: some View {
        VStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                Text(saving ? "Saving…" : "Save workout")
                    .font(.body.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.red)
            .disabled(saving || drafts.isEmpty)

            if let status {
                Text(status)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let errorText {
                Text(errorText)
                    .font(.caption.monospaced())
                    .foregroundStyle(Palette.redBright)
            }
            if pendingCount > 0 {
                Button {
                    Task { await flushQueue() }
                } label: {
                    Label("\(pendingCount) workout\(pendingCount == 1 ? "" : "s") queued — tap to retry", systemImage: "arrow.clockwise")
                        .font(.caption.weight(.semibold).monospaced())
                        .foregroundStyle(Palette.red)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: offline queue

    // Saves that can't reach the Mac (gym has no home wifi) are queued as raw
    // JSON in UserDefaults and flushed when the Log tab opens on home wifi.
    private func queueWorkout(_ json: String) {
        var q = UserDefaults.standard.stringArray(forKey: "pendingWorkouts") ?? []
        q.append(json)
        UserDefaults.standard.set(q, forKey: "pendingWorkouts")
        pendingCount = q.count
    }

    private func flushQueue() async {
        var q = UserDefaults.standard.stringArray(forKey: "pendingWorkouts") ?? []
        pendingCount = q.count
        guard !q.isEmpty, let base = URL(string: serverURL) else { return }
        var sent = 0
        while let json = q.first {
            var request = URLRequest(url: base.appendingPathComponent("v1/log/workout"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(json.utf8)
            guard let (_, resp) = try? await URLSession.shared.data(for: request),
                  let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { break }
            q.removeFirst()
            sent += 1
        }
        UserDefaults.standard.set(q, forKey: "pendingWorkouts")
        pendingCount = q.count
        if sent > 0 {
            status = "Synced \(sent) queued workout\(sent == 1 ? "" : "s") ✓"
        }
    }

    // MARK: data

    struct Template: Decodable {
        struct Session: Decodable {
            struct Exercise: Decodable {
                struct SetGroup: Decodable {
                    let lb: Double?
                    let perSide: Bool?
                    let bodyweight: Bool?
                    let reps: [Double]
                }
                let name: String
                let sets: [SetGroup]
            }
            let date: String
            let exercises: [Exercise]
        }
        let suggestedType: String
        let lastByType: [String: Session]
        let exerciseNames: [String]
    }

    struct DraftSet: Identifiable {
        let id = UUID()
        var lb: String
        var reps: String
        var perSide: Bool
        var bodyweight: Bool
    }

    struct DraftExercise: Identifiable {
        let id = UUID()
        var name: String
        var sets: [DraftSet]
    }

    private func loadTemplate() async {
        guard template == nil, let url = URL(string: serverURL)?.appendingPathComponent("v1/log/template") else { return }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let t = try? JSONDecoder().decode(Template.self, from: data) {
            template = t
            UserDefaults.standard.set(data, forKey: "cachedTemplate") // survives cold launch at the gym
        } else if let cached = UserDefaults.standard.data(forKey: "cachedTemplate"),
                  let t = try? JSONDecoder().decode(Template.self, from: cached) {
            template = t
            status = "Offline — prefilled from the last cached session"
        } else {
            errorText = "Couldn't reach the server for last-session prefill"
            return
        }
        if let t = template, coreTypes.contains(t.suggestedType) { dayType = t.suggestedType }
        prefill()
    }

    private func prefill() {
        status = nil
        errorText = nil
        guard let last = template?.lastByType[dayType] else {
            drafts = []
            return
        }
        let fmt = { (v: Double) -> String in
            v == v.rounded() ? String(Int(v)) : String(v)
        }
        drafts = last.exercises.map { ex in
            DraftExercise(
                name: ex.name,
                sets: ex.sets.map { g in
                    DraftSet(
                        lb: g.lb.map(fmt) ?? "",
                        reps: g.reps.map(fmt).joined(separator: ", "),
                        perSide: g.perSide ?? false,
                        bodyweight: g.bodyweight ?? false)
                })
        }
        status = "Prefilled from \(last.date) — bump the numbers and save"
    }

    private func save() async {
        struct SetOut: Encodable {
            let lb: Double?
            let perSide: Bool?
            let bodyweight: Bool?
            let reps: [Double]
        }
        struct ExerciseOut: Encodable {
            let name: String
            let sets: [SetOut]
        }
        struct SessionOut: Encodable {
            let date: String
            let type: String
            let exercises: [ExerciseOut]
        }
        errorText = nil
        var exercises: [ExerciseOut] = []
        for d in drafts {
            var sets: [SetOut] = []
            for s in d.sets {
                let reps = s.reps.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                if reps.isEmpty { continue } // untouched ghost rows are skippable
                let lb = Double(s.lb.trimmingCharacters(in: .whitespaces))
                if lb == nil && !s.bodyweight {
                    errorText = "\(d.name): set needs a weight (or mark bodyweight in the data)"
                    return
                }
                sets.append(SetOut(lb: lb, perSide: s.perSide ? true : nil, bodyweight: s.bodyweight ? true : nil, reps: reps))
            }
            if !sets.isEmpty {
                exercises.append(ExerciseOut(name: d.name, sets: sets))
            }
        }
        guard !exercises.isEmpty else {
            errorText = "Nothing to save — enter at least one set"
            return
        }
        guard let url = URL(string: serverURL) else {
            errorText = "Invalid server URL"
            return
        }
        saving = true
        defer { saving = false }
        let date = Date.now.formatted(.iso8601.year().month().day().dateSeparator(.dash))
        let session = SessionOut(date: date, type: dayType, exercises: exercises)
        do {
            try await ApiClient(baseURL: url).post("v1/log/workout", body: session)
            status = "Logged \(dayType) · \(exercises.count) exercises ✓"
        } catch {
            // Can't reach the Mac (probably at the gym): queue it on-device
            // and flush when the app opens on home wifi.
            if let data = try? JSONEncoder().encode(session), let json = String(data: data, encoding: .utf8) {
                queueWorkout(json)
                status = "No server — workout saved on phone, syncs when you're home"
                errorText = nil
            } else {
                errorText = error.localizedDescription
            }
        }
    }
}

#Preview {
    LogView()
}
