import SwiftUI
import AVKit

struct GameMediaView: View {
    @EnvironmentObject var store: Store
    let game: Game
    @State private var selection: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeading(title: "Media")
            if game
                .trailer !=
                nil
            {
                Button("Watch trailer", systemImage: "play.rectangle.fill") {
                    selection = "trailers"
                }.buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(store.offline)
            } else if let state = game
                .trailerState
            {
                Text("Trailer: " + readable(state)).font(.caption).foregroundStyle(.secondary)
            }
            if game
                .music !=
                nil
            {
                Button("Play game music", systemImage: "music.note") {
                    selection = "music"
                }
                .buttonStyle(.bordered).controlSize(.large).disabled(store.offline)
            } else if let state = game
                .musicState
            {
                Text("Music: " + readable(state)).font(.caption).foregroundStyle(.secondary)
            }
            if game.trailer == nil && game.music == nil && game.trailerState == nil && game
                .musicState ==
                nil
            {
                Text("No media is available for this title.").font(.footnote)
                    .foregroundStyle(secondaryText)
            }
        }
        .sheet(isPresented: Binding(
            get: { selection != nil },
            set: {
                if !$0 {
                    selection = nil
                }
            }
        )) {
            if let kind = selection, let asset = kind == "music" ? game.music : game.trailer {
                MediaPlaybackView(asset: asset, kind: kind, title: game.title)
            }
        }
    }
}

struct MediaPlaybackView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) var scenePhase
    let asset: MediaAsset
    let kind: String
    let title: String
    @State private var player: AVPlayer?
    @State private var observation: NSKeyValueObservation?
    @State private var file: URL?
    @State private var failure: String?
    @State private var attempt = 0
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let player = player {
                    VideoPlayer(player: player).frame(minHeight: 240)
                    if kind ==
                        "music"
                    {
                        Label("Game music", systemImage: "music.note").font(.headline)
                    }
                    HStack {
                        Button("Play", systemImage: "play.fill") {
                            player.play()
                        }
                        Button("Pause", systemImage: "pause.fill") {
                            player.pause()
                        }
                    }
                } else if let failure = failure {
                    Text(failure).foregroundStyle(warning)
                    Button("Retry") { attempt += 1 }
                } else {
                    ProgressView("Downloading and verifying media...")
                    Text(bytes(asset.size)).font(.caption).foregroundStyle(.secondary)
                }
            }.padding().frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(CinematicBackdrop()).navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") {
                            dismiss()
                        }
                    }
                }
        }
        .task(id: attempt) { await load() }
        .onDisappear {
            cleanup()
        }
        .onChange(of: store.account?.id) { _, _ in
            cleanup()
            dismiss()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                player?.pause()
            }
        }
        .onReceive(NotificationCenter.default
            .publisher(for: .AVPlayerItemFailedToPlayToEndTime))
        { notification in
            guard let item = notification.object as? AVPlayerItem,
                  item === player?.currentItem
            else {
                return
            }
            cleanup()
            failure = "Playback failed. Try again."
        }
    }

    func load() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        cleanup()
        failure = nil
        var downloaded: URL?
        do {
            let local = try await api.media(asset, kind: kind)
            downloaded = local
            try Task.checkCancellation()
            guard store.account?.id == owner else {
                try? FileManager.default.removeItem(at: local)
                return
            }
            let item = AVPlayerItem(url: local)
            guard try await item.asset.load(.isPlayable)
            else {
                throw StoreError.message("This media cannot be played on your device.")
            }
            try Task.checkCancellation()
            guard store.account?.id == owner else {
                try? FileManager.default.removeItem(at: local)
                return
            }
            file = local
            player = AVPlayer(playerItem: item)
            observation = item.observe(\.status, options: [.initial, .new]) { item, _ in
                Task { @MainActor in
                    if item === player?.currentItem, item.status == .failed {
                        cleanup()
                        failure = "Playback failed. Try again."
                    }
                }
            }
            if scenePhase == .active {
                player?.play()
            }
        } catch {
            if let downloaded = downloaded {
                try? FileManager.default.removeItem(at: downloaded)
            }
            if !Task.isCancelled,
               store.account?.id == owner
            {
                failure = error.localizedDescription
            }
        }
    }

    func cleanup() {
        observation?.invalidate()
        observation = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        if let file = file {
            try? FileManager.default.removeItem(at: file)
        }
        file = nil
    }
}
