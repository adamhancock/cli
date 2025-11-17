import SwiftUI

struct ContentView: View {
    @StateObject private var viewModel = DashboardViewModel()
    @State private var showSettings = false
    @State private var selectedInstance: InstanceWithMetadata?

    // Grid layout
    private let columns = [
        GridItem(.adaptive(minimum: 350, maximum: 500), spacing: 16)
    ]

    var body: some View {
        NavigationView {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    // Stats Cards
                    statsSection

                    // Instance Cards
                    ForEach(viewModel.instances) { instance in
                        InstanceCardView(instance: instance)
                            .onTapGesture {
                                selectedInstance = instance
                            }
                    }
                }
                .padding()
            }
            .navigationTitle("Workstream Dashboard")
            .toolbar {
                ToolbarItemGroup(placement: .navigationBarLeading) {
                    connectionStatusView
                }

                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    Button(action: { viewModel.refresh() }) {
                        Image(systemName: "arrow.clockwise")
                    }

                    Button(action: { showSettings = true }) {
                        Image(systemName: "gear")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(viewModel: viewModel)
            }
            .sheet(item: $selectedInstance) { instance in
                InstanceDetailView(instance: instance)
            }
            .onAppear {
                viewModel.connect()
            }
        }
        .navigationViewStyle(.stack)
    }

    private var statsSection: some View {
        VStack(spacing: 12) {
            Text("Overview")
                .font(.title2)
                .fontWeight(.bold)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 16) {
                StatCard(
                    title: "Total",
                    value: "\(viewModel.totalInstances)",
                    icon: "square.stack.3d.up.fill",
                    color: .blue
                )

                StatCard(
                    title: "Active",
                    value: "\(viewModel.activeInstances)",
                    icon: "circle.fill",
                    color: .green
                )

                StatCard(
                    title: "With PRs",
                    value: "\(viewModel.instancesWithPRs)",
                    icon: "arrow.merge",
                    color: .purple
                )

                StatCard(
                    title: "Claude",
                    value: "\(viewModel.instancesWithClaude)",
                    icon: "brain",
                    color: .orange
                )
            }
        }
        .padding(.bottom, 8)
    }

    private var connectionStatusView: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(viewModel.isConnected ? Color.green : Color.red)
                .frame(width: 10, height: 10)

            Text(viewModel.isConnected ? "Connected" : "Disconnected")
                .font(.caption)
                .foregroundColor(.secondary)

            if let lastUpdate = viewModel.lastUpdate {
                Text("• \(timeAgo(lastUpdate))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
    }

    private func timeAgo(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 {
            return "\(seconds)s ago"
        } else if seconds < 3600 {
            return "\(seconds / 60)m ago"
        } else {
            return "\(seconds / 3600)h ago"
        }
    }
}

struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundColor(color)

            Text(value)
                .font(.title)
                .fontWeight(.bold)

            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.1), radius: 5, x: 0, y: 2)
    }
}

struct SettingsView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("API Configuration")) {
                    TextField("WebSocket URL", text: $viewModel.apiBaseURL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    Text("Example: ws://localhost:3000")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Section(header: Text("Connection")) {
                    HStack {
                        Text("Status")
                        Spacer()
                        Text(viewModel.isConnected ? "Connected" : "Disconnected")
                            .foregroundColor(viewModel.isConnected ? .green : .red)
                    }

                    if let error = viewModel.error {
                        Text("Error: \(error)")
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    Button(viewModel.isConnected ? "Disconnect" : "Connect") {
                        if viewModel.isConnected {
                            viewModel.disconnect()
                        } else {
                            viewModel.connect()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

struct InstanceDetailView: View {
    let instance: InstanceWithMetadata
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Basic Info
                    Section {
                        DetailRow(label: "Name", value: instance.name)
                        DetailRow(label: "Path", value: instance.path)
                        if let branch = instance.branch {
                            DetailRow(label: "Branch", value: branch)
                        }
                    }

                    // Git Info
                    if let gitInfo = instance.gitInfo {
                        Section {
                            Text("Git Information")
                                .font(.headline)
                                .padding(.top)

                            if let lastCommit = gitInfo.lastCommit {
                                DetailRow(label: "Last Commit", value: lastCommit.message)
                                DetailRow(label: "Author", value: lastCommit.author)
                            }

                            if let ahead = gitInfo.ahead {
                                DetailRow(label: "Ahead", value: "\(ahead)")
                            }

                            if let behind = gitInfo.behind {
                                DetailRow(label: "Behind", value: "\(behind)")
                            }
                        }
                    }

                    // PR Info
                    if let prStatus = instance.prStatus {
                        Section {
                            Text("Pull Request")
                                .font(.headline)
                                .padding(.top)

                            DetailRow(label: "Number", value: "#\(prStatus.number)")
                            DetailRow(label: "Title", value: prStatus.title)
                            DetailRow(label: "State", value: prStatus.state)

                            if let checks = prStatus.checks {
                                DetailRow(label: "Checks Passing", value: "\(checks.passing)/\(checks.total)")
                                if checks.failing > 0 {
                                    DetailRow(label: "Checks Failing", value: "\(checks.failing)")
                                }
                            }
                        }
                    }

                    // Extension State
                    if let extState = instance.extensionState {
                        Section {
                            Text("Editor State")
                                .font(.headline)
                                .padding(.top)

                            if let fileActivity = extState.fileActivity {
                                DetailRow(label: "Dirty Files", value: "\(fileActivity.dirtyFileCount)")
                                DetailRow(label: "Saves (5min)", value: "\(fileActivity.savesPerFiveMinutes)")
                            }

                            if let terminals = extState.terminals {
                                DetailRow(label: "Terminals", value: "\(terminals.total) (\(terminals.active) active)")
                            }

                            if let debug = extState.debugSessions, debug.active {
                                DetailRow(label: "Debug Sessions", value: "\(debug.count)")
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Instance Details")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline)
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    ContentView()
}
