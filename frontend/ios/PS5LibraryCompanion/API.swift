import Foundation
import Security
import CryptoKit

private final class NoRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum StoreError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case let .message(text) = self {
            return text
        }
        return nil
    }
}

enum Credentials {
    static func query(_ id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "PS5Library",
            kSecAttrAccount as String: id
        ]
    }

    static func read(_ id: String) -> String? {
        var q = query(id)
        q[kSecReturnData as String] = true
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data
        else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, id: String) throws {
        SecItemDelete(query(id) as CFDictionary)
        var q = query(id)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess
        else {
            throw StoreError.message("Could not save your sign-in securely.")
        }
    }

    static func remove(_ id: String) {
        SecItemDelete(query(id) as CFDictionary)
    }
}

actor API {
    let base: URL
    let fallback: URL?
    let token: String
    let session: URLSession
    private var verified = Set<URL>()
    init(server: URL, fallback: URL? = nil, token: String = "") throws {
        guard serverAddressAllowed(server),
              fallback.map(serverAddressAllowed) != false
        else {
            throw StoreError
                .message("Use HTTPS, or HTTP only for a private LAN or Tailscale address.")
        }
        base = server
        self.fallback = fallback == server ? nil : fallback
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        config.urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 128 * 1024 * 1024,
            diskPath: "PS5Library-" + server.host!
        )
        session = URLSession(
            configuration: config,
            delegate: NoRedirectPolicy(),
            delegateQueue: nil
        )
    }

    func url(_ path: String, server: URL) throws -> URL {
        guard path.hasPrefix("/api/v1/"), !path.contains(".."), let url = URL(
            string: path,
            relativeTo: server
        )?.absoluteURL, url.host == server.host, url.port == server.port,
            url.scheme == server.scheme
        else {
            throw StoreError.message("Invalid server resource.")
        }
        return url
    }

    func makeRequest(
        _ path: String,
        server: URL
    ) throws -> URLRequest {
        var request = URLRequest(url: try url(
            path,
            server: server
        ))
        request.setValue("companion", forHTTPHeaderField: "X-PS5Library-Client")
        if !token.isEmpty {
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func routed<T>(_ operation: (URL) async throws -> T) async throws -> T {
        do {
            return try await operation(base)
        } catch {
            guard serverTransportFailure(error), let fallback else { throw error }
            return try await operation(fallback)
        }
    }

    private func connectionError(_ error: Error)
        -> Error
    {
        if let message = serverConnectionMessage(
            error,
            server: fallback ?? base
        ) {
            return StoreError.message(message)
        }
        return error
    }

    private func downloadSession(resourceTimeout: TimeInterval) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = resourceTimeout
        return URLSession(
            configuration: config,
            delegate: NoRedirectPolicy(),
            delegateQueue: nil
        )
    }

    private func verifyLibraryNode(_ server: URL, refresh: Bool = false) async throws {
        if !refresh, verified.contains(server) {
            return
        }
        var request = URLRequest(url: try url("/api/v1/service-info", server: server))
        request.setValue("companion", forHTTPHeaderField: "X-PS5Library-Client")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              data.count <= 1024,
              let marker = try? JSONDecoder().decode(LibraryNodeServiceInfo.self, from: data),
              marker.compatible
        else {
            throw StoreError.message("This address is not a compatible PS5Library Server.")
        }
        verified.insert(server)
    }

    func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        json: [String: String] = [:]
    ) async throws -> T {
        try await request(path, method: method, body: json)
    }

    func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body
    ) async throws -> T {
        let data = try await response(
            path,
            method: method,
            body: method == "GET" ? nil : JSONEncoder().encode(body)
        )
        return try JSONDecoder().decode(T.self, from: data)
    }

    func send<Body: Encodable>(_ path: String, method: String, body: Body) async throws {
        _ = try await response(
            path,
            method: method,
            body: JSONEncoder().encode(body)
        )
    }

    private func response(_ path: String, method: String, body: Data?) async throws -> Data {
        do {
            return try await routed { server in
                try await verifyLibraryNode(server)
                var request = try makeRequest("/api/v1" + path, server: server)
                request.httpMethod = method
                if let body {
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = body
                }
                let (data, response) = try await session.data(for: request)
                guard let response = response as? HTTPURLResponse,
                      (200 ..< 300).contains(response.statusCode)
                else {
                    let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    throw StoreError
                        .message(readable(value?["error"] as? String ?? "Server request failed"))
                }
                guard data.count <= 12 * 1024 * 1024
                else {
                    throw StoreError.message("Server response is too large.")
                }
                return data
            }
        } catch {
            throw connectionError(error)
        }
    }

    func artwork(_ path: String) async throws -> Data {
        do {
            return try await routed { server in
                try await verifyLibraryNode(server)
                let (data, response) = try await session.data(for: makeRequest(
                    path,
                    server: server
                ))
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      data.count <= 12 * 1024 * 1024
                else {
                    throw StoreError.message("Artwork unavailable")
                }
                return data
            }
        } catch {
            throw connectionError(error)
        }
    }

    func media(_ asset: MediaAsset, kind: String) async throws -> URL {
        guard asset.valid(for: kind) else {
            throw StoreError.message("Invalid media metadata.")
        }
        let download = downloadSession(resourceTimeout: 300)
        defer {
            download.invalidateAndCancel()
        }
        do {
            return try await routed { server in
                try await verifyLibraryNode(server)
                let (stream, response) = try await download.bytes(for: makeRequest(
                    asset.url,
                    server: server
                ))
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      response.mimeType == (kind == "music" ? "audio/mp4" : "video/mp4"),
                      response.expectedContentLength == -1 || response
                      .expectedContentLength == asset
                      .size
                else {
                    throw StoreError
                        .message("Media unavailable or changed. Refresh the catalog and try again.")
                }
                let file = FileManager.default.temporaryDirectory
                    .appendingPathComponent("PS5Library-" + UUID().uuidString + ".mp4")
                guard FileManager.default.createFile(
                    atPath: file.path,
                    contents: nil,
                    attributes: [.protectionKey: FileProtectionType.complete]
                ) else {
                    throw StoreError.message("Could not create playback file.")
                }
                var keep = false
                defer {
                    if !keep {
                        try? FileManager.default.removeItem(at: file)
                    }
                }
                let output = try FileHandle(forWritingTo: file)
                defer {
                    try? output.close()
                }
                var count: Int64 = 0
                var chunk = Data()
                var digest = SHA256()
                for try await byte in stream {
                    count += 1
                    guard count <= asset.size
                    else {
                        throw StoreError.message("Media exceeds its declared size.")
                    }
                    chunk.append(byte)
                    if chunk.count == 65536 {
                        try Task.checkCancellation()
                        digest.update(data: chunk)
                        try output.write(contentsOf: chunk)
                        chunk.removeAll(keepingCapacity: true)
                    }
                }
                try Task.checkCancellation()
                digest.update(data: chunk)
                try output.write(contentsOf: chunk)
                guard count == asset.size,
                      digest.finalize().map({
                          String(format: "%02x", $0) }).joined() == asset.sha256
                else {
                    throw StoreError
                        .message("Media verification failed. Refresh the catalog and try again.")
                }
                keep = true
                return file
            }
        } catch {
            throw connectionError(error)
        }
    }

    func downloadSave(_ backup: SaveBackup) async throws -> URL {
        guard backup.downloadable, let location = backup.downloadUrl, let size = backup.totalBytes,
              let expected = backup.sha256
        else {
            throw StoreError.message("This backup is not ready to download.")
        }
        let download = downloadSession(resourceTimeout: 1800)
        defer {
            download.invalidateAndCancel()
        }
        do {
            return try await routed { server in
                try await verifyLibraryNode(server)
                let (source, response) = try await download.download(for: makeRequest(
                    location,
                    server: server
                ))
                guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                      response.mimeType == "application/vnd.ps5library.save",
                      response.expectedContentLength == size
                else {
                    throw StoreError
                        .message("The save backup response does not match the server record.")
                }
                let input = try FileHandle(forReadingFrom: source)
                defer {
                    try? input.close()
                }
                var count: Int64 = 0
                var digest = SHA256()
                while let data = try input.read(upToCount: 1024 * 1024),
                      !data.isEmpty
                {
                    try Task.checkCancellation()
                    count += Int64(data.count)
                    guard count <= size
                    else {
                        throw StoreError.message("The save backup exceeds its declared size.")
                    }
                    digest.update(data: data)
                }
                guard count == size,
                      digest.finalize().map({
                          String(format: "%02x", $0) }).joined() == expected
                else {
                    throw StoreError.message("Save backup verification failed.")
                }
                let safe = (backup.saveTitleId + "-" + backup.directory)
                    .map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" }
                let destination = FileManager.default.temporaryDirectory
                    .appendingPathComponent(String(safe) + "-" + backup.id + ".ps5save")
                try? FileManager.default.removeItem(at: destination)
                do {
                    try FileManager.default.moveItem(at: source, to: destination)
                    try FileManager.default.setAttributes(
                        [.protectionKey: FileProtectionType.complete],
                        ofItemAtPath: destination.path
                    )
                    return destination
                } catch {
                    try? FileManager.default.removeItem(at: destination)
                    throw error
                }
            }
        } catch {
            throw connectionError(error)
        }
    }

    func events(after: Int64) async throws
        -> URLSessionWebSocketTask
    {
        do {
            return try await routed { server in
                try await verifyLibraryNode(
                    server,
                    refresh: true
                )
                var request = try makeRequest("/api/v1/events/live?after=\(after)", server: server)
                var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                url.scheme = webSocketScheme(for: server.scheme)
                request.url = url.url
                let socket = session.webSocketTask(with: request)
                socket.resume()
                do {
                    try await withCheckedThrowingContinuation { (ready: CheckedContinuation<
                        Void,
                        Error
                    >) in
                        socket
                            .sendPing { error in
                                if let error {
                                    ready.resume(throwing: error)
                                } else {
                                    ready.resume()
                                }
                            }
                    }
                } catch {
                    socket.cancel(
                        with: .goingAway,
                        reason: nil
                    )
                    throw error
                }
                return socket
            }
        } catch {
            throw connectionError(error)
        }
    }
}
