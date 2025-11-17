import Foundation
import Combine

@MainActor
class DashboardViewModel: ObservableObject {
    @Published var instances: [InstanceWithMetadata] = []
    @Published var isConnected = false
    @Published var lastUpdate: Date?
    @Published var error: String?
    @Published var apiBaseURL: String {
        didSet {
            UserDefaults.standard.set(apiBaseURL, forKey: "apiBaseURL")
            reconnect()
        }
    }

    private let webSocketClient: WebSocketClient
    private var cancellables = Set<AnyCancellable>()

    init() {
        // Load saved API URL or use default
        let savedURL = UserDefaults.standard.string(forKey: "apiBaseURL") ?? "ws://localhost:3000"
        self.apiBaseURL = savedURL
        self.webSocketClient = WebSocketClient(baseURL: savedURL)

        // Observe WebSocket client changes
        webSocketClient.$instances
            .receive(on: DispatchQueue.main)
            .assign(to: &$instances)

        webSocketClient.$isConnected
            .receive(on: DispatchQueue.main)
            .assign(to: &$isConnected)

        webSocketClient.$lastUpdate
            .receive(on: DispatchQueue.main)
            .assign(to: &$lastUpdate)

        webSocketClient.$error
            .receive(on: DispatchQueue.main)
            .assign(to: &$error)
    }

    func connect() {
        webSocketClient.connect()
    }

    func disconnect() {
        webSocketClient.disconnect()
    }

    func refresh() {
        webSocketClient.sendRefresh()
    }

    private func reconnect() {
        webSocketClient.disconnect()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            let newClient = WebSocketClient(baseURL: self.apiBaseURL)

            // Re-setup observers
            newClient.$instances
                .receive(on: DispatchQueue.main)
                .assign(to: &self.$instances)

            newClient.$isConnected
                .receive(on: DispatchQueue.main)
                .assign(to: &self.$isConnected)

            newClient.$lastUpdate
                .receive(on: DispatchQueue.main)
                .assign(to: &self.$lastUpdate)

            newClient.$error
                .receive(on: DispatchQueue.main)
                .assign(to: &self.$error)

            newClient.connect()
        }
    }

    // Computed properties for dashboard stats
    var totalInstances: Int {
        instances.count
    }

    var activeInstances: Int {
        instances.filter { instance in
            instance.extensionState?.window?.isFocused == true
        }.count
    }

    var instancesWithPRs: Int {
        instances.filter { $0.prStatus != nil }.count
    }

    var instancesWithClaude: Int {
        instances.filter { instance in
            instance.claudeStatus?.hasActiveSessions == true
        }.count
    }
}
