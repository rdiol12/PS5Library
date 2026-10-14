import SwiftUI

struct CacheView: View { @EnvironmentObject var store: Store
    @State private var artifacts: [Artifact] = []
    var body: some View {
        List {
            Section {
                Text(
                    "Verified packages stay on your PC for reuse. Deleting a cached copy keeps the original source and your console's copy."
                )
                .font(.footnote)
            }
            ForEach(artifacts) { artifact in
                VStack(alignment: .leading) {
                    Text(artifact.title).font(.headline)
                    Text(artifact.version + " · " + bytes(artifact.size)).font(.caption)
                }.swipeActions {
                    Button(
                        "Delete PC copy",
                        role: .destructive
                    ) {
                        store.perform { api in
                            let _: Acknowledgement = try await api.request(
                                "/artifacts/\(artifact.id)",
                                method: "DELETE"
                            )
                            artifacts = try await api.request("/artifacts")
                        }
                    }
                }
            }
        }.cinematicList()
            .navigationTitle("Server cache").task {
                guard let api = store.api else {
                    return
                }
                do {
                    artifacts = try await api.request("/artifacts")
                } catch {
                    store.error = error.localizedDescription
                }
            }
    }
}

struct SourcesView: View {
    @EnvironmentObject var store: Store
    @State private var sources: [CatalogSource] = []
    @State private var loading = true
    @State private var adding = false
    @State private var syncing: String?
    @State private var failure: String?
    var body: some View {
        List {
            if loading {
                ProgressView("Loading sources...")
            }
            if !loading && sources.isEmpty && failure == nil {
                ContentUnavailableView(
                    "No sources yet",
                    systemImage: "folder",
                    description: Text("Add a source to import your catalog.")
                )
            }
            ForEach(sources) { source in
                Section(source.name) {
                    Text(readable(source.type)).font(.caption).foregroundStyle(.secondary)
                    if let last = source.last_synced {
                        Text("Last scan: " + last).font(.caption)
                    }
                    if let preparation = source
                        .autoPrepare
                    {
                        Text("Automatic preparation: " + preparation)
                    }
                    if source.shareCatalog == true {
                        Label(
                            "Shared with server members",
                            systemImage: "person.2"
                        )
                    }
                    if let error = source.error {
                        Text(readable(error)).foregroundStyle(warning)
                    }
                    ForEach(
                        Array(source.observations.enumerated()),
                        id: \.offset
                    ) { _, observation in
                        VStack(alignment: .leading) {
                            Text(observation.path).font(.caption)
                            Text(readable(observation.state)).font(.caption)
                                .foregroundStyle(.secondary)
                            if let error = observation
                                .error
                            {
                                Text(readable(error)).font(.caption).foregroundStyle(warning)
                            }
                        }
                    }
                    Button(syncing == source.id ? "Scanning..." : "Scan now") {
                        scan(source)
                    }
                    .disabled(syncing != nil || store.offline)
                }
            }
            if let failure = failure {
                Text(failure).foregroundStyle(warning)
                Button("Retry") {
                    Task { await load() }
                }
            }
        }.cinematicList().navigationTitle("Content Sources")
            .toolbar {
                Button("Add source", systemImage: "plus") {
                    adding = true
                }.disabled(store.offline)
            }
            .sheet(isPresented: $adding, onDismiss: {
                Task { await load() }
            }) {
                AddSourceView()
            }
            .task { await load() }.refreshable { await load() }
    }

    func load() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        defer {
            loading = false
        }
        do {
            let result: [CatalogSource] = try await api.request("/sources")
            guard !Task.isCancelled, store.account?.id == owner else {
                return
            }
            sources = result
            failure = nil
        } catch {
            if !Task.isCancelled,
               store.account?.id == owner
            {
                failure = error.localizedDescription
            }
        }
    }

    func scan(_ source: CatalogSource) {
        guard syncing == nil, let api = store.api else {
            return
        }
        let owner = store.account?.id
        syncing = source.id
        failure = nil
        Task { @MainActor in
            defer {
                syncing = nil
            }
            do {
                let _: Acknowledgement = try await api.request(
                    "/sources/\(source.id)/sync",
                    method: "POST"
                )
                guard store.account?.id == owner else {
                    return
                }
                await load()
                await store.refresh()
            } catch {
                guard store.account?.id == owner else {
                    return
                }
                let message = error.localizedDescription
                await load()
                failure = message
            }
        }
    }
}

struct AddSourceView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var type = "LOCAL_FOLDER"
    @State private var location = ""
    @State private var token = ""
    @State private var preparation = ""
    @State private var interval = 0
    @State private var shared = false
    @State private var busy = false
    @State private var failure: String?
    var admin: Bool {
        store.account?.role == "ADMIN"
    }

    var input: SourceInput {
        SourceInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            type: type,
            location: location.trimmingCharacters(in: .whitespacesAndNewlines),
            tokenEnv: admin && !token.isEmpty ? token : nil,
            scanIntervalMinutes: interval == 0 ? nil : interval,
            autoPrepare: admin && !preparation.isEmpty ? preparation : nil,
            shareCatalog: admin && shared
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Source") {
                    TextField("Name", text: $name)
                    Picker("Type", selection: $type) {
                        Text("Local folder").tag("LOCAL_FOLDER")
                        Text("Manifest URL").tag("STATIC_MANIFEST")
                        Text("Private HTTP repository").tag("PRIVATE_HTTP")
                        Text("GitHub release").tag("GITHUB_RELEASE")
                        if admin {
                            Text("Watched folder").tag("WATCH_FOLDER")
                        }
                    }
                    TextField("Location", text: $location).textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text(type == "GITHUB_RELEASE" ?
                        "Enter owner/repository. The latest release must contain ps5library.json." :
                        [
                            "LOCAL_FOLDER",
                            "WATCH_FOLDER"
                        ]
                        .contains(type) ?
                        "Enter a relative folder on the server. Use . for its configured root. Local folders contain library.json." :
                        "Enter the manifest URL. Private hosts must be allowed by your server configuration.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Scanning") {
                    Picker("Automatic scan", selection: $interval) {
                        Text("Manual only").tag(0)
                        Text("Every 5 minutes").tag(5)
                        Text("Every 30 minutes").tag(30)
                        Text("Every hour").tag(60)
                        Text("Daily").tag(1440)
                    }
                }
                if admin {
                    Section("Server options") {
                        TextField("REPOSITORY_TOKEN_... (optional)", text: $token)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Text(
                            "Enter an environment variable name configured on your server. Do not paste the token itself."
                        )
                        .font(.caption).foregroundStyle(.secondary)
                        Picker("Automatic preparation", selection: $preparation) {
                            Text("Off").tag("")
                            Text("FPKG").tag("FPKG")
                            Text("ShadowMount").tag("SHADOWMOUNT")
                            Text("Both").tag("BOTH")
                        }
                        Toggle("Share catalog with server members", isOn: $shared)
                    }
                }
                if let error = input
                    .validationError
                {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                }
                if let failure = failure {
                    Text(failure).foregroundStyle(warning)
                }
                if busy {
                    ProgressView("Saving source...")
                }
            }.disabled(busy).cinematicList().navigationTitle("Add Source")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }.disabled(busy)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            save()
                        }
                        .disabled(busy || input.validationError != nil || store.offline)
                    }
                }.interactiveDismissDisabled(busy)
        }
    }

    func save() {
        guard !busy, input.validationError == nil, let api = store.api else {
            return
        }
        let owner = store.account?.id
        let body = input
        busy = true
        failure = nil
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                let _: Acknowledgement = try await api.request(
                    "/sources",
                    method: "POST",
                    body: body
                )
                if store.account?.id == owner {
                    dismiss()
                }
            } catch {
                if store.account?.id == owner {
                    failure = error.localizedDescription
                }
            }
        }
    }
}

struct ServerConnectionView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @State private var fallback = ""
    @State private var failure: String?
    var body: some View {
        Form {
            Section("Primary server") {
                Text(store.account?.server.absoluteString ?? "").textSelection(.enabled)
            }
            Section("Tailscale fallback") {
                TextField("100.x.x.x:3150 or https://tailnet.example", text: $fallback)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .textContentType(.URL)
                Text(
                    "PS5Library always tries the primary server first. This address is used only when the primary connection cannot be reached."
                )
                .font(.caption).foregroundStyle(secondaryText)
                if let failure {
                    Text(failure).font(.footnote).foregroundStyle(warning)
                }
            }
            Button("Save") {
                do {
                    try store.updateFallback(fallback)
                    dismiss()
                } catch {
                    failure = error.localizedDescription
                }
            }
        }.cinematicList().navigationTitle("Server Connection")
            .onAppear {
                fallback = store.account?.fallbackServer?.absoluteString ?? ""
            }
    }
}

struct SignIn: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @State private var server = ""
    @State private var fallbackServer = ""
    @State private var username = ""
    @State private var password = ""
    @State private var invite = ""
    @State private var register = false
    @State private var busy = false
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            ZStack {
                CinematicBackdrop()
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        BrandMark()
                        VStack(alignment: .leading, spacing: 7) {
                            Text(register ? "Join a library" : "Welcome back")
                                .font(.largeTitle.bold())
                            Text(register ?
                                "Use an invitation from a server owner to create your private account." :
                                "Connect to your self-hosted library and your paired consoles.")
                                .foregroundStyle(secondaryText)
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            fieldLabel("SERVER")
                            TextField("https://library.example or 192.168.x.x:3150", text: $server)
                                .keyboardType(.URL).textInputAutocapitalization(.never)
                                .autocorrectionDisabled().textContentType(.URL)
                                .padding(.horizontal, 14).frame(minHeight: 50).background(
                                    .white.opacity(0.07),
                                    in: RoundedRectangle(cornerRadius: 12)
                                )
                            fieldLabel("TAILSCALE FALLBACK (OPTIONAL)")
                            TextField(
                                "100.x.x.x:3150 or https://tailnet.example",
                                text: $fallbackServer
                            )
                            .keyboardType(.URL).textInputAutocapitalization(.never)
                            .autocorrectionDisabled().textContentType(.URL)
                            .padding(.horizontal, 14).frame(minHeight: 50).background(
                                .white.opacity(0.07),
                                in: RoundedRectangle(cornerRadius: 12)
                            )
                            Text("Used only when the primary server cannot be reached.")
                                .font(.caption).foregroundStyle(secondaryText)
                            fieldLabel("ACCOUNT")
                            TextField("Username", text: $username)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .textContentType(.username)
                                .padding(.horizontal, 14).frame(minHeight: 50).background(
                                    .white.opacity(0.07),
                                    in: RoundedRectangle(cornerRadius: 12)
                                )
                            SecureField("Password", text: $password)
                                .textContentType(register ? .newPassword : .password)
                                .padding(.horizontal, 14).frame(minHeight: 50).background(
                                    .white.opacity(0.07),
                                    in: RoundedRectangle(cornerRadius: 12)
                                )
                            if register {
                                TextField("Invitation code", text: $invite)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .padding(.horizontal, 14).frame(minHeight: 50).background(
                                        .white.opacity(0.07),
                                        in: RoundedRectangle(cornerRadius: 12)
                                    )
                            }
                            if let failure {
                                Label(
                                    failure,
                                    systemImage: "exclamationmark.triangle.fill"
                                ).font(.footnote).foregroundStyle(warning)
                            }
                            Button(
                                register ? "Create account" : "Sign in",
                                systemImage: "arrow.right"
                            ) {
                                busy = true
                                Task {
                                    do {
                                        try await store.login(
                                            server: server,
                                            fallbackServer: fallbackServer,
                                            username: username,
                                            password: password,
                                            invite: invite,
                                            register: register
                                        )
                                        dismiss()
                                    } catch {
                                        failure = error.localizedDescription
                                    }
                                    password = ""
                                    busy = false
                                }
                            }.buttonStyle(.borderedProminent).controlSize(.large).frame(
                                maxWidth: .infinity,
                                minHeight: 50
                            )
                            .disabled(busy || username.isEmpty || password.isEmpty)
                            Button(register ? "I already have an account" :
                                "Use a friend's invitation")
                            {
                                withAnimation(.easeOut(duration: 0.18)) {
                                    register.toggle()
                                    failure = nil
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            if busy {
                                ProgressView(register ? "Creating your account..." :
                                    "Connecting to your library...").frame(maxWidth: .infinity)
                            }
                        }.cinematicCard(padding: 18)
                        Label(
                            "Your server, your account, and only your consoles.",
                            systemImage: "lock.shield.fill"
                        ).font(.footnote).foregroundStyle(secondaryText)
                    }.frame(maxWidth: 560).padding(.horizontal, 22).padding(.vertical, 32)
                        .frame(maxWidth: .infinity)
                }
            }
            .toolbar {
                if store
                    .account !=
                    nil
                {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.caption2.bold()).tracking(1.6).foregroundStyle(accent)
    }
}
