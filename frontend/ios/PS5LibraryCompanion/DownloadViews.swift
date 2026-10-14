import SwiftUI

struct ConsolePicker: View { @EnvironmentObject var store: Store
    var body: some View {
        Picker("Target PS5", selection: $store.data.consoleId) {
            ForEach(store.data.consoles) {
                Text($0.name + " · " + readable($0.presence)).tag($0.id)
            }
        }
        .onChange(of: store.data.consoleId) { _, _ in
            Task { await store.refresh() }
        }
    }
}

struct InstallationView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) var dismiss
    let game: Game
    @State private var releaseId = ""
    @State private var sourceId = ""
    @State private var consoleId = ""
    @State private var storageId = ""
    @State private var method = ""
    @State private var review: ReviewedInstallation?
    @State private var busy = false
    @State private var planning = false
    @State private var failure: String?
    var release: Release? {
        game.releases.first { $0.id == releaseId }
    }

    var source: SourceRelease? {
        release?.sources.first { $0.id == sourceId } ?? release?.sources.first
    }

    var selection: InstallationSelection {
        InstallationSelection(
            sourceReleaseId: source?.id ?? "",
            consoleId: consoleId,
            method: method.isEmpty ? nil : method
        )
    }

    var currentPlan: Plan? {
        review?.selection == selection ? review?.plan : nil
    }

    var submission: InstallationRequest? {
        review?.submission(for: selection, storageId: storageId)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        ArtworkView(path: game.coverUrl).frame(width: 75, height: 100)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        Text(game.title).font(.headline)
                    }
                }
                Section("Release and source") {
                    Picker("Release", selection: $releaseId) {
                        ForEach(game.releases) {
                            Text($0.label).tag($0.id)
                        }
                    }
                    if let release = release,!release.sources.isEmpty {
                        Picker(
                            "Source",
                            selection: Binding(get: {
                                source?.id ?? ""
                            }, set: {
                                sourceId = $0
                                method = ""
                            })
                        ) {
                            ForEach(release.sources) {
                                Text($0.name + " / " + $0.format.uppercased()).tag($0.id)
                            }
                        }
                    } else {
                        Text("This release has no downloadable source.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Your PS5") {
                    if store.data.consoles
                        .isEmpty
                    {
                        Text("Pair a console in My PS5 before requesting an installation.")
                    } else {
                        Picker("Console", selection: $consoleId) {
                            ForEach(store.data.consoles) {
                                Text($0.name + " / " + readable($0.presence)).tag($0.id)
                            }
                        }
                    }
                }
                if let plan = currentPlan {
                    Section("Installation method") {
                        Picker("Method", selection: $method) {
                            Text("Automatic").tag("")
                            ForEach(plan.methods, id: \.self) {
                                Text($0 == "SHADOWMOUNT" ? "ShadowMountPlus" : readable($0))
                                    .tag($0)
                            }
                        }
                    }
                    Section("Storage") {
                        Picker("Destination", selection: $storageId) {
                            Text("Choose storage").tag("")
                            ForEach(plan.storage.filter { $0.allowed }) {
                                Text($0.displayName + " / " + bytes($0.freeBytes) + " free")
                                    .tag($0.id)
                            }
                        }
                        if plan.storage
                            .allSatisfy({ !$0.allowed })
                        {
                            Text("No supported destination has enough free space.")
                                .foregroundStyle(warning)
                        }
                    }
                    Section("Confirm") {
                        Label(
                            readable(plan.compatibility.status),
                            systemImage: plan.allowed ? "checkmark.shield" : "exclamationmark.triangle"
                        )
                        .foregroundStyle(plan.allowed ? accent : .orange)
                        Text(plan.message ?? readable(plan.reason)).font(.footnote)
                        if let storage = plan.storage
                            .first(where: { $0.id == storageId })
                        {
                            Text((plan
                                    .estimated ? "Estimated space required: " :
                                    "Space required: ") +
                                bytes(storage.requiredBytes))
                        }
                        if plan
                            .online ==
                            false
                        {
                            Text("Preparation can start now. Delivery will wait for your PS5.")
                        }
                        Button("Download & Prepare") {
                            confirm()
                        }
                        .disabled(submission == nil || planning || busy || store.offline)
                    }
                } else if planning {
                    ProgressView("Checking compatibility and storage...")
                }
                if let failure = failure {
                    Text(failure).foregroundStyle(warning)
                    Button("Check again") {
                        Task { await loadPlan() }
                    }.disabled(planning)
                }
                if store.offline {
                    Label(
                        "Connect to the server to prepare a download.",
                        systemImage: "wifi.slash"
                    ).foregroundStyle(warning)
                }
                if busy {
                    ProgressView("Submitting installation...")
                }
            }.disabled(busy).cinematicList().navigationTitle("Download")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }.disabled(busy)
                    }
                }
                .interactiveDismissDisabled(busy)
        }
        .onAppear {
            if releaseId
                .isEmpty
            {
                releaseId = game.releases.first(where: { !$0.sources.isEmpty })?.id ?? game.releases
                    .first?.id ?? ""
            }
            if consoleId.isEmpty {
                consoleId = store.data.consoleId
            }
        }
        .onChange(of: releaseId) { _, _ in
            sourceId = ""
            method = ""
        }
        .onChange(of: consoleId) { _, _ in
            method = ""
        }
        .onChange(of: store.account?.id) { _, _ in
            dismiss()
        }
        .task(id: selection) { await loadPlan() }
    }

    func loadPlan() async {
        let selected = selection
        let owner = store.account?.id
        review = nil
        storageId = ""
        failure = nil
        guard !selected.sourceReleaseId.isEmpty,!selected.consoleId.isEmpty,
              let api = store.api
        else {
            planning = false
            return
        }
        planning = true
        defer {
            if selection == selected {
                planning = false
            }
        }
        do {
            let result: Plan = try await api.request(
                "/installations/plan",
                method: "POST",
                body: selected
            )
            guard !Task.isCancelled, store.account?.id == owner,
                  selection == selected
            else {
                return
            }
            review = ReviewedInstallation(selection: selected, plan: result)
            storageId = result.storage.first(where: { $0.allowed })?.id ?? ""
        } catch {
            if !Task.isCancelled, store.account?.id == owner,
               selection == selected
            {
                failure = error.localizedDescription
            }
        }
    }

    func confirm() {
        guard !busy,!planning,!store.offline, let request = submission,
              let api = store.api
        else {
            return
        }
        let owner = store.account?.id
        busy = true
        failure = nil
        Task { @MainActor in
            defer {
                busy = false
            }
            do {
                let _: Acknowledgement = try await api.request(
                    "/installations",
                    method: "POST",
                    body: request
                )
                guard store.account?.id == owner else {
                    return
                }
                await store.refresh()
                dismiss()
            } catch {
                if store.account?.id == owner {
                    review = nil
                    failure = error.localizedDescription
                }
            }
        }
    }
}

struct DownloadsView: View {
    @EnvironmentObject var store: Store
    private var activeJobs: [Job] {
        store.data.jobs.filter { ![
            "COMPLETED",
            "READY_ON_PS5",
            "ERROR",
            "CANCELLED"
        ].contains($0.state) }
    }

    private var activeSpeed: Int64 {
        activeJobs.reduce(0) { $0 + $1.speedBytesPerSecond }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if store
                    .offline
                {
                    OfflineBanner(text: "Server offline - progress is from the last sync")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Preparation and transfer continue safely on your server.")
                        .font(.subheadline).foregroundStyle(secondaryText)
                    if !activeJobs.isEmpty {
                        HStack(alignment: .firstTextBaseline) {
                            Text(activeSpeed > 0 ? bytes(activeSpeed) + "/s" : "Working")
                                .font(.title2.bold().monospacedDigit())
                            Spacer()
                            Text("\(activeJobs.count) active").font(.caption.weight(.semibold))
                                .foregroundStyle(secondaryText)
                        }.padding(.top, 12)
                    }
                }.padding(.vertical, 18)
                if let installations = store.data.installations,!installations.isEmpty {
                    SectionHeading(title: "Installations", detail: "\(installations.count)")
                        .padding(.top, 18).padding(.bottom, 8)
                    ForEach(installations) { item in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.title).font(.headline)
                                    if let console = store.data.consoles
                                        .first(where: { $0.id == item.consoleId })
                                    {
                                        Text(console
                                            .name + " | " +
                                            (console.storage
                                                .first(where: { $0.id == item.storageId })?
                                                .displayName ?? item.storageId)).font(.caption)
                                            .foregroundStyle(secondaryText)
                                    }
                                }
                                Spacer()
                                StatusPill(
                                    text: readable(item.state),
                                    color: item.error == nil ? accent : danger
                                )
                            }
                            Label(
                                item
                                    .method == "SHADOWMOUNT" ? "ShadowMountPlus" :
                                    readable(item.method),
                                systemImage: "shippingbox.fill"
                            ).font(.caption).foregroundStyle(secondaryText)
                            if let error = item.error {
                                Label(
                                    readable(error),
                                    systemImage: "exclamationmark.triangle.fill"
                                ).font(.footnote).foregroundStyle(danger)
                            }
                        }.padding(.vertical, 18)
                            .overlay(alignment: .bottom) {
                                Divider().overlay(.white.opacity(0.1))
                            }
                    }
                }
                if !store.data.jobs.isEmpty {
                    SectionHeading(
                        title: "Server jobs",
                        detail: "\(store.data.jobs.count)"
                    ).padding(.top, 24).padding(.bottom, 8)
                }
                ForEach(store.data.jobs) {
                    JobCard(job: $0)
                }
                if store.data.jobs.isEmpty && (store.data.installations ?? []).isEmpty {
                    ContentUnavailableView(
                        "No active downloads",
                        systemImage: "checkmark.circle",
                        description: Text(
                            "Downloads keep running on your server when you close the companion."
                        )
                    )
                    .frame(maxWidth: .infinity, minHeight: 320).cinematicCard()
                }
            }.padding(.horizontal, 20).padding(.bottom, 24)
        }.background(CinematicBackdrop()).navigationTitle("Downloads")
            .refreshable { await store.refresh() }
    }
}

struct JobCard: View {
    @EnvironmentObject var store: Store
    let job: Job
    private var accessibilityTitle: String {
        job.title ?? "Selected release"
    }

    private var game: Game? {
        store.data.games.first(where: { $0.releases.contains(where: { $0.id == job.releaseId }) })
    }

    private var stateColor: Color {
        job.state == "ERROR" ? danger : ["COMPLETED", "READY_ON_PS5"]
            .contains(job.state) ? success : accent
    }

    private var measuredBytes: BuildByteProgress? {
        job.measuredBytes
    }

    private var shownProgress: Double? {
        measuredBytes?.fraction
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                if let game {
                    ArtworkView(path: game.coverUrl).frame(width: 70, height: 94)
                        .clipShape(RoundedRectangle(
                            cornerRadius: 10,
                            style: .continuous
                        ))
                } else {
                    Image(systemName: "arrow.down.circle.fill").font(.title).foregroundStyle(accent)
                        .frame(
                            width: 70,
                            height: 94
                        ).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text(job.title ?? "Selected release").font(.headline).lineLimit(2)
                    StatusPill(text: readable(job.state), color: stateColor)
                    if job.state == "QUEUED",
                       let position = job
                       .queuePosition
                    {
                        Text("Queue position \(position)").font(.caption)
                            .foregroundStyle(secondaryText)
                    }
                    if let console = store.data.consoles.first(where: { $0.id == job.consoleId }) {
                        Label(console.name, systemImage: "gamecontroller.fill").font(.caption)
                        if let destination = console.storage
                            .first(where: { $0.id == job.storageId })?
                            .displayName
                        {
                            Text(destination).font(.caption).foregroundStyle(secondaryText)
                        }
                    }
                }
                Spacer(minLength: 0)
                if let shownProgress {
                    Text("\(Int(shownProgress * 100))%").font(.title2.bold().monospacedDigit())
                        .foregroundStyle(.white)
                }
            }
            if job.kind == "BUILD" && job.state != "DOWNLOADING" {
                if job.state == "COMPLETED" {
                    Label(
                        "Prepared and verified",
                        systemImage: "checkmark.circle.fill"
                    ).foregroundStyle(success)
                } else if let detail = measuredBytes,
                          let progress = detail.fraction
                {
                    ProgressView(value: progress).tint(stateColor)
                        .accessibilityLabel("\(accessibilityTitle), \(job.displayStage)")
                        .accessibilityValue(
                            "\(Int(progress * 100)) percent, \(bytes(detail.completedBytes)) of \(bytes(detail.totalBytes))"
                        )
                    Text(bytes(detail.completedBytes) + " / " + bytes(detail.totalBytes))
                        .font(.caption.monospacedDigit()).foregroundStyle(secondaryText)
                } else if job.state != "ERROR" {
                    ProgressView().tint(accent)
                }
                Text(job.displayStage).font(.caption).foregroundStyle(secondaryText)
                if store.account?.role == "ADMIN", let detail = job.progress {
                    HStack(spacing: 14) {
                        if let package = detail.package?.state {
                            Label(
                                (detail.package?.method.map {
                                    readable($0) + " "
                                } ?? "Package ") +
                                    readable(package),
                                systemImage: "shippingbox.fill"
                            )
                        }
                        if let fakelib = detail.fakelib?.state,
                           !(["UNKNOWN", "NOT_REQUIRED"].contains(fakelib))
                        {
                            Label(
                                "Backport " + readable(fakelib),
                                systemImage: "puzzlepiece.extension.fill"
                            )
                        }
                    }.font(.caption2).foregroundStyle(secondaryText)
                }
            } else if let detail = measuredBytes, let progress = detail.fraction {
                ProgressView(value: progress).tint(stateColor)
                    .accessibilityLabel("\(accessibilityTitle), \(job.displayStage)")
                    .accessibilityValue(
                        "\(Int(progress * 100)) percent, \(bytes(detail.completedBytes)) of \(bytes(detail.totalBytes))"
                    )
                HStack {
                    Text(bytes(detail.completedBytes) + " / " + bytes(detail.totalBytes))
                    Spacer()
                    if job.speedBytesPerSecond > 0 {
                        Text(bytes(job.speedBytesPerSecond) + "/s")
                    }
                }.font(.caption.monospacedDigit()).foregroundStyle(secondaryText)
                if let seconds = job
                    .etaSeconds
                {
                    Text("About \(seconds / 60)m \(seconds % 60)s remaining").font(.caption)
                        .foregroundStyle(secondaryText)
                }
            } else if !["ERROR", "COMPLETED", "CANCELLED"].contains(job.state) {
                ProgressView().tint(accent)
            }
            if let error = job.error {
                Label(
                    readable(error),
                    systemImage: "exclamationmark.triangle.fill"
                ).font(.footnote.weight(.semibold)).foregroundStyle(danger)
            }
            if let location = job
                .location
            {
                Label(location, systemImage: "folder").font(.caption).foregroundStyle(secondaryText)
                    .textSelection(.enabled)
            }
            if job
                .retryable
            {
                Button("Retry", systemImage: "arrow.clockwise") {
                    control("retry")
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
            } else if job.kind == "DOWNLOAD" && !["COMPLETED", "CANCELLED"]
                .contains(job.state)
            {
                HStack {
                    Button(
                        job.state == "PAUSED" ? "Resume" : "Pause",
                        systemImage: job.state == "PAUSED" ? "play.fill" : "pause.fill"
                    ) {
                        control(job.state == "PAUSED" ? "resume" : "pause")
                    }.buttonStyle(.bordered)
                        .controlSize(.large)
                    Button("Cancel", role: .destructive) {
                        control("cancel")
                    }
                    .buttonStyle(.bordered).controlSize(.large)
                }
            }
            if job
                .dismissible
            {
                Button("Remove from Downloads", role: .destructive) {
                    dismiss()
                }
                .font(.footnote.weight(.semibold)).frame(minHeight: 44)
            }
        }.padding(.vertical, 20)
            .overlay(alignment: .bottom) {
                Divider().overlay(.white.opacity(0.1))
            }
    }

    func control(_ action: String) {
        store.perform { api in
            let _: Acknowledgement = try await api.request(
                "/jobs/\(job.id)/control",
                method: "POST",
                json: ["action": action]
            )
        }
    }

    func dismiss() {
        store.perform { api in
            let _: Acknowledgement = try await api.request(
                "/jobs/\(job.id)",
                method: "DELETE"
            )
        }
    }
}
