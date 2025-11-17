import Foundation

// MARK: - Core Models

struct VSCodeInstance: Codable, Identifiable {
    let name: String
    let path: String
    let branch: String?
    let isGitRepo: Bool

    var id: String { path }
}

struct GitInfo: Codable {
    let branch: String?
    let remote: String?
    let ahead: Int?
    let behind: Int?
    let isDirty: Bool?
    let lastCommit: LastCommit?

    struct LastCommit: Codable {
        let message: String
        let author: String
        let date: String
    }
}

struct PRStatus: Codable {
    let number: Int
    let title: String
    let url: String
    let state: String
    let mergeable: String?
    let checks: Checks?

    struct Checks: Codable {
        let total: Int
        let passing: Int
        let failing: Int
        let pending: Int
        let conclusion: String?
    }
}

struct ClaudeSession: Codable {
    let status: String
    let pid: Int
    let terminalName: String?
    let terminalId: String?
    let terminalPid: Int?
    let vscodePid: Int?
    let workStartTime: Double?
    let finishTime: Double?
    let lastActivity: Double?
}

struct ClaudeStatus: Codable {
    let sessions: [ClaudeSession]
    let hasActiveSessions: Bool
}

struct Terminal: Codable {
    let name: String
    let id: String
    let pid: Int?
    let purpose: String?
}

struct VSCodeExtensionState: Codable {
    let workspacePath: String
    let window: Window?
    let terminals: Terminals?
    let debugSessions: DebugSessions?
    let fileActivity: FileActivity?
    let gitEvents: GitEvents?
    let timestamp: Double

    struct Window: Codable {
        let isFocused: Bool
    }

    struct Terminals: Codable {
        let total: Int
        let active: Int
        let list: [Terminal]
    }

    struct DebugSessions: Codable {
        let active: Bool
        let count: Int
        let types: [String]
    }

    struct FileActivity: Codable {
        let lastSave: Double?
        let savesPerFiveMinutes: Int
        let activeFile: String?
        let dirtyFileCount: Int
    }

    struct GitEvents: Codable {
        let lastCheckout: Checkout?
        let lastCommit: Commit?

        struct Checkout: Codable {
            let branch: String
            let timestamp: Double
        }

        struct Commit: Codable {
            let message: String
            let timestamp: Double
        }
    }
}

struct TmuxStatus: Codable {
    let hasSession: Bool
    let sessionName: String?
}

struct CaddyHost: Codable {
    let host: String
    let url: String
    let upstreams: [String]
}

struct SpotlightStatus: Codable {
    let errors: Int
    let traces: Int
    let logs: Int
    let online: Bool
}

struct InstanceWithMetadata: Codable, Identifiable {
    let name: String
    let path: String
    let branch: String?
    let isGitRepo: Bool
    let gitInfo: GitInfo?
    let prStatus: PRStatus?
    let claudeStatus: ClaudeStatus?
    let tmuxStatus: TmuxStatus?
    let caddyHost: CaddyHost?
    let spotlightStatus: SpotlightStatus?
    let extensionState: VSCodeExtensionState?

    var id: String { path }
}

// MARK: - API Response Models

struct InstancesResponse: Codable {
    let instances: [InstanceWithMetadata]
    let timestamp: Double
}

struct WebSocketMessage: Codable {
    let type: String
    let data: Data?
    let timestamp: Double

    enum CodingKeys: String, CodingKey {
        case type, data, timestamp
    }
}
