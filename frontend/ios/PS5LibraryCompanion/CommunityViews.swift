import SwiftUI

struct CommunityFriendsView: View {
    @EnvironmentObject var store: Store
    @State private var status: CommunityAccountStatus?
    @State private var friends: [CommunityFriend] = []
    @State private var requests = CommunityFriendRequests(incoming: [], outgoing: [])
    @State private var handle = ""
    @State private var busy = false
    @State private var failure: String?
    var body: some View {
        List {
            Section("Community account") {
                if let account = status?.account {
                    LabeledContent(
                        "Connected as",
                        value: "@" + account.handle
                    )
                    Text(account.displayName).foregroundStyle(.secondary)
                } else {
                    LabeledContent("State", value: readable(status?.state ?? "DISCONNECTED"))
                }
                if status?
                    .configured ==
                    false
                {
                    Text("Community services are not configured on this Library Node.")
                        .foregroundStyle(.secondary)
                } else if status?
                    .state ==
                    "DISCONNECTED"
                {
                    Button("Connect Community account") {
                        connect()
                    }
                    .disabled(busy || store.offline)
                } else if status?.state == "AWAITING_OWNER" {
                    if let code = status?.userCode {
                        Text(code).font(.system(
                            .title2,
                            design: .monospaced
                        ).weight(.bold)).tracking(3).textSelection(.enabled)
                    }
                    if let location = status?.verificationUriComplete,
                       let url = URL(string: location)
                    {
                        Link(
                            "Sign in with passkey and authorize",
                            destination: url
                        )
                    }
                    Button("Check authorization") {
                        Task { await refreshLink() }
                    }.disabled(busy)
                }
                if ["CONNECTED", "DISCONNECT_PENDING"].contains(status?.state ?? "") {
                    Button(
                        status?
                            .state == "DISCONNECT_PENDING" ? "Retry disconnect" :
                            "Disconnect Community account",
                        role: .destructive
                    ) {
                        disconnect()
                    }.disabled(busy)
                }
                if let error = status?.error {
                    Text(readable(error)).foregroundStyle(warning)
                }
            }
            if status?.state == "CONNECTED" {
                Section("Add friend") {
                    HStack {
                        TextField("Exact handle", text: $handle).textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Send") {
                            addFriend()
                        }
                        .disabled(busy || handle.trimmingCharacters(in: .whitespacesAndNewlines)
                            .isEmpty)
                    }
                }
                if !requests.incoming
                    .isEmpty
                {
                    Section("Requests") {
                        ForEach(requests.incoming) { request in
                            if let person = request
                                .from
                            {
                                VStack(alignment: .leading) {
                                    Text(person.displayName)
                                    Text("@" + person.handle).font(.caption)
                                        .foregroundStyle(.secondary)
                                    HStack {
                                        Button("Accept") {
                                            act(request, "accept")
                                        }
                                        .buttonStyle(.borderedProminent)
                                        Button("Decline", role: .destructive) {
                                            act(request, "decline")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if !requests.outgoing
                    .isEmpty
                {
                    Section("Sent") {
                        ForEach(requests.outgoing) { request in
                            if let person = request
                                .to
                            {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(person.displayName)
                                        Text("@" + person.handle).font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("Cancel", role: .destructive) {
                                        act(request, "cancel")
                                    }
                                }
                            }
                        }
                    }
                }
                Section("Friends") {
                    if friends.isEmpty {
                        Text("No friends yet.").foregroundStyle(.secondary)
                    }
                    ForEach(friends) { friend in
                        HStack(spacing: 12) {
                            Circle()
                                .fill(friend.state == "ONLINE" ? success : friend
                                    .state == "AWAY" ? warning : Color.secondary).frame(
                                    width: 10,
                                    height: 10
                                )
                            VStack(alignment: .leading) {
                                Text(friend.displayName)
                                Text("@" + friend
                                    .handle + " · " +
                                    (friend.session
                                        .map {
                                            "Playing online · \($0.playerCount)/\($0.maxPlayers)"
                                        } ??
                                        readable(friend.state))).font(.caption)
                                    .foregroundStyle(friend.session == nil ? Color.secondary : Color
                                        .accentColor)
                            }
                        }.swipeActions {
                            Button(
                                "Unfriend",
                                role: .destructive
                            ) {
                                unfriend(friend)
                            }
                        }
                    }
                }
            }
            if let failure {
                Section {
                    Text(failure).foregroundStyle(warning)
                    Button("Retry") {
                        Task { await load() }
                    }
                }
            }
            Section {
                Text(
                    "Your Library Node relays Community account, friend and presence requests. Sony credentials are never requested."
                )
                .font(.footnote).foregroundStyle(.secondary)
            }
        }.cinematicList().navigationTitle("Community Friends").task { await monitor() }
            .refreshable { await load() }.disabled(busy)
    }

    func monitor() async { await load()
        while !Task.isCancelled,
              status?.state == "AWAITING_OWNER"
        {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await refreshLink()
        }
    }

    @MainActor func load() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        do {
            let value: CommunityAccountStatus = try await api.request("/community/account")
            guard store.account?.id == owner else {
                return
            }
            status = value
            if value
                .state ==
                "CONNECTED"
            {
                async let found: [CommunityFriend] = api.request("/community/friends/presence")
                async let pending: CommunityFriendRequests = api
                    .request("/community/friends/requests")
                (friends, requests) = try await (found, pending)
            } else {
                friends = []
                requests = CommunityFriendRequests(incoming: [], outgoing: [])
            }
            failure = nil
        } catch {
            if store.account?.id == owner {
                failure = error.localizedDescription
            }
        }
    }

    func connect() {
        run(checkAccount: true) { api in
            status = try await api.request(
                "/community/account/request",
                method: "POST",
                body: CommunityIdentityRequest(deviceName: UIDevice.current.name + " companion")
            )
            failure = nil
        }
    }

    @MainActor func refreshLink() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        do {
            let body: [String: String] = [:]
            let value: CommunityAccountStatus = try await api.request(
                "/community/account/refresh",
                method: "POST",
                body: body
            )
            guard store.account?.id == owner else {
                return
            }
            status = value
            if value.state == "CONNECTED" { await load() }
            failure = nil
        } catch {
            if store.account?.id == owner {
                failure = error.localizedDescription
            }
        }
    }

    func addFriend() {
        let value = handle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else {
            return
        }
        run { api in
            let _: Acknowledgement = try await api.request(
                "/community/friends/requests",
                method: "POST",
                body: CommunityFriendRequestBody(handle: value)
            )
            handle = ""
            await load()
        }
    }

    func act(_ request: CommunityFriendRequest, _ action: String) {
        run { api in
            let method = action == "cancel" ? "DELETE" : "POST"
            let path = action == "cancel" ? "/community/friends/requests/\(request.id)" : "/community/friends/requests/\(request.id)/\(action)"
            try await api.send(path, method: method, body: [String: String]())
            await load()
        }
    }

    func unfriend(_ friend: CommunityFriend) {
        run { api in
            try await api.send(
                "/community/friends/\(friend.handle)",
                method: "DELETE",
                body: [String: String]()
            )
            await load()
        }
    }

    func disconnect() {
        run { api in
            let body: [String: String] = [:]
            status = try await api.request("/community/account", method: "DELETE", body: body)
            friends = []
            requests = CommunityFriendRequests(incoming: [], outgoing: [])
            failure = nil
        }
    }

    func run(checkAccount: Bool = false, _ action: @escaping (API) async throws -> Void) {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        busy = true
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                try await action(api)
            } catch {
                if !checkAccount || store.account?.id == owner {
                    failure = error.localizedDescription
                }
            }
        }
    }
}

struct NotificationsView: View {
    @EnvironmentObject var store: Store
    @State private var notices: [Notice] = []
    @State private var loaded = false
    @State private var failure: String?
    var body: some View {
        List {
            if !loaded && failure == nil {
                ProgressView("Loading notifications…")
            }
            if loaded && notices.isEmpty {
                ContentUnavailableView(
                    "No notifications",
                    systemImage: "bell",
                    description: Text("Console notices will appear here.")
                )
            }
            ForEach(notices) { notice in
                VStack(alignment: .leading, spacing: 6) {
                    Text(readable(notice.code)).font(.headline)
                    Text(notice.message)
                    if let console = store.data.consoles
                        .first(where: { $0.id == notice.consoleId })
                    {
                        Text(console.name).font(.caption).foregroundStyle(.secondary)
                    }
                    if let date = ISO8601DateFormatter().date(from: notice.createdAt) {
                        Text(
                            date,
                            style: .date
                        ).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let failure = failure {
                Text(failure).foregroundStyle(warning)
                Button("Retry") {
                    Task { await load() }
                }
            }
        }.cinematicList().navigationTitle("Notifications").task { await load() }
            .refreshable { await load() }
    }

    func load() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        do {
            let result: [Notice] = try await api.request("/notifications")
            guard !Task.isCancelled, store.account?.id == owner else {
                return
            }
            notices = result
            loaded = true
            failure = nil
        } catch {
            if !Task.isCancelled,
               store.account?.id == owner
            {
                failure = error.localizedDescription
            }
        }
    }
}

struct InvitationView: View { @EnvironmentObject var store: Store
    @State private var invitation = ""
    var body: some View {
        Button("Create invitation for a friend") {
            store.perform { api in
                let response: Invitation = try await api.request(
                    "/admin/invites",
                    method: "POST"
                )
                invitation = response.token
            }
        }
        if !invitation.isEmpty {
            Text("Single use · expires in 7 days").font(.caption)
            Text(invitation).font(.caption.monospaced()).textSelection(.enabled)
        }
    }
}

struct CommunityConnectionView: View {
    @EnvironmentObject var store: Store
    @State private var status: CommunityStatus?
    @State private var name = "Family Library"
    @State private var busy = false
    @State private var failure: String?
    var body: some View {
        Form {
            Section("Connection") {
                if let status {
                    LabeledContent("State", value: readable(status.state))
                    if let serverId = status
                        .serverId
                    {
                        LabeledContent("Server ID") {
                            Text(serverId).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                    if let reason = status.banReason {
                        LabeledContent("Ban reason", value: reason)
                    }
                    if let error = status.error {
                        LabeledContent(
                            "Last error",
                            value: readable(error)
                        )
                    }
                } else {
                    ProgressView("Loading community status…")
                }
            }
            if status?.configured == false {
                Section {
                    Text(
                        "Configure Community services on this Library Node, then restart the Node."
                    )
                    .foregroundStyle(.secondary)
                }
            } else if status?.state == "DISCONNECTED" {
                Section("Request access") {
                    TextField("Server name", text: $name)
                    Button("Request Community access") {
                        requestAccess()
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines)
                        .isEmpty)
                }
            } else if status?.state == "AWAITING_OWNER" {
                Section("Authorize this server") {
                    if let code = status?.userCode {
                        Text(code).font(.system(
                            .title2,
                            design: .monospaced
                        ).weight(.bold)).tracking(3).textSelection(.enabled)
                    }
                    if let value = status?.verificationUriComplete,
                       let url = URL(string: value)
                    {
                        Link(
                            "Sign in with passkey and authorize",
                            destination: url
                        )
                    }
                    Text(
                        "A Community administrator must approve this Library Node after you authorize it."
                    )
                    .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let status, status.state != "DISCONNECTED" {
                Section {
                    Button("Refresh status") {
                        refresh()
                    }.disabled(busy)
                    Button("Disconnect Community services", role: .destructive) {
                        disconnect()
                    }
                    .disabled(busy)
                }
            }
            Section {
                Text(
                    "This companion only contacts the Library Node. The Node relays approved Community requests; games, packages and console credentials stay local."
                )
                .font(.footnote).foregroundStyle(.secondary)
            }
            if let failure {
                Section {
                    Text(failure).foregroundStyle(warning)
                }
            }
        }.cinematicList().navigationTitle("Community Services").task { await monitor() }
            .refreshable { await load() }.disabled(busy)
    }

    func monitor() async { await load()
        while !Task.isCancelled,
              ["AWAITING_OWNER", "PENDING"]
              .contains(status?.state ?? "")
        {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await load()
        }
    }

    @MainActor func load() async {
        guard let api = store.api else {
            return
        }
        do {
            status = try await api.request("/admin/community")
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    func requestAccess() {
        let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        run { api in
            status = try await api.request(
                "/admin/community/request",
                method: "POST",
                body: CommunityRequest(displayName: displayName)
            )
            failure = nil
        }
    }

    func refresh() {
        run { api in
            let empty: [String: String] = [:]
            status = try await api.request(
                "/admin/community/refresh",
                method: "POST",
                body: empty
            )
            failure = nil
        }
    }

    func disconnect() {
        run { api in
            let _: Acknowledgement = try await api.request(
                "/admin/community",
                method: "DELETE",
                body: [String: String]()
            )
            await load()
        }
    }

    func run(_ action: @escaping (API) async throws -> Void) {
        guard let api = store.api else {
            return
        }
        busy = true
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                try await action(api)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
