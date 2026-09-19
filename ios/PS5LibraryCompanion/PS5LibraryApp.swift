import SwiftUI
import AVKit
import VisionKit

private let accent=Color(red:0.48,green:0.7,blue:0.98)
private let appBackground=Color(red:0.025,green:0.047,blue:0.08)
@main struct PS5LibraryApp:App {
    @StateObject private var store=Store()
    var body:some Scene{WindowGroup{RootView().environmentObject(store).preferredColorScheme(.dark).tint(accent)}}
}
struct ArtworkView:View {
    @EnvironmentObject var store:Store;let path:String;@State private var image:UIImage?
    var body:some View{ZStack{appBackground;Image(systemName:"gamecontroller.fill").font(.largeTitle).foregroundStyle(accent.opacity(0.4));if let image=image{Image(uiImage:image).resizable().scaledToFill()}}
        .clipped().task(id:(store.account?.id ?? "")+path){image=nil;guard let api=store.api else{return};do{let data=try await api.artwork(path);let decoded=await Task.detached(priority:.utility){UIImage(data:data)?.preparingForDisplay()}.value;if !Task.isCancelled{image=decoded}}catch{}}
    }
}
struct RootView:View {
    @EnvironmentObject var store:Store
    @State private var query=""
    @State private var addAccount=false
    @State private var collection=GameCollection.recent
    @State private var genre=""
    private var genres:[String]{Array(Set(store.data.games.flatMap{$0.genres ?? []})).sorted()}
    private var visibleGames:[Game]{(query.isEmpty ? collection:GameCollection.all).select(store.data.games,query:query,genre:genre)}
    var body:some View {
        Group {if store.account==nil{SignIn()}else{tabs}}
            .sheet(isPresented:$addAccount){SignIn()}
            .alert("PS5Library",isPresented:Binding(get:{store.error != nil},set:{if !$0{store.error=nil}})){Button("OK"){store.error=nil}}message:{Text(store.error ?? "")}
    }
    private var tabs:some View {
        TabView {
            discover.tabItem{Label("Discover",systemImage:"sparkles")}
            NavigationStack{LibraryView()}.tabItem{Label("Library",systemImage:"square.grid.2x2")}
            NavigationStack{DownloadsView()}.tabItem{Label("Downloads",systemImage:"arrow.down.circle")}
            NavigationStack{ConsolesView().navigationTitle("My PS5s")}.tabItem{Label("My PS5",systemImage:"gamecontroller")}
            settings.tabItem{Label("Settings",systemImage:"gearshape")}
        }
    }
    private var discover:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:26) {
                    if store.offline{Label("Server offline · showing last synced data",systemImage:"wifi.slash").font(.caption).foregroundStyle(.orange)}
                    if query.isEmpty,let hero=store.data.featured,let game=store.data.games.first(where:{$0.id==hero.gameId}) {
                        NavigationLink(value:game){ZStack(alignment:.bottomLeading){ArtworkView(path:hero.heroUrl ?? game.heroUrl).frame(height:350);LinearGradient(colors:[.clear,appBackground],startPoint:.top,endPoint:.bottom);VStack(alignment:.leading,spacing:9){Text("FEATURED").font(.caption).tracking(3).foregroundStyle(accent);Text(game.title).font(.largeTitle.bold());Text(game.description ?? "").lineLimit(2).font(.subheadline).foregroundStyle(.secondary);Text("View Game  ›").font(.headline)}.padding(22)}}.buttonStyle(.plain).clipShape(RoundedRectangle(cornerRadius:20))
                    }
                    Picker("Collection",selection:$collection){ForEach(GameCollection.allCases){Text($0.rawValue).tag($0)}}
                    Picker("Category",selection:$genre){Text("All Categories").tag("");ForEach(genres,id:\.self){Text($0).tag($0)}}
                    Text(query.isEmpty ? collection.rawValue:"Search Results").font(.title2.bold())
                    GameGrid(games:visibleGames)
                    if store.loading{ProgressView("Loading your library…").frame(maxWidth:.infinity)}
                }.padding()
            }
            .background(appBackground).navigationTitle("PS5Library")
            .searchable(text:$query,prompt:"Games, publishers, genres")
            .navigationDestination(for:Game.self){GameDetails(game:$0)}
            .refreshable{await store.refresh()}
        }
    }
    private var settings:some View {
        NavigationStack {
            Form {
                Section("Your accounts") {
                    ForEach(store.accounts){profile in Button{store.activate(profile)}label:{HStack{VStack(alignment:.leading){Text(profile.username);Text(profile.server.host ?? "").font(.caption)};Spacer();if profile.id==store.account?.id{Image(systemName:"checkmark")}}}}
                    Button("Add account / server"){addAccount=true}
                    Button("Sign out",role:.destructive){store.signOut()}
                }
                Section {
                    NavigationLink("Content Sources"){SourcesView().id(store.account?.id)}
                    NavigationLink("My Profile & Trophies"){ProfileView().id(store.account?.id)}
                    NavigationLink("Notifications"){NotificationsView().id(store.account?.id)}
                    NavigationLink("Prepared packages on this server"){CacheView()}
                    if store.account?.role=="ADMIN"{InvitationView()}
                }
                Section{Text("Independent homebrew library. Sony/PSN credentials are never required.").font(.footnote).foregroundStyle(.secondary)}
            }.navigationTitle("Settings")
        }
    }
}
struct GameGrid:View{let games:[Game];var body:some View{LazyVGrid(columns:[GridItem(.adaptive(minimum:145),spacing:15)],spacing:22){ForEach(games){game in NavigationLink(value:game){VStack(alignment:.leading,spacing:8){ArtworkView(path:game.coverUrl).aspectRatio(3/4,contentMode:.fit).clipShape(RoundedRectangle(cornerRadius:13));Text(game.title).font(.headline).lineLimit(2)}}.buttonStyle(.plain)}}}}
struct GameDetails:View {
    @EnvironmentObject var store:Store;let game:Game;@State private var download=false
    @State private var saving=false
    var saved:Bool{store.data.games.first(where:{$0.id==game.id})?.saved ?? false}
    var body:some View{ScrollView{VStack(alignment:.leading,spacing:22){ArtworkView(path:game.heroUrl).frame(height:260).overlay(alignment:.bottom){LinearGradient(colors:[.clear,appBackground],startPoint:.top,endPoint:.bottom).frame(height:120)};VStack(alignment:.leading,spacing:18){Text(game.title).font(.largeTitle.bold());Text((game.genres ?? []).joined(separator:" · ")).foregroundStyle(accent);if store.ready(game){Label("Available on your PS5",systemImage:"checkmark.circle.fill").foregroundStyle(accent)};Button(saved ? "Remove from Saved Games":"Save Game",systemImage:saved ? "heart.fill":"heart"){saveGame()}.disabled(saving||store.offline);Button("Download & Prepare"){download=true}.buttonStyle(.borderedProminent).controlSize(.large).disabled(game.releases.allSatisfy{$0.sources.isEmpty});Text(game.description ?? "Description unavailable.");Text(game.publisher ?? "").font(.caption).foregroundStyle(.secondary);GameMediaView(game:store.data.games.first(where:{$0.id==game.id}) ?? game).id((store.account?.id ?? "")+game.id);Text("Available releases").font(.title2.bold());ForEach(game.releases){release in HStack{Text(release.label);Spacer();Text(bytes(release.size ?? 0)).foregroundStyle(.secondary)}.font(.subheadline)}}.padding(.horizontal);ScrollView(.horizontal){HStack{ForEach(game.screenshotUrls ?? [],id:\.self){ArtworkView(path:$0).frame(width:290,height:164).clipShape(RoundedRectangle(cornerRadius:12))}}.padding()}}}.background(appBackground).navigationBarTitleDisplayMode(.inline).sheet(isPresented:$download){InstallationView(game:game)}}
}
extension GameDetails {
    func saveGame() {
        guard let api=store.api else{return}
        let owner=store.account?.id, value = !saved
        saving=true
        Task { @MainActor in
            defer { saving=false }
            do {
                let _:Acknowledgement=try await api.request("/games/\(game.id)/save",method:"POST",body:["saved":value])
                if store.account?.id==owner { await store.refresh() }
            } catch { if store.account?.id==owner { store.error=error.localizedDescription } }
        }
    }
}
struct ConsolePicker:View{@EnvironmentObject var store:Store;var body:some View{Picker("Target PS5",selection:$store.data.consoleId){ForEach(store.data.consoles){Text($0.name+" · "+readable($0.presence)).tag($0.id)}}.onChange(of:store.data.consoleId){_,_ in Task{await store.refresh()}}}}
struct InstallationView:View {
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) var dismiss
    let game:Game
    @State private var releaseId=""
    @State private var sourceId=""
    @State private var consoleId=""
    @State private var storageId=""
    @State private var method=""
    @State private var review:ReviewedInstallation?
    @State private var busy=false
    @State private var planning=false
    @State private var failure:String?
    var release:Release?{game.releases.first{$0.id==releaseId}}
    var source:SourceRelease?{release?.sources.first{$0.id==sourceId} ?? release?.sources.first}
    var selection:InstallationSelection {
        InstallationSelection(sourceReleaseId:source?.id ?? "",consoleId:consoleId,method:method.isEmpty ? nil:method)
    }
    var currentPlan:Plan?{review?.selection==selection ? review?.plan:nil}
    var submission:InstallationRequest?{review?.submission(for:selection,storageId:storageId)}
    var body:some View {
        NavigationStack {
            Form {
                Section {
                    HStack {ArtworkView(path:game.coverUrl).frame(width:75,height:100).clipShape(RoundedRectangle(cornerRadius:8));Text(game.title).font(.headline)}
                }
                Section("Release and source") {
                    Picker("Release",selection:$releaseId){ForEach(game.releases){Text($0.label).tag($0.id)}}
                    if let release=release,!release.sources.isEmpty {
                        Picker("Source",selection:Binding(get:{source?.id ?? ""},set:{sourceId=$0;method=""})) {
                            ForEach(release.sources){Text($0.name+" / "+$0.format.uppercased()).tag($0.id)}
                        }
                    } else {Text("This release has no downloadable source.").foregroundStyle(.secondary)}
                }
                Section("Your PS5") {
                    if store.data.consoles.isEmpty {Text("Pair a console in My PS5 before requesting an installation.")}
                    else {Picker("Console",selection:$consoleId){ForEach(store.data.consoles){Text($0.name+" / "+readable($0.presence)).tag($0.id)}}}
                }
                if let plan=currentPlan {
                    Section("Installation method") {
                        Picker("Method",selection:$method) {
                            Text("Automatic").tag("")
                            ForEach(plan.methods,id:\.self){Text($0=="SHADOWMOUNT" ? "ShadowMountPlus":readable($0)).tag($0)}
                        }
                    }
                    Section("Storage") {
                        Picker("Destination",selection:$storageId) {
                            Text("Choose storage").tag("")
                            ForEach(plan.storage.filter{$0.allowed}){Text($0.displayName+" / "+bytes($0.freeBytes)+" free").tag($0.id)}
                        }
                        if plan.storage.allSatisfy({!$0.allowed}){Text("No supported destination has enough free space.").foregroundStyle(.orange)}
                    }
                    Section("Confirm") {
                        Label(readable(plan.compatibility.status),systemImage:plan.allowed ? "checkmark.shield":"exclamationmark.triangle")
                            .foregroundStyle(plan.allowed ? accent:.orange)
                        Text(plan.message ?? readable(plan.reason)).font(.footnote)
                        if let storage=plan.storage.first(where:{$0.id==storageId}){Text((plan.estimated ? "Estimated space required: ":"Space required: ")+bytes(storage.requiredBytes))}
                        if plan.online==false{Text("Preparation can start now. Delivery will wait for your PS5.")}
                        Button("Download & Prepare"){confirm()}.disabled(submission==nil||planning||busy||store.offline)
                    }
                } else if planning {ProgressView("Checking compatibility and storage...")}
                if let failure=failure{Text(failure).foregroundStyle(.orange);Button("Check again"){Task{await loadPlan()}}.disabled(planning)}
                if store.offline{Label("Connect to the server to prepare a download.",systemImage:"wifi.slash").foregroundStyle(.orange)}
                if busy{ProgressView("Submitting installation...")}
            }.disabled(busy).navigationTitle("Download")
            .toolbar{ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}.disabled(busy)}}
            .interactiveDismissDisabled(busy)
        }
        .onAppear {
            if releaseId.isEmpty{releaseId=game.releases.first(where:{!$0.sources.isEmpty})?.id ?? game.releases.first?.id ?? ""}
            if consoleId.isEmpty{consoleId=store.data.consoleId}
        }
        .onChange(of:releaseId){_,_ in sourceId="";method=""}
        .onChange(of:consoleId){_,_ in method=""}
        .onChange(of:store.account?.id){_,_ in dismiss()}
        .task(id:selection){await loadPlan()}
    }
    func loadPlan() async {
        let selected=selection,owner=store.account?.id
        review=nil;storageId="";failure=nil
        guard !selected.sourceReleaseId.isEmpty,!selected.consoleId.isEmpty,let api=store.api else{planning=false;return}
        planning=true
        defer{if selection==selected{planning=false}}
        do {
            let result:Plan=try await api.request("/installations/plan",method:"POST",body:selected)
            guard !Task.isCancelled,store.account?.id==owner,selection==selected else{return}
            review=ReviewedInstallation(selection:selected,plan:result)
            storageId=result.storage.first(where:{$0.allowed})?.id ?? ""
        } catch {if !Task.isCancelled,store.account?.id==owner,selection==selected{failure=error.localizedDescription}}
    }
    func confirm() {
        guard !busy,!planning,!store.offline,let request=submission,let api=store.api else{return}
        let owner=store.account?.id
        busy=true;failure=nil
        Task { @MainActor in
            defer{busy=false}
            do {
                let _:Acknowledgement=try await api.request("/installations",method:"POST",body:request)
                guard store.account?.id==owner else{return}
                await store.refresh();dismiss()
            } catch {if store.account?.id==owner{review=nil;failure=error.localizedDescription}}
        }
    }
}
struct DownloadsView:View {
    @EnvironmentObject var store:Store
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:18) {
                if store.offline{Label("Last synced status - server offline",systemImage:"wifi.slash").foregroundStyle(.orange)}
                if let installations=store.data.installations,!installations.isEmpty {
                    Text("Installations").font(.title2.bold())
                    ForEach(installations){item in
                        VStack(alignment:.leading,spacing:8) {
                            Text(item.title).font(.headline)
                            Text(readable(item.state)).foregroundStyle(accent)
                            if let console=store.data.consoles.first(where:{$0.id==item.consoleId}) {
                                Text(console.name+" / "+(console.storage.first(where:{$0.id==item.storageId})?.displayName ?? item.storageId)).font(.caption)
                            }
                            Text(readable(item.method)).font(.caption).foregroundStyle(.secondary)
                            if let error=item.error{Text(readable(error)).foregroundStyle(.orange)}
                        }.padding().frame(maxWidth:.infinity,alignment:.leading).background(.ultraThinMaterial,in:RoundedRectangle(cornerRadius:16))
                    }
                }
                if !store.data.jobs.isEmpty{Text("Jobs").font(.title2.bold())}
                ForEach(store.data.jobs){JobCard(job:$0)}
                if store.data.jobs.isEmpty && (store.data.installations ?? []).isEmpty {
                    ContentUnavailableView("You're all caught up",systemImage:"checkmark.circle",description:Text("Downloads keep running on your server when you close the companion."))
                }
            }.padding()
        }.navigationTitle("Downloads").refreshable{await store.refresh()}
    }
}
struct JobCard:View {
    @EnvironmentObject var store:Store;let job:Job
    var body:some View{VStack(alignment:.leading,spacing:14){HStack{if let game=store.data.games.first(where:{$0.releases.contains(where:{$0.id==job.releaseId})}){ArtworkView(path:game.coverUrl).frame(width:72,height:92).clipShape(RoundedRectangle(cornerRadius:8))};VStack(alignment:.leading){Text(job.title ?? "Selected release").font(.headline);Text(readable(job.state)).foregroundStyle(accent);if let console=store.data.consoles.first(where:{$0.id==job.consoleId}){Text(console.name).font(.caption);Text(console.storage.first(where:{$0.id==job.storageId})?.displayName ?? "").font(.caption).foregroundStyle(.secondary)}}}
        if job.kind=="BUILD"&&job.state != "DOWNLOADING"{if job.state=="COMPLETED"{Label("Prepared and verified",systemImage:"checkmark.circle")}else if job.state != "ERROR"{ProgressView()};Text(job.progress?.stage ?? readable(job.state)).font(.caption)}else{ProgressView(value:job.totalBytes.flatMap{$0>0 ? Double(job.downloadedBytes)/Double($0):nil});Text(bytes(job.downloadedBytes)+" / "+bytes(job.totalBytes ?? 0)).font(.caption.monospacedDigit());if job.speedBytesPerSecond>0{Text(bytes(job.speedBytesPerSecond)+"/s"+(job.etaSeconds.map{" · About \($0/60)m \($0%60)s"} ?? "")).font(.caption).foregroundStyle(.secondary)}}
        if let error=job.error{Text("Error: "+error).foregroundStyle(.orange)}
        if let location=job.location{Label(location,systemImage:"folder").font(.caption).foregroundStyle(.secondary)}
        if job.retryable{Button("Retry"){control("retry")}.buttonStyle(.borderedProminent)}
        else if job.kind=="DOWNLOAD" && !["COMPLETED","CANCELLED"].contains(job.state){HStack{Button(job.state=="PAUSED" ? "Resume":"Pause"){control(job.state=="PAUSED" ? "resume":"pause")};Button("Cancel",role:.destructive){control("cancel")}}}
        if job.dismissible{Button("Remove from Downloads",role:.destructive){dismiss()}}
    }.padding(18).frame(maxWidth:.infinity,alignment:.leading).background(.ultraThinMaterial,in:RoundedRectangle(cornerRadius:20))}
    func control(_ action:String){store.perform{api in let _:Acknowledgement=try await api.request("/jobs/\(job.id)/control",method:"POST",json:["action":action])}}
    func dismiss(){store.perform{api in let _:Acknowledgement=try await api.request("/jobs/\(job.id)",method:"DELETE")}}
}
struct ConsolesView:View {
    @EnvironmentObject var store:Store
    var body:some View {
        List {
            PairingView()
            ForEach(store.data.consoles){console in ConsoleCard(console:console)}
        }.id(store.account?.id).refreshable{await store.refresh()}
    }
}
struct PairingView:View {
    @EnvironmentObject var store:Store
    @State private var code=""
    @State private var consoleId=""
    @State private var busy=false
    @State private var failure:String?
    @State private var scanning=false
    @State private var scannedPair:PairingQR?
    var scannedFrontend:Bool?{pairingCode(code)==scannedPair?.code ? scannedPair?.frontend:nil}
    var body:some View {
        Section("Connect PS5Library") {
            TextField("Code shown on PS5",text:$code).textInputAutocapitalization(.characters).autocorrectionDisabled()
            Button("Scan pairing QR code",systemImage:"qrcode.viewfinder"){scanning=true}.disabled(store.offline)
            Picker("Connect to",selection:$consoleId) {
                Text("Register a new PS5").tag("")
                ForEach(store.data.consoles){Text($0.name).tag($0.id)}
            }
            Text("For a storefront code, select your existing PS5. An agent code registers a new console.").font(.caption).foregroundStyle(.secondary)
            Button(busy ? "Linking...":"Link to my account"){claim()}
                .disabled(busy||pairingCode(code)==nil||store.offline||(scannedFrontend==true && consoleId.isEmpty))
            if let failure=failure{Text(failure).foregroundStyle(.orange)}
        }.disabled(busy)
        .sheet(isPresented:$scanning){PairingScannerSheet{payload in
            scanning=false
            guard let server=store.account?.server,let result=PairingQR(payload,server:server) else{
                failure="This is not a pairing QR code for the selected server. You can enter the displayed code manually.";return
            }
            code=result.code
            scannedPair=result
            if result.frontend {
                if !store.data.consoles.contains(where:{$0.id==consoleId}){consoleId=store.data.consoleId}
                failure="Storefront code scanned. Choose your PS5, then tap Link to my account."
            } else {consoleId="";failure=nil}
        }}
    }
    func claim() {
        guard !busy,scannedFrontend != true || !consoleId.isEmpty,let codeValue=pairingCode(code),let api=store.api else{return}
        let owner=store.account?.id
        var body=["code":codeValue]
        if !consoleId.isEmpty{body["consoleId"]=consoleId}
        busy=true;failure=nil
        Task { @MainActor in
            defer{busy=false}
            do {
                let result:Acknowledgement=try await api.request("/pairings/claim",method:"POST",json:body)
                guard store.account?.id==owner else{return}
                code=""
                if let id=result.consoleId{store.data.consoleId=id}
                await store.refresh()
            } catch { if store.account?.id==owner{failure=error.localizedDescription} }
        }
    }
}
struct ConsoleCard:View {
    @EnvironmentObject var store:Store
    let console:Console
    @State private var name=""
    @State private var message=""
    @State private var editing=false
    @State private var revoking=false
    @State private var busy=false
    var body:some View {
        Section {
            VStack(alignment:.leading,spacing:16) {
                Label(console.name,systemImage:"gamecontroller.fill").font(.title3.bold())
                Text(readable(console.presence)+" / Firmware "+(console.firmware ?? "unknown")+" / \(console.games) games").font(.caption)
                if console.isDefault{Label("Default PS5",systemImage:"star.fill").foregroundStyle(accent)}
                ForEach(console.storage){storage in
                    VStack(alignment:.leading) {
                        Text(storage.displayName)
                        ProgressView(value:storage.totalBytes>0 ? min(1,max(0,1-Double(storage.freeBytes)/Double(storage.totalBytes))):0)
                        Text(bytes(storage.freeBytes)+" available").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Button("Rename"){name=console.name;editing=true}
                if !console.isDefault{Button("Make default PS5"){update(ConsoleUpdate(isDefault:true))}}
                Button("Refresh firmware"){refreshFirmware()}
                Button("Revoke console access",role:.destructive){revoking=true}
                if busy{ProgressView()}
                if !message.isEmpty{Text(message).font(.caption).accessibilityLabel(message)}
            }.padding(.vertical,8).disabled(busy||store.offline)
        }
        .alert("Console name",isPresented:$editing) {
            TextField("Name",text:$name)
            Button("Save"){if let valid=consoleName(name){update(ConsoleUpdate(name:valid))}}.disabled(consoleName(name)==nil)
            Button("Cancel",role:.cancel){}
        } message:{Text("Use 1 to 80 characters.")}
        .confirmationDialog("Revoke access for \(console.name)?",isPresented:$revoking,titleVisibility:.visible) {
            Button("Revoke access",role:.destructive){revoke()}
            Button("Cancel",role:.cancel){}
        } message:{Text("This disconnects this console's agent and storefront. Games remain on the console. Reconnecting requires resetting its device identity and pairing again.")}
    }
    func update(_ body:ConsoleUpdate) {
        run { api in
            let _:Acknowledgement=try await api.request("/consoles/\(console.id)",method:"PATCH",body:body)
            return body.isDefault==true ? "Default PS5 updated.":"Console renamed."
        }
    }
    func refreshFirmware() {
        run { api in
            let _:FirmwareRefresh=try await api.request("/consoles/\(console.id)/refresh",method:"POST")
            return "Firmware check requested. The value updates when your PS5 reports back."
        }
    }
    func revoke() {
        run { api in
            let _:Acknowledgement=try await api.request("/consoles/\(console.id)/revoke",method:"POST")
            return "Console access revoked. Presence may take a moment to update."
        }
    }
    func run(_ action:@escaping (API) async throws -> String) {
        guard !busy,let api=store.api else{return};let owner=store.account?.id
        busy=true;message=""
        Task { @MainActor in
            defer{busy=false}
            do {
                let result=try await action(api)
                guard store.account?.id==owner else{return}
                message=result;await store.refresh()
            } catch { if store.account?.id==owner{message=error.localizedDescription} }
        }
    }
}
struct CacheView:View{@EnvironmentObject var store:Store;@State private var artifacts:[Artifact]=[];var body:some View{List{Section{Text("Verified packages stay on your PC for reuse. Deleting a cached copy keeps the original source and your console's copy.").font(.footnote)};ForEach(artifacts){artifact in VStack(alignment:.leading){Text(artifact.title).font(.headline);Text(artifact.version+" · "+bytes(artifact.size)).font(.caption)}.swipeActions{Button("Delete PC copy",role:.destructive){store.perform{api in let _:Acknowledgement=try await api.request("/artifacts/\(artifact.id)",method:"DELETE");artifacts=try await api.request("/artifacts")}}}}}.navigationTitle("Server cache").task{guard let api=store.api else{return};do{artifacts=try await api.request("/artifacts")}catch{store.error=error.localizedDescription}}}}
struct LibraryView:View {
    @EnvironmentObject var store:Store
    @State private var section="console"
    @State private var storageId=""
    var games:[Game] {
        if section=="server" { return GameCollection.server.select(store.data.games) }
        if section=="saved" { return GameCollection.saved.select(store.data.games) }
        return store.data.games.filter{$0.ready(in:store.data.library,storageId:storageId)}
    }
    var body:some View {
        ScrollView { VStack(alignment:.leading,spacing:18) {
            Picker("Library",selection:$section) {
                Text("On PS5").tag("console");Text("On Server").tag("server");Text("Saved").tag("saved")
            }.pickerStyle(.segmented)
            if section=="console" {
                ConsolePicker()
                Picker("Storage",selection:$storageId) {
                    Text("All Storage").tag("")
                    ForEach(store.data.consoles.first(where:{$0.id==store.data.consoleId})?.storage ?? []) { Text($0.displayName).tag($0.id) }
                }
            }
            if store.offline { Label("Last synced data · server offline",systemImage:"wifi.slash").foregroundStyle(.orange) }
            if games.isEmpty { ContentUnavailableView("No games here yet",systemImage:"gamecontroller",description:Text("Choose another collection or save a game from Discover.")) }
            GameGrid(games:games)
        }.padding() }
        .navigationTitle("My Library")
        .navigationDestination(for:Game.self){GameDetails(game:$0)}
        .onChange(of:store.data.consoleId){_,_ in storageId=""}
        .refreshable{await store.refresh()}
    }
}
struct ProfileView:View {
    @EnvironmentObject var store:Store
    @State private var profile:Profile?
    @State private var failure:String?
    @State private var busy=false
    var body:some View {
        List {
            if let profile=profile {
                Section {
                    HStack {
                        if let path=profile.avatarUrl { ArtworkView(path:path).frame(width:64,height:64).clipShape(Circle()) }
                        VStack(alignment:.leading){Text(profile.username).font(.title2.bold());Text(readable(profile.role)).foregroundStyle(.secondary)}
                    }
                    Menu("Change profile picture") {
                        Button("Use default",role:.destructive){changeAvatar(nil)}
                        ForEach(store.data.games){game in Button(game.title){changeAvatar(game.coverUrl)}}
                    }.disabled(busy||store.offline)
                }
                ForEach(profile.consoles){console in
                    Section(console.name) {
                        if let summary=console.trophySummary {
                            LabeledContent("Platinum",value:String(summary.earnedTrophies.platinum))
                            LabeledContent("Gold",value:String(summary.earnedTrophies.gold))
                            LabeledContent("Silver",value:String(summary.earnedTrophies.silver))
                            LabeledContent("Bronze",value:String(summary.earnedTrophies.bronze))
                            Text("Local summary from \(Date(timeIntervalSince1970:summary.modifiedAt).formatted(date:.abbreviated,time:.shortened))").font(.caption).foregroundStyle(.secondary)
                        } else { Text("Trophy summary unavailable").foregroundStyle(.secondary) }
                        Text("Per-game earned progress has not been collected. Totals are separate for each console.").font(.caption).foregroundStyle(.secondary)
                        ForEach(console.games){game in
                            HStack {
                                ArtworkView(path:game.coverUrl).frame(width:44,height:58).clipShape(RoundedRectangle(cornerRadius:6))
                                VStack(alignment:.leading){Text(game.title);Text(game.platform+" · "+(game.available ? "Available on PS5":"Not currently available")).font(.caption).foregroundStyle(.secondary)}
                            }
                        }
                    }
                }
            } else if failure==nil { ProgressView("Loading profile…") }
            if let failure=failure { Text(failure).foregroundStyle(.orange);Button("Retry"){Task{await load()}} }
        }.navigationTitle("My Profile").task{await load()}.refreshable{await load()}
    }
    func load() async {
        guard let api=store.api else{return};let owner=store.account?.id
        do {
            let result:Profile=try await api.request("/profile")
            guard !Task.isCancelled,store.account?.id==owner else{return}
            profile=result;failure=nil
        } catch { if !Task.isCancelled,store.account?.id==owner { failure=error.localizedDescription } }
    }
    func changeAvatar(_ path:String?) {
        guard let api=store.api else{return};let owner=store.account?.id;busy=true
        Task { @MainActor in
            defer{busy=false}
            do {
                if let path=path {
                    let data=try await api.artwork(path)
                    guard data.count<=4*1024*1024 else{throw StoreError.message("This image is too large for a profile picture.")}
                    let _:Acknowledgement=try await api.request("/profile/avatar",method:"POST",json:["data":data.base64EncodedString()])
                } else { let _:Acknowledgement=try await api.request("/profile/avatar",method:"DELETE") }
                if store.account?.id==owner{await load()}
            } catch { if store.account?.id==owner{failure=error.localizedDescription} }
        }
    }
}
struct NotificationsView:View {
    @EnvironmentObject var store:Store
    @State private var notices:[Notice]=[]
    @State private var loaded=false
    @State private var failure:String?
    var body:some View {
        List {
            if !loaded && failure==nil { ProgressView("Loading notifications…") }
            if loaded && notices.isEmpty { ContentUnavailableView("No notifications",systemImage:"bell",description:Text("Console notices will appear here.")) }
            ForEach(notices){notice in VStack(alignment:.leading,spacing:6) {
                Text(readable(notice.code)).font(.headline);Text(notice.message)
                if let console=store.data.consoles.first(where:{$0.id==notice.consoleId}){Text(console.name).font(.caption).foregroundStyle(.secondary)}
                if let date=ISO8601DateFormatter().date(from:notice.createdAt){Text(date,style:.date).font(.caption).foregroundStyle(.secondary)}
            }}
            if let failure=failure{Text(failure).foregroundStyle(.orange);Button("Retry"){Task{await load()}}}
        }.navigationTitle("Notifications").task{await load()}.refreshable{await load()}
    }
    func load() async {
        guard let api=store.api else{return};let owner=store.account?.id
        do {
            let result:[Notice]=try await api.request("/notifications")
            guard !Task.isCancelled,store.account?.id==owner else{return}
            notices=result;loaded=true;failure=nil
        } catch { if !Task.isCancelled,store.account?.id==owner{failure=error.localizedDescription} }
    }
}
struct InvitationView:View{@EnvironmentObject var store:Store;@State private var invitation="";var body:some View{Button("Create invitation for a friend"){store.perform{api in let response:Invitation=try await api.request("/admin/invites",method:"POST");invitation=response.token}};if !invitation.isEmpty{Text("Single use · expires in 7 days").font(.caption);Text(invitation).font(.caption.monospaced()).textSelection(.enabled)}}}
struct SourcesView:View {
    @EnvironmentObject var store:Store
    @State private var sources:[CatalogSource]=[]
    @State private var loading=true
    @State private var adding=false
    @State private var syncing:String?
    @State private var failure:String?
    var body:some View {
        List {
            if loading{ProgressView("Loading sources...")}
            if !loading && sources.isEmpty && failure==nil {
                ContentUnavailableView("No sources yet",systemImage:"folder",description:Text("Add a source to import your catalog."))
            }
            ForEach(sources){source in
                Section(source.name) {
                    Text(readable(source.type)).font(.caption).foregroundStyle(.secondary)
                    if let last=source.last_synced{Text("Last scan: "+last).font(.caption)}
                    if let preparation=source.autoPrepare{Text("Automatic preparation: "+preparation)}
                    if source.shareCatalog==true{Label("Shared with server members",systemImage:"person.2")}
                    if let error=source.error{Text(readable(error)).foregroundStyle(.orange)}
                    ForEach(Array(source.observations.enumerated()),id:\.offset){_,observation in
                        VStack(alignment:.leading) {
                            Text(observation.path).font(.caption)
                            Text(readable(observation.state)).font(.caption).foregroundStyle(.secondary)
                            if let error=observation.error{Text(readable(error)).font(.caption).foregroundStyle(.orange)}
                        }
                    }
                    Button(syncing==source.id ? "Scanning...":"Scan now"){scan(source)}.disabled(syncing != nil||store.offline)
                }
            }
            if let failure=failure{Text(failure).foregroundStyle(.orange);Button("Retry"){Task{await load()}}}
        }.navigationTitle("Content Sources")
        .toolbar{Button("Add source",systemImage:"plus"){adding=true}.disabled(store.offline)}
        .sheet(isPresented:$adding,onDismiss:{Task{await load()}}){AddSourceView()}
        .task{await load()}.refreshable{await load()}
    }
    func load() async {
        guard let api=store.api else{return};let owner=store.account?.id
        defer{loading=false}
        do {
            let result:[CatalogSource]=try await api.request("/sources")
            guard !Task.isCancelled,store.account?.id==owner else{return}
            sources=result;failure=nil
        } catch { if !Task.isCancelled,store.account?.id==owner{failure=error.localizedDescription} }
    }
    func scan(_ source:CatalogSource) {
        guard syncing==nil,let api=store.api else{return};let owner=store.account?.id
        syncing=source.id;failure=nil
        Task { @MainActor in
            defer{syncing=nil}
            do {
                let _:Acknowledgement=try await api.request("/sources/\(source.id)/sync",method:"POST")
                guard store.account?.id==owner else{return}
                await load();await store.refresh()
            } catch {
                guard store.account?.id==owner else{return}
                let message=error.localizedDescription
                await load();failure=message
            }
        }
    }
}
struct AddSourceView:View {
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) var dismiss
    @State private var name=""
    @State private var type="LOCAL_FOLDER"
    @State private var location=""
    @State private var token=""
    @State private var preparation=""
    @State private var interval=0
    @State private var shared=false
    @State private var busy=false
    @State private var failure:String?
    var admin:Bool{store.account?.role=="ADMIN"}
    var input:SourceInput {
        SourceInput(name:name.trimmingCharacters(in:.whitespacesAndNewlines),type:type,location:location.trimmingCharacters(in:.whitespacesAndNewlines),tokenEnv:admin && !token.isEmpty ? token:nil,scanIntervalMinutes:interval==0 ? nil:interval,autoPrepare:admin && !preparation.isEmpty ? preparation:nil,shareCatalog:admin && shared)
    }
    var body:some View {
        NavigationStack {
            Form {
                Section("Source") {
                    TextField("Name",text:$name)
                    Picker("Type",selection:$type) {
                        Text("Local folder").tag("LOCAL_FOLDER")
                        Text("Manifest URL").tag("STATIC_MANIFEST")
                        Text("Private HTTP repository").tag("PRIVATE_HTTP")
                        Text("GitHub release").tag("GITHUB_RELEASE")
                        if admin{Text("Watched folder").tag("WATCH_FOLDER")}
                    }
                    TextField("Location",text:$location).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text(type=="GITHUB_RELEASE" ? "Enter owner/repository. The latest release must contain ps5library.json.":["LOCAL_FOLDER","WATCH_FOLDER"].contains(type) ? "Enter a relative folder on the server. Use . for its configured root. Local folders contain library.json.":"Enter the manifest URL. Private hosts must be allowed by your server configuration.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Scanning") {
                    Picker("Automatic scan",selection:$interval) {
                        Text("Manual only").tag(0)
                        Text("Every 5 minutes").tag(5)
                        Text("Every 30 minutes").tag(30)
                        Text("Every hour").tag(60)
                        Text("Daily").tag(1440)
                    }
                }
                if admin {
                    Section("Server options") {
                        TextField("REPOSITORY_TOKEN_... (optional)",text:$token).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Text("Enter an environment variable name configured on your server. Do not paste the token itself.").font(.caption).foregroundStyle(.secondary)
                        Picker("Automatic preparation",selection:$preparation) {
                            Text("Off").tag("");Text("FPKG").tag("FPKG");Text("ShadowMount").tag("SHADOWMOUNT");Text("Both").tag("BOTH")
                        }
                        Toggle("Share catalog with server members",isOn:$shared)
                    }
                }
                if let error=input.validationError{Text(error).font(.caption).foregroundStyle(.secondary)}
                if let failure=failure{Text(failure).foregroundStyle(.orange)}
                if busy{ProgressView("Saving source...")}
            }.disabled(busy).navigationTitle("Add Source")
            .toolbar {
                ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}.disabled(busy)}
                ToolbarItem(placement:.confirmationAction){Button("Save"){save()}.disabled(busy||input.validationError != nil||store.offline)}
            }.interactiveDismissDisabled(busy)
        }
    }
    func save() {
        guard !busy,input.validationError==nil,let api=store.api else{return}
        let owner=store.account?.id,body=input
        busy=true;failure=nil
        Task { @MainActor in
            defer{busy=false}
            do {
                let _:Acknowledgement=try await api.request("/sources",method:"POST",body:body)
                if store.account?.id==owner{dismiss()}
            } catch { if store.account?.id==owner{failure=error.localizedDescription} }
        }
    }
}
struct SignIn:View{
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) var dismiss
    @State private var server=""
    @State private var username=""
    @State private var password=""
    @State private var invite=""
    @State private var register=false
    @State private var busy=false
    @State private var failure:String?
    var body:some View{NavigationStack{ScrollView{VStack(alignment:.leading,spacing:24){Image(systemName:"gamecontroller.fill").font(.system(size:48)).foregroundStyle(accent);Text("PS5Library").font(.largeTitle.bold());Text("Games without limits").foregroundStyle(.secondary);TextField("https://your-library.example or http://192.168.1.20:3150",text:$server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled();TextField("Username",text:$username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username);SecureField("Password",text:$password).textContentType(register ? .newPassword:.password);if register{TextField("Invitation code",text:$invite).textInputAutocapitalization(.never).autocorrectionDisabled()};if let failure=failure{Text(failure).foregroundStyle(.orange)};Button(register ? "Create account":"Sign in"){busy=true;Task{do{try await store.login(server:server,username:username,password:password,invite:invite,register:register);dismiss()}catch{failure=error.localizedDescription};password="";busy=false}}.buttonStyle(.borderedProminent).controlSize(.large).disabled(busy||username.isEmpty||password.isEmpty);Button(register ? "Already have an account?":"Have a friend's invitation?"){register.toggle()};Text("Your server. Your account. Only your consoles and library.").font(.footnote).foregroundStyle(.secondary)}.textFieldStyle(.roundedBorder).padding(28)}}}
}

struct GameMediaView:View {
    @EnvironmentObject var store:Store
    let game:Game
    @State private var selection:String?
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            if game.trailer != nil{Button("Watch trailer",systemImage:"play.rectangle"){selection="trailers"}.disabled(store.offline)}
            else if let state=game.trailerState{Text("Trailer: "+readable(state)).font(.caption).foregroundStyle(.secondary)}
            if game.music != nil{Button("Play game music",systemImage:"music.note"){selection="music"}.disabled(store.offline)}
            else if let state=game.musicState{Text("Music: "+readable(state)).font(.caption).foregroundStyle(.secondary)}
        }
        .sheet(isPresented:Binding(get:{selection != nil},set:{if !$0{selection=nil}})) {
            if let kind=selection,let asset=kind=="music" ? game.music:game.trailer {
                MediaPlaybackView(asset:asset,kind:kind,title:game.title)
            }
        }
    }
}
struct MediaPlaybackView:View {
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) var scenePhase
    let asset:MediaAsset;let kind:String;let title:String
    @State private var player:AVPlayer?
    @State private var observation:NSKeyValueObservation?
    @State private var file:URL?
    @State private var failure:String?
    @State private var attempt=0
    var body:some View {
        NavigationStack {
            VStack(spacing:20) {
                if let player=player {
                    VideoPlayer(player:player).frame(minHeight:240)
                    if kind=="music"{Label("Game music",systemImage:"music.note").font(.headline)}
                    HStack { Button("Play",systemImage:"play.fill"){player.play()};Button("Pause",systemImage:"pause.fill"){player.pause()} }
                } else if let failure=failure {
                    Text(failure).foregroundStyle(.orange)
                    Button("Retry"){attempt+=1}
                } else {
                    ProgressView("Downloading and verifying media...")
                    Text(bytes(asset.size)).font(.caption).foregroundStyle(.secondary)
                }
            }.padding().navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar{ToolbarItem(placement:.cancellationAction){Button("Close"){dismiss()}}}
        }
        .task(id:attempt){await load()}
        .onDisappear{cleanup()}
        .onChange(of:store.account?.id){_,_ in cleanup();dismiss()}
        .onChange(of:scenePhase){_,phase in if phase != .active{player?.pause()}}
        .onReceive(NotificationCenter.default.publisher(for:.AVPlayerItemFailedToPlayToEndTime)){notification in
            guard let item=notification.object as? AVPlayerItem,item === player?.currentItem else{return}
            cleanup();failure="Playback failed. Try again."
        }
    }
    func load() async {
        guard let api=store.api else{return};let owner=store.account?.id
        cleanup();failure=nil
        var downloaded:URL?
        do {
            let local=try await api.media(asset,kind:kind);downloaded=local
            try Task.checkCancellation()
            guard store.account?.id==owner else{try? FileManager.default.removeItem(at:local);return}
            let item=AVPlayerItem(url:local)
            guard try await item.asset.load(.isPlayable) else{throw StoreError.message("This media cannot be played on your device.")}
            try Task.checkCancellation()
            guard store.account?.id==owner else{try? FileManager.default.removeItem(at:local);return}
            file=local;player=AVPlayer(playerItem:item)
            observation=item.observe(\.status,options:[.initial,.new]) { item,_ in
                Task { @MainActor in
                    if item === player?.currentItem,item.status == .failed {
                        cleanup();failure="Playback failed. Try again."
                    }
                }
            }
            if scenePhase == .active{player?.play()}
        } catch {
            if let downloaded=downloaded{try? FileManager.default.removeItem(at:downloaded)}
            if !Task.isCancelled,store.account?.id==owner{failure=error.localizedDescription}
        }
    }
    func cleanup() {
        observation?.invalidate();observation=nil
        player?.pause();player?.replaceCurrentItem(with:nil);player=nil
        if let file=file{try? FileManager.default.removeItem(at:file)}
        file=nil
    }
}

struct PairingScannerSheet:View {
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) var phase
    let received:(String)->Void
    @State private var ready=false
    @State private var failure:String?
    var body:some View {
        NavigationStack {
            VStack(spacing:18) {
                if let failure=failure {
                    ContentUnavailableView("Camera unavailable",systemImage:"camera",description:Text(failure))
                    Button("Enter code manually"){dismiss()}
                } else if ready && phase == .active {
                    PairingCamera(received:received,failed:{failure=$0})
                        .accessibilityLabel("Point the camera at the pairing QR code displayed on your PS5")
                } else {ProgressView("Preparing camera...")}
                Text("Scan the pairing QR code shown by PS5Library. You can review the console selection before linking.").font(.footnote).padding()
            }.navigationTitle("Scan Pairing Code").navigationBarTitleDisplayMode(.inline)
            .toolbar{ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}}}
        }.task {
            guard DataScannerViewController.isSupported else{failure="QR scanning is not supported on this device. Use the displayed pairing code.";return}
            let allowed=await AVCaptureDevice.requestAccess(for:.video)
            guard !Task.isCancelled else{return}
            guard allowed else{failure="Allow camera access in iPhone Settings, or enter the pairing code manually.";return}
            guard DataScannerViewController.isAvailable else{failure="The camera is unavailable or restricted. Enter the code manually.";return}
            ready=true
        }
    }
}
struct PairingCamera:UIViewControllerRepresentable {
    let received:(String)->Void
    let failed:(String)->Void
    func makeUIViewController(context:Context)->PairingCameraController {
        PairingCameraController(received:received,failed:failed)
    }
    func updateUIViewController(_ controller:PairingCameraController,context:Context){}
    static func dismantleUIViewController(_ controller:PairingCameraController,coordinator:()) {controller.scanner.stopScanning()}
}
final class PairingCameraController:UIViewController,DataScannerViewControllerDelegate {
    let scanner=DataScannerViewController(recognizedDataTypes:[.barcode(symbologies:[.qr])],recognizesMultipleItems:false,isHighFrameRateTrackingEnabled:false,isHighlightingEnabled:true)
    let received:(String)->Void
    let failed:(String)->Void
    private var consumed=false
    init(received:@escaping (String)->Void,failed:@escaping (String)->Void) {
        self.received=received;self.failed=failed
        super.init(nibName:nil,bundle:nil)
    }
    required init?(coder:NSCoder){fatalError("Use the programmatic initializer")}
    override func viewDidLoad() {
        super.viewDidLoad();scanner.delegate=self
        addChild(scanner);view.addSubview(scanner.view)
        scanner.view.translatesAutoresizingMaskIntoConstraints=false
        NSLayoutConstraint.activate([
            scanner.view.leadingAnchor.constraint(equalTo:view.leadingAnchor),scanner.view.trailingAnchor.constraint(equalTo:view.trailingAnchor),
            scanner.view.topAnchor.constraint(equalTo:view.topAnchor),scanner.view.bottomAnchor.constraint(equalTo:view.bottomAnchor)
        ])
        scanner.didMove(toParent:self)
    }
    override func viewDidAppear(_ animated:Bool) {
        super.viewDidAppear(animated)
        guard !consumed else{return}
        do{try scanner.startScanning()}catch{failed("Could not start the camera. Try again or enter the pairing code manually.")}
    }
    override func viewWillDisappear(_ animated:Bool) {scanner.stopScanning();super.viewWillDisappear(animated)}
    func dataScanner(_ dataScanner:DataScannerViewController,didAdd addedItems:[RecognizedItem],allItems:[RecognizedItem]) {
        accept(addedItems)
    }
    func dataScanner(_ dataScanner:DataScannerViewController,didUpdate updatedItems:[RecognizedItem],allItems:[RecognizedItem]) {
        accept(updatedItems)
    }
    func dataScanner(_ dataScanner:DataScannerViewController,becameUnavailableWithError error:DataScannerViewController.ScanningUnavailable) {
        scanner.stopScanning();failed("Camera scanning became unavailable. Try again or enter the pairing code manually.")
    }
    private func accept(_ items:[RecognizedItem]) {
        guard !consumed else{return}
        for item in items {
            if case .barcode(let barcode)=item,let payload=barcode.payloadStringValue {
                consumed=true;scanner.stopScanning();received(payload);return
            }
        }
    }
}
