import SwiftUI

struct SaveBackupsView: View {
    @EnvironmentObject var store: Store
    let console: ProfileConsole
    @State private var backups: [SaveBackup] = []
    @State private var portable: [PortableSave] = []
    @State private var imports: [SaveImport] = []
    @State private var terms: CommunityTerms?
    @State private var acceptedRisk = false
    @State private var community: [CommunitySave] = []
    @State private var communityUnavailable = false
    @State private var busy = ""
    @State private var loading = false
    @State private var failure: String?
    @State private var exported: (id: String, url: URL)?
    @State private var deleting: SaveBackup?
    var live: Console? {
        store.data.consoles.first { $0.id == console.id }
    }

    var enabled: Bool {
        !store.offline && live?.presence == "ONLINE" && live?.capabilities?.saveBackup == true
    }

    var portableEnabled: Bool {
        enabled && live?.capabilities?.saveExport == true && live?.capabilities?
            .saveImport == true && live?.capabilities?.saveRollback == true
    }

    var body: some View {
        List {
            Section {
                Text(
                    "Encrypted backups remain bound to this PS5. Portable community saves use a separate console-local export/import path and always create an encrypted rollback backup first."
                )
                .font(.footnote)
            }
            Section("Saved games") {
                if (console.saveData ?? [])
                    .isEmpty
                {
                    Text("This console has not reported any save slots.")
                        .foregroundStyle(.secondary)
                }
                ForEach(console.saveData ?? []) { save in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(save.title
                            .isEmpty ? (save.subtitle.isEmpty ? save.saveTitleId : save.subtitle) :
                            save.title).font(.headline)
                        Text(save.platform + " | " + save
                            .saveTitleId + " | " + bytes(save.sizeBytes)).font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("Back up to server", systemImage: "arrow.up.doc") {
                                request(save)
                            }.buttonStyle(.borderedProminent)
                                .disabled(!enabled || !busy.isEmpty || active(save))
                            if portableEnabled,
                               let game = console.games
                               .first(where: { $0.titleId == save.gameTitleId })
                            {
                                Menu("Prepare portable save", systemImage: "person.2") {
                                    ForEach(
                                        game.versions,
                                        id: \.self
                                    ) { version in
                                        Button("Version " + version) {
                                            preparePortable(
                                                save,
                                                version
                                            )
                                        }
                                    }
                                }.disabled(!busy.isEmpty)
                            }
                        }
                    }.padding(.vertical, 4)
                }
                if !enabled {
                    Text(
                        "Open the updated PS5Library app on this console to enable encrypted backups."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Backup history") {
                if backups.isEmpty {
                    Text("No backups yet.").foregroundStyle(.secondary)
                }
                ForEach(backups) { backup in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(backup.saveTitleId + " | " + backup.directory).font(.headline)
                        Text(readable(backup.state) +
                            (backup.totalBytes
                                .map { " | " + bytes(backup.uploadedBytes) + " / " + bytes($0) } ??
                                " | Waiting for console")).font(.caption)
                            .foregroundStyle(.secondary)
                        if let progress = backup.progress,
                           !backup
                           .downloadable
                        {
                            ProgressView(value: progress)
                                .accessibilityLabel("\(backup.saveTitleId) backup upload")
                                .accessibilityValue(
                                    "\(bytes(backup.uploadedBytes)) of \(bytes(backup.totalBytes ?? 0))"
                                )
                        }
                        if let error = backup
                            .error
                        {
                            Text(readable(error)).font(.caption).foregroundStyle(warning)
                        }
                        HStack {
                            if exported?.id == backup.id,
                               let file = exported?.url
                            {
                                ShareLink(item: file) {
                                    Label(
                                        "Save to Files",
                                        systemImage: "square.and.arrow.up"
                                    )
                                }
                            } else if backup.downloadable {
                                Button(
                                    "Download",
                                    systemImage: "arrow.down.doc"
                                ) {
                                    download(backup)
                                }.disabled(!busy.isEmpty)
                            }
                            Button("Delete", role: .destructive) {
                                deleting = backup
                            }
                            .disabled(!busy.isEmpty)
                        }
                    }.padding(.vertical, 4)
                }
            }
            Section("Community saves") {
                if let terms, terms.accepted == false {
                    Text(terms.body).font(.footnote)
                    Toggle(terms.acceptLabel, isOn: $acceptedRisk)
                    Button("Accept and continue") {
                        acceptTerms(terms)
                    }
                    .disabled(!acceptedRisk || !busy.isEmpty)
                } else if terms?.accepted == true {
                    if !portableEnabled {
                        Text("Portable save mount/import is unavailable on this console runtime.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(portable) { save in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(save.displayName ?? save.saveTitleId).font(.headline)
                            Text(readable(save.origin) + " | " + save
                                .gameVersion + " | " + readable(save.state)).font(.caption)
                                .foregroundStyle(.secondary)
                            if let progress = save.progress,
                               save
                               .state !=
                               "READY"
                            {
                                ProgressView(value: progress)
                                    .accessibilityLabel(
                                        "\(save.displayName ?? save.saveTitleId) save transfer"
                                    )
                                    .accessibilityValue(
                                        "\(bytes(save.uploadedBytes)) of \(bytes(save.totalBytes ?? 0))"
                                    )
                            }
                            if let error = save
                                .error
                            {
                                Text(readable(error)).font(.caption).foregroundStyle(warning)
                            }
                            if save.origin == "EXPORT" && save.state == "READY" && save
                                .masterPublicationId ==
                                nil
                            {
                                Button("Submit for community review") {
                                    publish(save)
                                }
                                .disabled(!busy.isEmpty)
                            }
                            if save.origin == "COMMUNITY" && save
                                .state ==
                                "READY"
                            {
                                Button("Import with safety backup") {
                                    importSave(save)
                                }
                                .disabled(!portableEnabled || !busy
                                    .isEmpty || (console.saveData ?? [])
                                    .filter {
                                        $0.platform == save.platform && $0.gameTitleId == save
                                            .gameTitleId && $0.saveTitleId == save
                                            .saveTitleId &&
                                            $0
                                            .directory == save.directory
                                    }.count != 1)
                            }
                        }.padding(.vertical, 3)
                    }
                    Menu("Find compatible saves", systemImage: "magnifyingglass") {
                        ForEach(console.games.filter(\.available)) { game in
                            ForEach(
                                game.versions,
                                id: \.self
                            ) { version in
                                Button(game.title + " | " + version) {
                                    find(game, version)
                                }
                            }
                        }
                    }
                    .disabled(!portableEnabled || !busy.isEmpty)
                    ForEach(community) { save in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(save.displayName).font(.headline)
                            Text(save.publisher + " | " + save
                                .gameVersion + " | " + bytes(save.size))
                                .font(.caption).foregroundStyle(.secondary)
                            if !save.description.isEmpty {
                                Text(save.description).font(.footnote)
                            }
                            Button("Download to my server") {
                                downloadCommunity(save)
                            }
                            .disabled(!busy.isEmpty)
                        }.padding(
                            .vertical,
                            3
                        )
                    }
                    ForEach(imports) { item in
                        VStack(alignment: .leading) {
                            Text(item.displayName ?? item.saveTitleId).font(.headline)
                            Text("Import " + readable(item.state) + " | rollback " +
                                readable(item.rollbackState)).font(.caption)
                                .foregroundStyle(.secondary)
                            if ["REQUESTED", "IMPORTING", "VERIFYING"]
                                .contains(item.state)
                            {
                                ProgressView(value: item.progress)
                                Text(bytes(item.downloadedBytes) + " / " + bytes(item.totalBytes) +
                                    (item
                                        .speedBytesPerSecond > 0 ? " | " +
                                        bytes(item.speedBytesPerSecond) + "/s" :
                                        "")).font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            if let error = item
                                .error
                            {
                                Text(readable(error)).font(.caption).foregroundStyle(warning)
                            }
                        }
                    }
                } else if communityUnavailable {
                    Text("Community saves are unavailable. Encrypted backups still work.")
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView("Loading community terms...")
                }
            }
            if !busy.isEmpty {
                ProgressView("Working...")
            }
            if let failure {
                Section {
                    Text(failure).foregroundStyle(warning)
                    Button("Retry") {
                        Task { await load() }
                    }
                }
            }
        }.cinematicList().navigationTitle(console.name + " Saves").refreshable { await load() }
            .task {
                while !Task.isCancelled { await load()
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
            .onDisappear {
                if let file = exported?.url {
                    try? FileManager.default.removeItem(at: file)
                }
            }
            .alert(
                "Delete this backup?",
                isPresented: Binding(get: { deleting != nil }, set: {
                    if !$0 {
                        deleting = nil
                    }
                }),
                presenting: deleting
            ) { backup in
                Button("Delete", role: .destructive) {
                    remove(backup)
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("This removes the server copy. The save on your PS5 is unchanged.")
            }
    }

    func active(_ save: SaveSlot) -> Bool {
        backups
            .contains {
                $0.consoleId == console.id && $0.localUserId == save.localUserId && $0
                    .platform == save
                    .platform && $0.saveTitleId == save.saveTitleId && $0.directory == save
                    .directory && [
                        "REQUESTED",
                        "UPLOADING",
                        "VERIFYING"
                    ].contains($0.state)
            }
    }

    func load() async {
        guard !loading, let api = store.api else {
            return
        }
        loading = true
        defer {
            loading = false
        }
        do {
            let all: [SaveBackup] = try await api.request("/save-backups")
            if !Task.isCancelled {
                backups = all.filter { $0.consoleId == console.id }
                failure = nil
            }
        } catch {
            if !Task.isCancelled {
                failure = error.localizedDescription
            }
            return
        }
        async let allPortable: [PortableSave]? = try? api.request("/portable-saves")
        async let allImports: [SaveImport]? = try? api.request("/save-imports")
        async let currentTerms: CommunityTerms? = try? api.request("/community/terms")
        let result = await (allPortable, allImports, currentTerms)
        if !Task
            .isCancelled
        {
            if let values = result
                .0
            {
                portable = values.filter { $0.consoleId == nil || $0.consoleId == console.id }
            }
            if let values = result.1 {
                imports = values.filter { $0.consoleId == console.id }
            }
            terms = result.2
            communityUnavailable = result.2 == nil
        }
    }

    func request(_ save: SaveSlot) {
        run(save.id) { api in
            let _: Acknowledgement = try await api.request(
                "/consoles/\(console.id)/saves/backups",
                method: "POST",
                body: SaveBackupRequest(
                    localUserId: save.localUserId,
                    platform: save.platform,
                    gameTitleId: save.gameTitleId,
                    saveTitleId: save.saveTitleId,
                    directory: save.directory
                )
            )
        }
    }

    func download(_ backup: SaveBackup) {
        run(backup.id) { api in
            let file = try await api.downloadSave(backup)
            if let old = exported?.url {
                try? FileManager.default.removeItem(at: old)
            }
            exported = (backup.id, file)
        }
    }

    func remove(_ backup: SaveBackup) {
        run(backup.id) { api in
            let _: Acknowledgement = try await api.request(
                "/save-backups/\(backup.id)",
                method: "DELETE"
            )
            if exported?.id == backup.id,
               let file = exported?.url
            {
                try? FileManager.default.removeItem(at: file)
                exported = nil
            }
        }
    }

    func acceptTerms(_ value: CommunityTerms) {
        run("terms") { api in
            let _: Acknowledgement = try await api.request(
                "/community/terms/accept",
                method: "POST",
                body: CommunityConsent(
                    accepted: true,
                    termsVersion: value.version,
                    termsSha256: value.sha256
                )
            )
            acceptedRisk = false
        }
    }

    func preparePortable(_ save: SaveSlot, _ version: String) {
        run(save.id) { api in
            let _: SaveTaskCreated = try await api.request(
                "/consoles/\(console.id)/saves/exports",
                method: "POST",
                body: SaveExportRequest(
                    localUserId: save.localUserId,
                    platform: save.platform,
                    gameTitleId: save.gameTitleId,
                    saveTitleId: save.saveTitleId,
                    directory: save.directory,
                    gameVersion: version
                )
            )
        }
    }

    func publish(_ save: PortableSave) {
        run(save.id) { api in
            let _: SaveTaskCreated = try await api.request(
                "/portable-saves/\(save.id)/publish",
                method: "POST",
                body: PortablePublication(
                    displayName: save.displayName ?? save.saveTitleId,
                    description: "Shared from " + console.name
                )
            )
        }
    }

    func find(_ game: ProfileGame, _ version: String) {
        guard let api = store.api else {
            return
        }
        busy = game.id
        Task { @MainActor in
            defer {
                busy = ""
            }
            do {
                let value: CommunitySaveCatalog = try await api
                    .request(
                        "/community/saves?consoleId=\(console.id)&gameTitleId=\(game.titleId)&gameVersion=\(version)"
                    )
                community = value.versions.flatMap(\.saves)
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    func downloadCommunity(_ save: CommunitySave) {
        run(save.id) { api in
            let _: SaveTaskCreated = try await api.request(
                "/community/saves/\(save.id)/download",
                method: "POST",
                body: CommunityDownloadRequest(
                    consoleId: console.id,
                    gameTitleId: save.gameTitleId,
                    gameVersion: save.gameVersion
                )
            )
        }
    }

    func importSave(_ save: PortableSave) {
        let slots = (console.saveData ?? [])
            .filter {
                $0.platform == save.platform && $0.gameTitleId == save.gameTitleId && $0
                    .saveTitleId == save
                    .saveTitleId && $0.directory == save.directory
            }
        guard slots.count == 1,
              let slot = slots.first
        else {
            failure = slots.isEmpty ? "Create the matching save slot in the game first." : "Open PS5Library with the receiving console account and try again."
            return
        }
        run(save.id) { api in
            let _: SaveTaskCreated = try await api.request(
                "/portable-saves/\(save.id)/import",
                method: "POST",
                body: SaveImportRequest(consoleId: console.id, localUserId: slot.localUserId)
            )
        }
    }

    func run(_ id: String, _ action: @escaping (API) async throws -> Void) {
        guard busy.isEmpty,
              let api = store
              .api
        else {
            return
        }
        let owner = store.account?.id
        busy = id
        failure = nil
        Task { @MainActor in
            defer {
                busy = ""
            }
            do {
                try await action(api)
                if store.account?.id == owner { await load() }
            } catch {
                if store.account?.id == owner {
                    failure = error.localizedDescription
                }
            }
        }
    }
}
