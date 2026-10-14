import Foundation
import SwiftUI

private func capture<T>(_ operation: () async throws -> T) async -> (T?, String?) {
    do {
        return (try await operation(), nil)
    } catch {
        return (nil, error.localizedDescription)
    }
}

@MainActor final class Store: ObservableObject {
    @Published var accounts: [Account] = []
    @Published var account: Account?
    @Published var data = Snapshot(games: [], consoles: [], jobs: [], library: [], consoleId: "")
    @Published var error: String?
    @Published var offline = false
    @Published var loading = false
    var api: API?
    private var poll: Task<Void, Never>?
    private var live: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var refreshing = false
    init() {
        if let saved = UserDefaults.standard
            .data(forKey: "accounts")
        {
            accounts = (try? JSONDecoder().decode(
                [Account].self,
                from: saved
            )) ?? []
        }
        if let id = UserDefaults.standard.string(forKey: "activeAccount"),
           let selected = accounts.first(where: { $0.id == id })
        {
            activate(selected)
        }
    }

    func cache(_ id: String) throws -> URL {
        let folder = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("PS5Library", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(id + ".json")
    }

    func activate(_ selected: Account) {
        poll?.cancel()
        live?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        account = selected
        api = nil
        refreshing = false
        data = Snapshot(games: [], consoles: [], jobs: [], library: [], consoleId: "")
        offline = true
        if let file = try? cache(selected.id), let saved = try? Data(contentsOf: file),
           let value = try? JSONDecoder().decode(
               Snapshot.self,
               from: saved
           )
        {
            data = value
        }
        guard let token = Credentials.read(selected.id) else {
            error = "Sign in to this account again."
            account = nil
            return
        }
        do {
            api = try API(server: selected.server, fallback: selected.fallbackServer, token: token)
        } catch {
            self.error = error.localizedDescription
            return
        }
        UserDefaults.standard.set(selected.id, forKey: "activeAccount")
        poll = Task {
            while !Task.isCancelled { await refresh()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        live = Task {
            var cursor: Int64 = 0
            while !Task.isCancelled {
                do {
                    guard let api = self.api else {
                        return
                    }
                    let connection = try await api.events(after: cursor)
                    socket = connection
                    while !Task.isCancelled {
                        let message = try await connection.receive()
                        let bytes: Data
                        switch message {
                        case .data(let value): bytes = value
                        case .string(let value): bytes = Data(value.utf8)
                        @unknown default: continue
                        }
                        guard let batch = try? JSONDecoder().decode(Events.self, from: bytes)
                        else { continue }
                        cursor = batch.events.last?.id ?? cursor
                        var refreshRequired = false
                        for event in batch
                            .events
                        {
                            if let index = data.jobs
                                .firstIndex(where: { $0.id == event.jobId })
                            {
                                data.jobs[index] = data.jobs[index].applying(event)
                            } else {
                                refreshRequired = true
                            }
                            refreshRequired = refreshRequired || event.terminal
                        }
                        if !batch.events.isEmpty {
                            offline = false
                        }
                        if refreshRequired { await refresh() }
                    }
                } catch {
                    if Task.isCancelled {
                        return
                    }
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            }
        }
    }

    func refresh() async {
        guard !refreshing, let api = api, let selected = account else {
            return
        }
        refreshing = true
        loading = data.games.isEmpty
        defer {
            if account?.id == selected.id {
                refreshing = false
                loading = false
            }
        }
        async let games: ([Game]?, String?) = capture {
            try await api.request("/catalog")
        }
        async let consoles: ([Console]?, String?) = capture {
            try await api.request("/consoles")
        }
        async let jobs: ([Job]?, String?) = capture {
            try await api.request("/jobs")
        }
        async let installations: ([InstallationStatus]?, String?) = capture {
            try await api.request("/installations")
        }
        let fetched = await (games, consoles, jobs, installations)
        let batch = RefreshBatch(
            games: fetched.0.0,
            consoles: fetched.1.0,
            jobs: fetched.2.0,
            installations: fetched.3.0
        )
        guard account?.id == selected.id, !Task.isCancelled else {
            return
        }
        guard batch.reachable else {
            offline = true
            error = fetched.0.1 ?? fetched.1.1 ?? fetched.2.1 ?? fetched.3.1 ?? "Cannot reach PS5Library."
            return
        }
        var next = batch.applying(to: data)
        let id = next.consoleId
            .isEmpty ?
            (next.consoles.first(where: { $0.isDefault })?.id ?? next.consoles.first?.id ?? "") :
            next.consoleId
        if !id.isEmpty,
           let library: [LibraryEntry] = try? await api
           .request("/consoles/\(id)/library")
        {
            next.library = library
        } else if id != data.consoleId {
            next.library = []
        }
        guard account?.id == selected.id, !Task.isCancelled else {
            return
        }
        next.consoleId = id
        data = next
        offline = false
        error = nil
        if let file = try? cache(selected.id),
           let encoded = try? JSONEncoder().encode(data)
        {
            try? encoded.write(
                to: file,
                options: [.atomic, .completeFileProtection]
            )
        }
    }

    func login(
        server: String,
        fallbackServer: String,
        username: String,
        password: String,
        invite: String,
        register: Bool
    ) async throws {
        guard let url = normalizedServerAddress(server)
        else {
            throw StoreError
                .message(
                    "Enter HTTPS, a private LAN URL, or a LAN address such as 192.168.x.x:3150."
                )
        }
        let fallback: URL?
        if fallbackServer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fallback = nil
        } else if let value = normalizedServerAddress(fallbackServer) {
            fallback = value == url ? nil : value
        } else {
            throw StoreError.message("Enter a valid private Tailscale fallback address.")
        }
        let client = try API(server: url, fallback: fallback)
        var body = ["username": username, "password": password]
        if register { body["inviteToken"] = invite }
        let result: Login = try await client.request(
            register ? "/auth/register" : "/auth/login",
            method: "POST",
            json: body
        )
        let id = accounts.first(where: { $0.server == url && $0.username == username })?
            .id ?? UUID().uuidString
        let profile = Account(
            id: id,
            server: url,
            fallbackServer: fallback,
            username: result.user.username,
            role: result.user.role
        )
        try Credentials.save(result.token, id: id)
        accounts.removeAll(where: { $0.id == id })
        accounts.append(profile)
        UserDefaults.standard.set(try JSONEncoder().encode(accounts), forKey: "accounts")
        activate(profile)
    }

    func updateFallback(_ input: String) throws {
        guard var selected = account,
              let index = accounts
              .firstIndex(where: { $0.id == selected.id
              })
        else {
            return
        }
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            selected.fallbackServer = nil
        } else if let url = normalizedServerAddress(value) {
            selected.fallbackServer = url == selected.server ? nil : url
        } else {
            throw StoreError.message("Enter a valid private Tailscale fallback address.")
        }
        accounts[index] = selected
        UserDefaults.standard.set(try JSONEncoder().encode(accounts), forKey: "accounts")
        activate(selected)
    }

    func perform(_ action: @escaping (API) async throws -> Void) {
        guard let api = api else {
            return
        }
        let owner = account?.id
        Task {
            do {
                try await action(api)
                if account?.id == owner { await refresh() }
            } catch {
                if account?.id == owner {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    func ready(_ game: Game) -> Bool {
        game.ready(in: data.library)
    }

    func signOut() {
        let old = api
        let profile = account
        poll?.cancel()
        live?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        api = nil
        account = nil
        data = Snapshot(games: [], consoles: [], jobs: [], library: [], consoleId: "")
        if let profile = profile {
            Credentials.remove(profile.id)
            accounts.removeAll { $0.id == profile.id }
            if let file = try? cache(profile.id) {
                try? FileManager.default.removeItem(at: file)
            }
        }
        UserDefaults.standard.set(try? JSONEncoder().encode(accounts), forKey: "accounts")
        Task {
            let _: Acknowledgement? = try? await old?.request("/auth/logout", method: "POST")
        }
    }
}
