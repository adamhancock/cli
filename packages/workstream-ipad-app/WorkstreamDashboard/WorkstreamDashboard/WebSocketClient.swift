import Foundation

class WebSocketClient: ObservableObject {
    @Published var isConnected = false
    @Published var instances: [InstanceWithMetadata] = []
    @Published var lastUpdate: Date?
    @Published var error: String?

    private var webSocketTask: URLSessionWebSocketTask?
    private let baseURL: String
    private let reconnectDelay: TimeInterval = 3.0
    private var shouldReconnect = true

    init(baseURL: String = "ws://localhost:3000") {
        self.baseURL = baseURL
    }

    func connect() {
        shouldReconnect = true
        let wsURL = URL(string: "\(baseURL)/ws")!

        webSocketTask = URLSession.shared.webSocketTask(with: wsURL)
        webSocketTask?.resume()

        DispatchQueue.main.async {
            self.isConnected = true
            self.error = nil
        }

        receiveMessage()
    }

    func disconnect() {
        shouldReconnect = false
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        DispatchQueue.main.async {
            self.isConnected = false
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }

                // Continue receiving messages
                self.receiveMessage()

            case .failure(let error):
                print("WebSocket receive error: \(error)")
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.error = error.localizedDescription
                }

                // Attempt to reconnect
                if self.shouldReconnect {
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.reconnectDelay) {
                        self.connect()
                    }
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }

        do {
            // Try to decode as a generic message first to check the type
            let decoder = JSONDecoder()
            let genericMessage = try decoder.decode(GenericMessage.self, from: data)

            if genericMessage.type == "instances", let messageData = genericMessage.data {
                // Decode the nested instances data
                let instancesResponse = try decoder.decode(InstancesResponse.self, from: messageData)

                DispatchQueue.main.async {
                    self.instances = instancesResponse.instances
                    self.lastUpdate = Date()
                }
            }
        } catch {
            print("Error decoding WebSocket message: \(error)")
            print("Message: \(text)")
        }
    }

    func sendRefresh() {
        let message = """
        {"type":"refresh"}
        """

        webSocketTask?.send(.string(message)) { error in
            if let error = error {
                print("WebSocket send error: \(error)")
            }
        }
    }

    // Helper struct for initial decoding
    private struct GenericMessage: Codable {
        let type: String
        let data: Data?
        let timestamp: Double
    }
}
