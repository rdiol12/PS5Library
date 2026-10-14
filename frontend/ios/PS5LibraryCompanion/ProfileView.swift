import SwiftUI

private struct TrophyTile: View {
    let name: String
    let count: Int
    let color: Color
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "trophy.fill").foregroundStyle(color)
            Text(String(count)).font(.title3.bold().monospacedDigit())
            Text(name).font(.caption2).foregroundStyle(secondaryText)
        }.frame(maxWidth: .infinity, minHeight: 76).background(
            .white.opacity(0.05),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityElement(children: .ignore).accessibilityLabel("\(count) \(name) trophies")
    }
}

struct ProfileView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var profile: Profile?
    @State private var failure: String?
    @State private var busy = false
    private let trophyColumns = [GridItem(.adaptive(minimum: 64), spacing: 8)]
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let profile {
                    let selected = selectedConsole(in: profile)
                    let hero = selected?.games
                        .compactMap { profileGame in
                            store.data.games.first(where: { $0.id == profileGame.gameId })?.heroUrl
                        }
                        .first
                    ZStack(alignment: .bottomLeading) {
                        if let hero {
                            ArtworkView(path: hero).opacity(0.42)
                        }
                        LinearGradient(
                            colors: [.clear, appBackground.opacity(0.76), appBackground],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        HStack(spacing: 18) {
                            Group {
                                if let path = profile.avatarUrl {
                                    ArtworkView(path: path)
                                } else {
                                    Image(systemName: "person.fill").font(.title)
                                        .foregroundStyle(accent)
                                }
                            }.frame(width: 84, height: 84).background(raisedSurface)
                                .clipShape(Circle()).overlay {
                                    Circle().stroke(
                                        .white.opacity(0.86),
                                        lineWidth: 2
                                    )
                                }
                            VStack(alignment: .leading, spacing: 6) {
                                Text(profile.username).font(.largeTitle.bold()).tracking(-0.6)
                                if let console = selected,
                                   let live = store.data.consoles
                                   .first(where: { $0.id == console.id })
                                {
                                    HStack(spacing: 8) {
                                        Circle()
                                            .fill(live.presence == "ONLINE" ? success : Color
                                                .secondary)
                                            .frame(
                                                width: 7,
                                                height: 7
                                            )
                                        Text(console.name + " · " + readable(live.presence))
                                            .font(.subheadline).foregroundStyle(secondaryText)
                                    }
                                } else {
                                    Text(readable(profile.role)).font(.subheadline)
                                        .foregroundStyle(secondaryText)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 20).padding(.bottom, 24)
                    }.frame(maxWidth: .infinity, minHeight: 220).clipped()
                    HStack(spacing: 10) {
                        Menu("Edit profile", systemImage: "camera.fill") {
                            Button("Use default", role: .destructive) {
                                changeAvatar(nil)
                            }
                            ForEach(store.data.games) { game in
                                Button(game.title) {
                                    changeAvatar(game.coverUrl)
                                }
                            }
                        }.buttonStyle(.bordered).controlSize(.large).disabled(busy || store.offline)
                        NavigationLink {
                            CommunityFriendsView()
                        } label: {
                            Label(
                                "Friends",
                                systemImage: "person.2.fill"
                            ).frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                    }.padding(.horizontal, 20).padding(.bottom, 22)
                    if profile.consoles.count > 1 {
                        Picker("Console", selection: $store.data.consoleId) {
                            ForEach(profile.consoles) {
                                Text($0.name).tag($0.id)
                            }
                        }
                        .pickerStyle(.menu).controlSize(.large).padding(.horizontal, 20)
                        .padding(
                            .bottom,
                            12
                        )
                    }
                    if selected == nil {
                        ContentUnavailableView(
                            "No consoles on this profile",
                            systemImage: "gamecontroller",
                            description: Text("Pair a PS5 to see its games, trophies, and saves.")
                        )
                        .frame(maxWidth: .infinity, minHeight: 260).padding(.horizontal, 20)
                    }
                    if let console = selected {
                        let live = store.data.consoles.first(where: { $0.id == console.id })
                        VStack(alignment: .leading, spacing: 20) {
                            HStack {
                                Image(systemName: "gamecontroller.fill").foregroundStyle(accent)
                                Text(console.name).font(.title2.bold())
                                Spacer()
                                StatusPill(
                                    text: readable(live?.presence ?? "OFFLINE"),
                                    color: live?.presence == "ONLINE" ? success : secondaryText
                                )
                            }
                            LazyVGrid(
                                columns: [GridItem(.flexible()), GridItem(.flexible())],
                                spacing: 0
                            ) {
                                profileFact(
                                    "Status",
                                    live?
                                        .presence == "ONLINE" ? "Connected" :
                                        readable(live?.presence ?? "OFFLINE")
                                )
                                profileFact("Firmware", live?.firmware ?? "Not reported")
                                profileFact(
                                    "Library",
                                    "\(live?.games ?? console.games.filter(\.available).count) games"
                                )
                                profileFact("Runtime", live?.runtime ?? "Not reported")
                            }.overlay {
                                Rectangle().stroke(.white.opacity(0.1), lineWidth: 1)
                            }
                            if let storage = live?.storage,!storage.isEmpty {
                                SectionHeading(title: "Storage")
                                ForEach(storage) { volume in
                                    VStack(alignment: .leading, spacing: 9) {
                                        HStack {
                                            Text(volume.displayName).font(.headline)
                                            Spacer()
                                            Text(bytes(volume.freeBytes) + " free")
                                                .font(.caption.monospacedDigit())
                                                .foregroundStyle(secondaryText)
                                        }
                                        ProgressView(value: volume.totalBytes > 0 ? min(
                                            1,
                                            max(
                                                0,
                                                1 - Double(volume.freeBytes) /
                                                    Double(volume.totalBytes)
                                            )
                                        ) : 0).tint(accent)
                                            .accessibilityLabel(
                                                "\(volume.displayName) storage used"
                                            )
                                            .accessibilityValue(
                                                "\(bytes(max(0, volume.totalBytes - volume.freeBytes))) used, \(bytes(volume.freeBytes)) free"
                                            )
                                    }.padding(16).background(
                                        raisedSurface.opacity(0.76),
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    )
                                }
                            }
                            if let summary = console.trophySummary {
                                SectionHeading(title: "Trophies")
                                LazyVGrid(columns: trophyColumns, spacing: 8) {
                                    TrophyTile(
                                        name: "Platinum",
                                        count: summary.earnedTrophies.platinum,
                                        color: accent
                                    )
                                    TrophyTile(
                                        name: "Gold",
                                        count: summary.earnedTrophies.gold,
                                        color: Color(red: 1, green: 0.78, blue: 0.3)
                                    )
                                    TrophyTile(
                                        name: "Silver",
                                        count: summary.earnedTrophies.silver,
                                        color: Color(red: 0.76, green: 0.82, blue: 0.9)
                                    )
                                    TrophyTile(
                                        name: "Bronze",
                                        count: summary.earnedTrophies.bronze,
                                        color: Color(red: 0.82, green: 0.48, blue: 0.27)
                                    )
                                }
                                Text(
                                    "Local summary from \(Date(timeIntervalSince1970: summary.modifiedAt).formatted(date: .abbreviated, time: .shortened))"
                                )
                                .font(.caption).foregroundStyle(secondaryText)
                            } else {
                                Label("Trophy summary unavailable", systemImage: "trophy")
                                    .font(.footnote).foregroundStyle(secondaryText)
                            }
                            NavigationLink {
                                SaveBackupsView(console: console)
                            } label: {
                                Label(
                                    "Save backups",
                                    systemImage: "externaldrive.badge.timemachine"
                                ).font(.headline)
                                    .frame(
                                        maxWidth: .infinity,
                                        minHeight: 46
                                    )
                            }.buttonStyle(.bordered)
                            if !console.games.isEmpty {
                                SectionHeading(
                                    title: "Games",
                                    detail: "\(console.games.filter(\.available).count) available"
                                )
                                ScrollView(.horizontal, showsIndicators: false) {
                                    LazyHStack(alignment: .top, spacing: 12) {
                                        ForEach(console.games) { game in
                                            Group {
                                                if let catalog = store.data.games
                                                    .first(where: { $0.id == game.gameId })
                                                {
                                                    NavigationLink {
                                                        GameDetails(game: catalog)
                                                    } label: {
                                                        profileGameTile(game)
                                                    }
                                                } else {
                                                    profileGameTile(game)
                                                }
                                            }.buttonStyle(PressableCardStyle())
                                        }
                                    }
                                }.scrollTargetBehavior(.viewAligned)
                            }
                        }.padding(.horizontal, 20).padding(.vertical, 26)
                            .overlay(alignment: .bottom) {
                                Divider().overlay(.white.opacity(0.1))
                            }
                    }
                } else if failure == nil {
                    ProgressView("Loading profile...").frame(maxWidth: .infinity, minHeight: 300)
                }
                if let failure {
                    VStack(spacing: 12) {
                        Label(
                            failure,
                            systemImage: "exclamationmark.triangle.fill"
                        ).foregroundStyle(warning)
                        Button("Retry") {
                            Task { await load() }
                        }.buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity).cinematicCard()
                }
            }.padding(.bottom, 24)
        }.background(CinematicBackdrop()).navigationTitle("My Profile").task { await load() }
            .refreshable { await load() }
    }

    private func selectedConsole(in profile: Profile) -> ProfileConsole? {
        profile.consoles.first(where: { $0.id == store.data.consoleId }) ?? profile.consoles.first
    }

    private func profileFact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.caption).foregroundStyle(secondaryText)
            Text(value).font(.subheadline.weight(.semibold)).lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading).padding(.horizontal, 14)
        .overlay(alignment: .trailing) {
            Divider().overlay(.white.opacity(0.08))
        }
        .overlay(alignment: .bottom) {
            Divider().overlay(.white.opacity(0.08))
        }
    }

    private func profileGameTile(_ game: ProfileGame) -> some View {
        let width: CGFloat = typeSize.isAccessibilitySize ? 210 : 148
        return VStack(alignment: .leading, spacing: 7) {
            ArtworkView(path: game.coverUrl).frame(
                width: width,
                height: typeSize.isAccessibilitySize ? 132 : 96
            ).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text(game.title).font(.caption.weight(.semibold))
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            Text(game.available ? "Available" : "Missing").font(.caption2)
                .foregroundStyle(game.available ? success : secondaryText)
        }.frame(
            width: width,
            alignment: .leading
        )
    }

    func load() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        do {
            let result: Profile = try await api.request("/profile")
            guard !Task.isCancelled, store.account?.id == owner else {
                return
            }
            profile = result
            if !result.consoles
                .contains(where: { $0.id == store.data.consoleId })
            {
                store.data.consoleId = result.consoles.first?.id ?? ""
            }
            failure = nil
        } catch {
            if !Task.isCancelled,
               store.account?.id == owner
            {
                failure = error.localizedDescription
            }
        }
    }

    func changeAvatar(_ path: String?) {
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
                if let path = path {
                    let data = try await api.artwork(path)
                    guard data.count <= 4 * 1024 * 1024
                    else {
                        throw StoreError.message("This image is too large for a profile picture.")
                    }
                    let _: Acknowledgement = try await api.request(
                        "/profile/avatar",
                        method: "POST",
                        json: ["data": data.base64EncodedString()]
                    )
                } else {
                    let _: Acknowledgement = try await api.request(
                        "/profile/avatar",
                        method: "DELETE"
                    )
                }
                if store.account?.id == owner { await load() }
            } catch {
                if store.account?.id == owner {
                    failure = error.localizedDescription
                }
            }
        }
    }
}
