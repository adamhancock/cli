import SwiftUI

struct InstanceCardView: View {
    let instance: InstanceWithMetadata

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header with instance name and branch
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(instance.name)
                        .font(.headline)
                        .foregroundColor(.primary)

                    if let branch = instance.branch {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.caption)
                            Text(branch)
                                .font(.caption)
                        }
                        .foregroundColor(.secondary)
                    }
                }

                Spacer()

                // Window focus indicator
                if instance.extensionState?.window?.isFocused == true {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 12, height: 12)
                }
            }

            // Git status
            if let gitInfo = instance.gitInfo {
                HStack(spacing: 16) {
                    if let ahead = gitInfo.ahead, ahead > 0 {
                        Label("\(ahead)", systemImage: "arrow.up.circle.fill")
                            .font(.caption)
                            .foregroundColor(.blue)
                    }

                    if let behind = gitInfo.behind, behind > 0 {
                        Label("\(behind)", systemImage: "arrow.down.circle.fill")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }

                    if gitInfo.isDirty == true {
                        Label("Dirty", systemImage: "circle.fill")
                            .font(.caption)
                            .foregroundColor(.yellow)
                    }
                }
            }

            // PR Status
            if let prStatus = instance.prStatus {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: "arrow.merge")
                        Text("PR #\(prStatus.number)")
                            .font(.caption)
                        Spacer()
                        prStatusBadge(prStatus.state)
                    }

                    if let checks = prStatus.checks {
                        HStack(spacing: 12) {
                            checksView(checks)
                        }
                        .font(.caption2)
                    }
                }
                .padding(8)
                .background(Color.secondary.opacity(0.1))
                .cornerRadius(8)
            }

            // Claude Status
            if let claudeStatus = instance.claudeStatus, claudeStatus.hasActiveSessions {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: "brain")
                        Text("Claude Active")
                            .font(.caption)
                        Spacer()
                        Text("\(claudeStatus.sessions.count) session(s)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }

                    ForEach(claudeStatus.sessions.prefix(3), id: \.pid) { session in
                        HStack {
                            statusIndicator(session.status)
                            Text(session.status.capitalized)
                                .font(.caption2)
                            if let terminalName = session.terminalName {
                                Text("• \(terminalName)")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
                .padding(8)
                .background(Color.purple.opacity(0.1))
                .cornerRadius(8)
            }

            // File Activity
            if let fileActivity = instance.extensionState?.fileActivity {
                HStack {
                    if fileActivity.dirtyFileCount > 0 {
                        Label("\(fileActivity.dirtyFileCount) unsaved", systemImage: "doc.badge.ellipsis")
                            .font(.caption2)
                            .foregroundColor(.orange)
                    }

                    if fileActivity.savesPerFiveMinutes > 0 {
                        Label("\(fileActivity.savesPerFiveMinutes) saves/5min", systemImage: "arrow.down.doc")
                            .font(.caption2)
                            .foregroundColor(.green)
                    }
                }
            }

            // Terminals
            if let terminals = instance.extensionState?.terminals, terminals.total > 0 {
                HStack {
                    Image(systemName: "terminal")
                        .font(.caption)
                    Text("\(terminals.total) terminal(s)")
                        .font(.caption2)
                    if terminals.active > 0 {
                        Text("• \(terminals.active) active")
                            .font(.caption2)
                            .foregroundColor(.green)
                    }
                }
                .foregroundColor(.secondary)
            }

            // Path (truncated)
            Text(instance.path)
                .font(.caption2)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.1), radius: 5, x: 0, y: 2)
    }

    private func prStatusBadge(_ state: String) -> some View {
        Text(state)
            .font(.caption2)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(stateColor(state))
            .foregroundColor(.white)
            .cornerRadius(4)
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "OPEN":
            return .green
        case "MERGED":
            return .purple
        case "CLOSED":
            return .red
        default:
            return .gray
        }
    }

    private func checksView(_ checks: PRStatus.Checks) -> some View {
        Group {
            if checks.passing > 0 {
                Label("\(checks.passing)", systemImage: "checkmark.circle.fill")
                    .foregroundColor(.green)
            }
            if checks.failing > 0 {
                Label("\(checks.failing)", systemImage: "xmark.circle.fill")
                    .foregroundColor(.red)
            }
            if checks.pending > 0 {
                Label("\(checks.pending)", systemImage: "clock.fill")
                    .foregroundColor(.orange)
            }
        }
    }

    private func statusIndicator(_ status: String) -> some View {
        Circle()
            .fill(statusColor(status))
            .frame(width: 8, height: 8)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "working":
            return .green
        case "waiting":
            return .yellow
        case "idle":
            return .gray
        case "finished":
            return .blue
        default:
            return .gray
        }
    }
}
