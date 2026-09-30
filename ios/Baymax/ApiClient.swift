import Foundation

struct ApiClient {
    let baseURL: URL

    struct ApiError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func ping() async throws {
        let (_, response) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("v1/ping"))
        try Self.check(response, data: nil)
    }

    func post(_ path: String, body: some Encodable) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data: data)
    }

    private static func check(_ response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw ApiError(message: "Not an HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            let detail = data.flatMap { String(data: $0, encoding: .utf8) }?.prefix(200) ?? ""
            throw ApiError(message: "HTTP \(http.statusCode) \(detail)")
        }
    }
}
