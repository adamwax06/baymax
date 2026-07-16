import SwiftUI

struct ContentView: View {
    @StateObject private var engine = SyncEngine()
    @AppStorage("serverURL") private var serverURL = "http://192.168.1.10:4321"

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("http://<mac-ip>:4321", text: $serverURL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                    Button("Test Connection") {
                        Task { await engine.testConnection(serverURL: serverURL) }
                    }
                }

                Section {
                    Button("Request Health Access") {
                        Task { await engine.requestAccess() }
                    }
                } footer: {
                    Text("iOS hides read permissions from apps. If a type stays at 0 records after a sync, enable it under Settings → Privacy → Health → Baymax.")
                }

                Section {
                    Button {
                        Task { await engine.syncNow(serverURL: serverURL) }
                    } label: {
                        HStack {
                            Text(engine.syncing ? "Syncing…" : "Sync Now")
                            if engine.syncing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(engine.syncing)
                    if !engine.statusLine.isEmpty {
                        Text(engine.statusLine).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error = engine.lastError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                } footer: {
                    if let lastSync = engine.lastSync {
                        Text("Last sync \(lastSync.formatted(date: .abbreviated, time: .shortened)) · \(engine.totalCount) records sent")
                    }
                }

                Section("Synced types") {
                    ForEach(engine.types, id: \.identifier) { type in
                        HStack {
                            Text(SyncedTypes.shortName(type))
                            Spacer()
                            Text("\(engine.counts[type.identifier] ?? 0)")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                }

                Section {
                    Button("Backfill Body Weight into Health") {
                        Task { await engine.backfillBodyWeight(serverURL: serverURL) }
                    }
                    Button("Reset Sync Anchors", role: .destructive) { engine.resetAnchors() }
                } footer: {
                    Text("Backfill writes logged weigh-ins from the server into Apple Health (one-time, safe to re-tap). Reset re-sends full history on next sync. Both safe: the server deduplicates by HealthKit UUID.")
                }
            }
            .navigationTitle("Baymax")
        }
    }
}

#Preview {
    ContentView()
}
