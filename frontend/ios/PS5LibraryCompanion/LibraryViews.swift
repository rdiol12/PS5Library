import SwiftUI

struct LibraryGameRow: View {
    @EnvironmentObject var store: Store
    @Environment(\.dynamicTypeSize) private var typeSize
    let game: Game
    let scope: String
    let selected: Bool
    private var tileWidth: CGFloat {
        typeSize.isAccessibilitySize ? 220 : 164
    }

    private var release: Release? {
        game.releases.first(where: { $0.kind == "BASE" }) ?? game.releases
            .first(where: { $0.kind != "DLC" }) ?? game.releases.first
    }

    private var entry: LibraryEntry? {
        let ids = Set(game.releases.map(\.id))
        return store.data.library.first {
            ids.contains($0.releaseId) && $0.state == "READY_ON_PS5"
        }
    }

    private var job: Job? {
        let ids = Set(game.releases.map(\.id))
        return store.data.jobs.first {
            ids.contains($0.releaseId) && ![
                "COMPLETED",
                "READY_ON_PS5",
                "CANCELLED"
            ].contains($0.state)
        }
    }

    private var location: String {
        if let job {
            return job.displayStage
        }
        if scope == "console" {
            return store.data.consoles.first(where: { $0.id == store.data.consoleId })?.storage
                .first(where: { $0.id == entry?.storageId })?.displayName ?? "This PS5"
        }
        return game.serverCached ? "Prepared on server" : "Available on server"
    }

    private var state: (String, Color) {
        if let job {
            return (readable(job.state), job.state == "ERROR" ? danger : accent)
        }
        if scope == "console" {
            return ("Ready", success)
        }
        if game.serverCached {
            return ("Prepared", success)
        }
        return ("Available", accent)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ArtworkView(path: game.coverUrl).frame(
                width: tileWidth,
                height: typeSize.isAccessibilitySize ? 150 : 126
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(
                    selected ? accent : .white.opacity(0.08),
                    lineWidth: selected ? 2 : 1
                )
            }
            .shadow(color: .black.opacity(selected ? 0.34 : 0), radius: 12, y: 7)
            Text(game.title).font(.subheadline.weight(.semibold))
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            HStack(spacing: 6) {
                Circle().fill(state.1).frame(width: 6, height: 6)
                Text(location).font(.caption2).foregroundStyle(secondaryText).lineLimit(1)
            }
        }.frame(width: tileWidth, alignment: .leading).padding(.vertical, 4)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "\(game.title), version \(release?.version ?? "unknown"), \(location), \(state.0)"
            )
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct LibraryStage: View {
    @EnvironmentObject var store: Store
    @Environment(\.dynamicTypeSize) private var typeSize
    let game: Game
    let scope: String
    private var release: Release? {
        game.releases.first(where: { $0.kind == "UPDATE" }) ?? game.releases
            .first(where: { $0.kind == "BASE" }) ?? game.releases.first
    }

    private var ready: Bool {
        game.ready(in: store.data.library)
    }

    private var status: String {
        ready ? "Available on this PS5" : game
            .serverCached ? "Ready on your Library Server" : "Available on your Library Server"
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ArtworkView(path:game.heroUrl,contentMode:.fit).frame(
                maxWidth: .infinity,
                minHeight: typeSize.isAccessibilitySize ? 520 : 430
            )
            LinearGradient(
                colors: [.clear, appBackground.opacity(0.72), appBackground],
                startPoint: .top,
                endPoint: .bottom
            )
            LinearGradient(
                colors: [appBackground.opacity(0.88), .clear],
                startPoint: .leading,
                endPoint: .trailing
            )
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 8) {
                    Circle().fill(ready ? success : accent).frame(
                        width: 7,
                        height: 7
                    )
                    Text(status).font(.subheadline.weight(.semibold))
                        .foregroundStyle(ready ? success : accent)
                }
                Text(game.title).font(.largeTitle.bold()).tracking(-0.7)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 3)
                if let description = game.description,
                   !description
                   .isEmpty
                {
                    Text(description).font(.body).foregroundStyle(.white.opacity(0.86))
                        .lineLimit(typeSize.isAccessibilitySize ? 5 : 3)
                }
                HStack(spacing: 10) {
                    if let version = release?.version {
                        Text("Version \(version)")
                    }
                    Text(scope == "console" ? "PS5" : "Library Server")
                }.font(.caption).foregroundStyle(secondaryText)
                NavigationLink(value: game) {
                    Text("Open game").font(.headline).frame(
                        minWidth: 126,
                        minHeight: 48
                    )
                }
                .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
            }.padding(.horizontal, 20).padding(.bottom, 24).frame(
                maxWidth: 560,
                alignment: .leading
            )
        }.clipped().accessibilityElement(children: .contain)
    }
}

struct GameDetails: View {
    @EnvironmentObject var store: Store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let game: Game
    @State private var download = false
    @State private var saving = false
    var saved: Bool {
        store.data.games.first(where: { $0.id == game.id })?.saved ?? false
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ZStack(alignment: .bottomLeading) {
                    ArtworkView(path:game.heroUrl,contentMode:.fit)
                    LinearGradient(
                        colors: [.clear, appBackground.opacity(0.35), appBackground],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    VStack(alignment: .leading, spacing: 9) {
                        if store.ready(game) {
                            StatusPill(
                                text: "Ready on PS5",
                                color: success,
                                icon: "checkmark.circle.fill"
                            )
                        } else if game.serverCached {
                            StatusPill(
                                text: "Cached on server",
                                icon: "shippingbox.fill"
                            )
                        }
                        Text(game.title).font(.largeTitle.bold())
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 3)
                        if let genres = game.genres,!genres.isEmpty {
                            Text(genres.prefix(3).joined(separator: " | "))
                                .font(.subheadline.weight(.semibold)).foregroundStyle(secondaryText)
                        }
                    }.padding(18).padding(.top, dynamicTypeSize.isAccessibilitySize ? 180 : 150)
                }
                .frame(
                    maxWidth: .infinity,
                    minHeight: dynamicTypeSize.isAccessibilitySize ? 460 : 360
                )
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(.white.opacity(0.1))
                }
                VStack(alignment: .leading, spacing: 12) {
                    Button("Download & Prepare", systemImage: "arrow.down.circle.fill") {
                        download = true
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large).frame(
                        maxWidth: .infinity,
                        minHeight: 50
                    )
                    .disabled(game.releases.allSatisfy { $0.sources.isEmpty })
                    Button(
                        saved ? "Remove from Saved Games" : "Save Game",
                        systemImage: saved ? "heart.fill" : "heart"
                    ) {
                        saveGame()
                    }
                    .buttonStyle(.bordered).controlSize(.large).frame(
                        maxWidth: .infinity,
                        minHeight: 50
                    ).disabled(saving || store.offline)
                }
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeading(title: "About")
                    Text(game.description ?? "Description unavailable.").font(.body).lineSpacing(4)
                        .foregroundStyle(.white.opacity(0.94))
                    if let publisher = game.publisher,!publisher.isEmpty {
                        Label(
                            publisher,
                            systemImage: "building.2"
                        ).font(.footnote).foregroundStyle(secondaryText)
                    }
                }.cinematicCard()
                GameMediaView(game: store.data.games.first(where: { $0.id == game.id }) ?? game)
                    .id((store.account?.id ?? "") + game.id)
                    .frame(maxWidth: .infinity, alignment: .leading).cinematicCard()
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeading(title: "Available releases", detail: "\(game.releases.count)")
                    ForEach(game.releases) { release in
                        HStack(spacing: 12) {
                            Image(systemName: release
                                .kind == "DLC" ? "puzzlepiece.extension.fill" : "shippingbox.fill")
                                .foregroundStyle(accent).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(release.label).font(.subheadline.weight(.semibold))
                                    .lineLimit(2)
                                if let firmware = release
                                    .minimumFirmware
                                {
                                    Text("Firmware \(firmware) or newer").font(.caption)
                                        .foregroundStyle(secondaryText)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(bytes(release.size ?? 0)).font(.caption.monospacedDigit())
                                .foregroundStyle(secondaryText)
                        }.padding(14).background(
                            .white.opacity(0.055),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                    }
                }.cinematicCard()
                if let screenshots = game.screenshotUrls,!screenshots.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "Screenshots", detail: "\(screenshots.count)")
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 14) {
                                ForEach(
                                    screenshots,
                                    id: \.self
                                ) { path in
                                    Color.clear.frame(width: 280).aspectRatio(
                                        16 / 9,
                                        contentMode: .fit
                                    ).overlay {
                                        ArtworkView(path: path)
                                    }.clipShape(RoundedRectangle(
                                        cornerRadius: 14,
                                        style: .continuous
                                    ))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .stroke(.white.opacity(0.08))
                                    }
                                }
                            }.scrollClipDisabled()
                        }
                    }
                }
            }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 28)
        }.background(CinematicBackdrop()).navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $download) {
                InstallationView(game: game)
            }
    }
}

extension GameDetails {
    func saveGame() {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        let value = !saved
        saving = true
        Task { @MainActor in
            defer {
                saving = false
            }
            do {
                let _: Acknowledgement = try await api.request(
                    "/games/\(game.id)/save",
                    method: "POST",
                    body: ["saved": value]
                )
                if store.account?.id == owner { await store.refresh() }
            } catch {
                if store.account?.id == owner {
                    store.error = error.localizedDescription
                }
            }
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject var store: Store
    @State private var scope = "server"
    @State private var storageId = ""
    @State private var query = ""
    @State private var savedOnly = false
    @State private var selectedGameId: String?
    var games: [Game] {
        let available = scope == "server" ? GameCollection.server.select(store.data.games) : store
            .data.games.filter { $0.ready(
                in: store.data.library,
                storageId: storageId
            ) }
        return available.filter { game in
            (!savedOnly || game.saved == true) && (query.isEmpty || ([
                game.title,
                game.titleId,
                game.publisher ?? ""
            ] + (game.genres ?? [])).joined(separator: " ").localizedCaseInsensitiveContains(query))
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    private var storageName: String {
        guard !storageId.isEmpty else {
            return "All storage"
        }
        return store.data.consoles.first(where: { $0.id == store.data.consoleId })?.storage
            .first(where: { $0.id == storageId })?.displayName ?? "Storage"
    }

    private var selectedGame: Game? {
        games.first(where: { $0.id == selectedGameId }) ?? games.first
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Location", selection: $scope) {
                        Label("This PS5", systemImage: "gamecontroller.fill").tag("console")
                        Label("Server", systemImage: "server.rack").tag("server")
                    }.pickerStyle(.segmented)
                    if scope == "console",!store.data.consoles.isEmpty {
                        HStack(spacing: 8) {
                            ConsolePicker().pickerStyle(.menu).frame(
                                maxWidth: .infinity,
                                alignment: .leading
                            )
                            Menu {
                                Button("All storage") {
                                    storageId = ""
                                }
                                ForEach(store.data.consoles
                                    .first(where: { $0.id == store.data.consoleId })?
                                    .storage ?? [])
                                { storage in
                                    Button(storage.displayName) {
                                        storageId = storage.id
                                    }
                                }
                            } label: {
                                Label(storageName, systemImage: "externaldrive.fill")
                                    .font(.subheadline.weight(.semibold))
                                    .padding(.horizontal, 12).frame(minHeight: 44).background(
                                        .white.opacity(0.07),
                                        in: Capsule()
                                    )
                            }
                        }
                    }
                    if store
                        .offline
                    {
                        OfflineBanner(text: "Server offline - showing the last synced library")
                    }
                }.padding(.horizontal, 18).padding(.vertical, 12)
                if store.loading && store.data.games.isEmpty {
                    ProgressView("Syncing library...").frame(maxWidth: .infinity, minHeight: 220)
                } else if games.isEmpty {
                    ContentUnavailableView(
                        query
                            .isEmpty ? (savedOnly ? "No saved games here" : "No games here yet") :
                            "No matches",
                        systemImage: savedOnly ? "heart" : "rectangle.stack",
                        description: Text(query
                            .isEmpty ?
                            (scope == "console" ?
                                "Sync this console's inventory, or switch to Server to see available games." :
                                "Add authorized content to your Library Server to see it here.") :
                            "Try another title, publisher, or genre.")
                    )
                    .frame(maxWidth: .infinity, minHeight: 300).padding(.horizontal, 18)
                } else if let selectedGame {
                    LibraryStage(game: selectedGame, scope: scope)
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(scope == "console" ? "On this PS5" : "On this server")
                                    .font(.title2.bold())
                                Text(scope == "console" ?
                                    "Installed games reported by your console" :
                                    "Authorized content available from your Library Server")
                                    .font(.caption).foregroundStyle(secondaryText)
                            }
                            Spacer()
                            Text("\(games.count) \(games.count == 1 ? "game" : "games")")
                                .font(.caption.weight(.semibold)).foregroundStyle(secondaryText)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(alignment: .top, spacing: 14) {
                                ForEach(games) { game in
                                    Button {
                                        withAnimation(.easeOut(duration: 0.18)) {
                                            selectedGameId = game.id
                                        }
                                    } label: {
                                        LibraryGameRow(
                                            game: game,
                                            scope: scope,
                                            selected: game.id == selectedGame.id
                                        )
                                    }
                                    .buttonStyle(PressableCardStyle())
                                }
                            }.scrollTargetLayout()
                        }.scrollTargetBehavior(.viewAligned).contentMargins(
                            .horizontal,
                            1,
                            for: .scrollContent
                        )
                    }
                    .padding(.horizontal, 18).padding(.top, 24).padding(.bottom, 30)
                }
            }
        }
        .background(CinematicBackdrop()).navigationTitle("Library")
        .searchable(text: $query, prompt: "Search games")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    savedOnly.toggle()
                } label: {
                    Image(systemName: savedOnly ? "heart.fill" : "heart")
                }
                .foregroundStyle(savedOnly ? accent : Color.primary)
                .accessibilityLabel(savedOnly ? "Show all games" : "Show saved games only")
                .accessibilityAddTraits(savedOnly ? .isSelected : [])
            }
        }
        .navigationDestination(for: Game.self) {
            GameDetails(game: $0)
        }
        .onChange(of: store.data.consoleId) { _, _ in
            storageId = ""
            selectedGameId = nil
        }
        .onChange(of: scope) { _, _ in
            storageId = ""
            selectedGameId = nil
        }
        .onChange(of: games.map(\.id)) { _, ids in
            if !ids.contains(selectedGameId ?? "") {
                selectedGameId = ids.first
            }
        }
        .refreshable { await store.refresh() }
    }
}
