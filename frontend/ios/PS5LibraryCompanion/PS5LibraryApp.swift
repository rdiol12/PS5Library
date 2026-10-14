import SwiftUI

@main struct PS5LibraryApp: App {
    @StateObject private var store = Store()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).preferredColorScheme(.dark).tint(accent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    @State private var addAccount = false
    var body: some View {
        Group {
            if store.account == nil {
                SignIn()
            } else { tabs }
        }
        .sheet(isPresented: $addAccount) {
            SignIn()
        }
        .alert(
            "PS5Library",
            isPresented: Binding(
                get: {
                    store.error != nil
                },
                set: {
                    if !$0 {
                        store.error = nil
                    }
                }
            )
        ) {
            Button("OK") {
                store.error = nil
            }
        } message: {
            Text(store.error ?? "")
        }
    }

    private var tabs: some View {
        TabView {
            NavigationStack {
                LibraryView()
            }.tabItem {
                Label(
                    "Library",
                    systemImage: "rectangle.stack.fill"
                )
            }
            NavigationStack {
                DownloadsView()
            }.tabItem {
                Label(
                    "Downloads",
                    systemImage: "arrow.down.circle"
                )
            }
            NavigationStack{ProfileView()}.tabItem {
                Label(
                    "My PS5",
                    systemImage: "gamecontroller"
                )
            }
            settings.tabItem {
                Label("Settings", systemImage: "gearshape")
            }
        }.background(CinematicBackdrop())
            .toolbarBackground(appBackground.opacity(0.98), for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .toolbarColorScheme(.dark, for: .tabBar)
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section("Your accounts") {
                    ForEach(store.accounts) { profile in
                        Button {
                            store.activate(profile)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(profile.username)
                                    Text(profile.server.host ?? "").font(.caption)
                                }
                                Spacer()
                                if profile.id == store.account?.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                    Button("Add account / server") {
                        addAccount = true
                    }
                    Button("Sign out", role: .destructive) {
                        store.signOut()
                    }
                }
                Section {
                    NavigationLink("Server connection") {
                        ServerConnectionView()
                    }
                    NavigationLink("Console setup") {
                        ConsolesView().navigationTitle("My PS5s")
                    }
                    NavigationLink("Content Sources") {
                        SourcesView().id(store.account?.id)
                    }
                    NavigationLink("Notifications") {
                        NotificationsView().id(store.account?.id)
                    }
                    NavigationLink("Prepared packages on this server") {
                        CacheView()
                    }
                    if store.account?
                        .role ==
                        "ADMIN"
                    {
                        NavigationLink("Community Services") {
                            CommunityConnectionView()
                        }
                        InvitationView()
                    }
                }
                Section {
                    Text("Independent homebrew library. Sony/PSN credentials are never required.")
                        .font(.footnote).foregroundStyle(secondaryText)
                }
            }.cinematicList().navigationTitle("Settings")
        }
    }
}
