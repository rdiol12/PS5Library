import SwiftUI

struct ConsolesView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if store
                    .offline
                {
                    OfflineBanner(text: "Server offline - console status may be out of date")
                }
                PairingView()
                SectionHeading(title: "Your consoles", detail: "\(store.data.consoles.count)")
                if store.data.consoles.isEmpty {
                    ContentUnavailableView(
                        "No PS5 connected",
                        systemImage: "gamecontroller",
                        description: Text(
                            "Open PS5Library on your console and pair it with the code or QR scanner above."
                        )
                    )
                    .frame(maxWidth: .infinity, minHeight: 260).cinematicCard()
                }
                ForEach(store.data.consoles) { console in
                    ConsoleCard(console: console)
                }
            }.padding(.horizontal, 18).padding(.vertical, 14)
        }.background(CinematicBackdrop()).id(store.account?.id)
            .refreshable { await store.refresh() }
    }
}

struct PairingView: View {
    @EnvironmentObject var store: Store
    @State private var code = ""
    @State private var consoleId = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var scanning = false
    @State private var scannedPair: PairingQR?
    var scannedFrontend: Bool? {
        pairingCode(code) == scannedPair?.code ? scannedPair?.frontend : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "link.circle.fill").font(.title2).foregroundStyle(accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect a PS5").font(.headline)
                    Text("Use the code shown by PS5Library").font(.caption)
                        .foregroundStyle(secondaryText)
                }
            }
            TextField("5-character pairing code", text: $code)
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .font(.body.monospaced()).padding(.horizontal, 14).frame(minHeight: 48).background(
                    .white.opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 12)
                )
                .accessibilityHint("Enter the pairing code displayed on your PS5")
            Button("Scan pairing QR code", systemImage: "qrcode.viewfinder") {
                scanning = true
            }
            .buttonStyle(.bordered).disabled(store.offline)
            Picker("Connect to", selection: $consoleId) {
                Text("Register a new PS5").tag("")
                ForEach(store.data.consoles) {
                    Text($0.name).tag($0.id)
                }
            }
            Text(
                "Choose an existing PS5 for a storefront code. An agent code registers a new console."
            )
            .font(.caption).foregroundStyle(secondaryText)
            Button(busy ? "Linking..." : "Link to my account", systemImage: "link") {
                claim()
            }
            .buttonStyle(.borderedProminent).controlSize(.large).frame(
                maxWidth: .infinity,
                minHeight: 48
            )
            .disabled(busy || pairingCode(code) == nil || store
                .offline || (scannedFrontend == true && consoleId.isEmpty))
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill").font(.footnote)
                    .foregroundStyle(warning)
            }
        }.cinematicCard().disabled(busy)
            .sheet(isPresented: $scanning) {
                PairingScannerSheet { payload in
                    scanning = false
                    guard let server = store.account?.server, let result = PairingQR(
                        payload,
                        server: server
                    ) else {
                        failure = "This is not a pairing QR code for the selected server. You can enter the displayed code manually."
                        return
                    }
                    code = result.code
                    scannedPair = result
                    if result.frontend {
                        if !store.data.consoles
                            .contains(where: { $0.id == consoleId })
                        {
                            consoleId = store.data.consoleId
                        }
                        failure = "Storefront code scanned. Choose your PS5, then tap Link to my account."
                    } else {
                        consoleId = ""
                        failure = nil
                    }
                }
            }
    }

    func claim() {
        guard !busy, scannedFrontend != true || !consoleId.isEmpty,
              let codeValue = pairingCode(code), let api = store.api
        else {
            return
        }
        let owner = store.account?.id
        var body = ["code": codeValue]
        if !consoleId.isEmpty { body["consoleId"] = consoleId }
        busy = true
        failure = nil
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                let result: Acknowledgement = try await api.request(
                    "/pairings/claim",
                    method: "POST",
                    json: body
                )
                guard store.account?.id == owner else {
                    return
                }
                code = ""
                if let id = result.consoleId {
                    store.data.consoleId = id
                }
                await store.refresh()
            } catch {
                if store.account?.id == owner {
                    failure = error.localizedDescription
                }
            }
        }
    }
}

struct ConsoleCard: View {
    @EnvironmentObject var store: Store
    let console: Console
    @State private var name = ""
    @State private var message = ""
    @State private var editing = false
    @State private var revoking = false
    @State private var busy = false
    @State private var remotePlay = false
    private var online: Bool {
        console.presence == "ONLINE"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "gamecontroller.fill").font(.title2).foregroundStyle(.white)
                    .frame(
                        width: 46,
                        height: 46
                    ).background(accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(console.name).font(.title3.bold())
                        Circle().fill(online ? success : Color.secondary).frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                    }
                    Text(readable(console.presence)).font(.caption.weight(.semibold))
                        .foregroundStyle(online ? success : secondaryText)
                }
                Spacer()
                if console
                    .isDefault
                {
                    StatusPill(text: "Default", color: accent, icon: "star.fill")
                }
            }
            HStack(spacing: 8) {
                StatusPill(text: "FW " + (console.firmware ?? "Unknown"), color: secondaryText)
                StatusPill(text: "\(console.games) games", color: secondaryText)
            }
            if console.storage.isEmpty {
                Label(
                    "Storage information unavailable",
                    systemImage: "externaldrive.badge.questionmark"
                ).font(.footnote).foregroundStyle(secondaryText)
            }
            ForEach(console.storage) { storage in
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(storage.displayName).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(bytes(storage.freeBytes) + " free").font(.caption.monospacedDigit())
                            .foregroundStyle(secondaryText)
                    }
                    ProgressView(value: storage.totalBytes > 0 ? min(
                        1,
                        max(0, 1 - Double(storage.freeBytes) / Double(storage.totalBytes))
                    ) : 0).tint(accent)
                        .accessibilityLabel("\(storage.displayName) storage used")
                        .accessibilityValue(
                            "\(bytes(max(0, storage.totalBytes - storage.freeBytes))) used, \(bytes(storage.freeBytes)) free"
                        )
                }.padding(12).background(
                    .white.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            }
            if console.capabilities?.remotePlayPairing == true {
                Button("Pair a Remote Play client", systemImage: "play.rectangle.on.rectangle") {
                    remotePlay = true
                }
                .buttonStyle(.borderedProminent).disabled(!online)
            }
            Menu("Manage console", systemImage: "ellipsis.circle") {
                Button("Rename", systemImage: "pencil") {
                    name = console.name
                    editing = true
                }
                if !console
                    .isDefault
                {
                    Button("Make default PS5", systemImage: "star") {
                        update(ConsoleUpdate(isDefault: true))
                    }
                }
                Button("Refresh firmware", systemImage: "arrow.clockwise") {
                    refreshFirmware()
                }
                Button("Revoke console access", systemImage: "lock.slash", role: .destructive) {
                    revoking = true
                }
            }.frame(minHeight: 44)
            if busy {
                ProgressView()
            }
            if !message
                .isEmpty
            {
                Text(message).font(.caption).foregroundStyle(secondaryText)
                    .accessibilityLabel(message)
            }
        }.cinematicCard().disabled(busy || store.offline)
            .alert("Console name", isPresented: $editing) {
                TextField("Name", text: $name)
                Button("Save") {
                    if let valid = consoleName(name) {
                        update(ConsoleUpdate(name: valid))
                    }
                }
                .disabled(consoleName(name) == nil)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Use 1 to 80 characters.")
            }
            .confirmationDialog(
                "Revoke access for \(console.name)?",
                isPresented: $revoking,
                titleVisibility: .visible
            ) {
                Button("Revoke access", role: .destructive) {
                    revoke()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "This disconnects this console's agent and storefront. Games remain on the console. Reconnecting requires resetting its device identity and pairing again."
                )
            }
            .sheet(isPresented: $remotePlay) {
                NavigationStack {
                    RemotePlayPairingView(console: console)
                }
            }
    }

    func update(_ body: ConsoleUpdate) {
        run { api in
            let _: Acknowledgement = try await api.request(
                "/consoles/\(console.id)",
                method: "PATCH",
                body: body
            )
            return body.isDefault == true ? "Default PS5 updated." : "Console renamed."
        }
    }

    func refreshFirmware() {
        run { api in
            let _: FirmwareRefresh = try await api.request(
                "/consoles/\(console.id)/refresh",
                method: "POST"
            )
            return "Firmware check requested. The value updates when your PS5 reports back."
        }
    }

    func revoke() {
        run { api in
            let _: Acknowledgement = try await api.request(
                "/consoles/\(console.id)/revoke",
                method: "POST"
            )
            return "Console access revoked. Presence may take a moment to update."
        }
    }

    func run(_ action: @escaping (API) async throws -> String) {
        guard !busy, let api = store.api else {
            return
        }
        let owner = store.account?.id
        busy = true
        message = ""
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                let result = try await action(api)
                guard store.account?.id == owner else {
                    return
                }
                message = result
                await store.refresh()
            } catch {
                if store.account?.id == owner {
                    message = error.localizedDescription
                }
            }
        }
    }
}

struct RemotePlayPairingView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let console: Console
    @State private var pairing: RemotePlayPairing?
    @State private var failure: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(console.name).font(.title.bold())
                if let pairing {
                    switch pairing.state {
                    case "REQUESTED": ProgressView("Asking the PS5 for a native Remote Play PIN…")
                    case "READY":
                        Text("REMOTE PLAY PIN").font(.caption.bold()).foregroundStyle(accent)
                        Text(pairing.pin ?? "")
                            .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                            .textSelection(.enabled)
                        Button("Copy PIN", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = pairing.pin
                        }.buttonStyle(.borderedProminent)
                        Text("ACCOUNT ID").font(.caption.bold()).foregroundStyle(.secondary)
                        Text(pairing.accountId ?? "").font(.body.monospaced())
                            .textSelection(.enabled)
                        Button("Copy account ID", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = pairing.accountId
                        }.buttonStyle(.bordered)
                        Text(
                            "On a PC connected to the same private network, open chiaki-ng, add this PS5, " +
                        "and enter the account ID and PIN. Remote Play must already be enabled under " +
                        "PS5 Settings > System > Remote Play. The PIN expires after five minutes."
                        )
                        .foregroundStyle(.secondary)
                    case "PAIRED": Label(
                            "Remote Play client paired",
                            systemImage: "checkmark.circle.fill"
                        ).foregroundStyle(success)
                    default: Label(
                            readable(pairing.error ?? pairing.state),
                            systemImage: "exclamationmark.triangle.fill"
                        ).foregroundStyle(warning)
                    }
                } else if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(warning)
                } else {
                    ProgressView("Starting native Remote Play pairing…")
                }
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(CinematicBackdrop()).navigationTitle("Remote Play")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") {
                    dismiss()
                }
            }
        }
        .task { await pair() }
    }

    func pair() async {
        guard let api = store.api else {
            return
        }
        let owner = store.account?.id
        do {
            var value: RemotePlayPairing = try await api.request(
                "/consoles/\(console.id)/remote-play/pairing",
                method: "POST"
            )
            guard store.account?.id == owner else {
                return
            }
            pairing = value
            while store.account?.id == owner && ["REQUESTED", "READY"].contains(value.state) {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                value = try await api
                    .request("/consoles/\(console.id)/remote-play/pairing/\(value.id)")
                if store.account?.id == owner {
                    pairing = value
                }
            }
        } catch is CancellationError {} catch {
            if store.account?.id == owner {
                failure = error.localizedDescription
            }
        }
    }
}
