import SwiftUI
import AVKit
import VisionKit
import UIKit

private let accent=Color(red:0.56,green:0.78,blue:1)
private let appBackground=Color(red:0.027,green:0.043,blue:0.067)
private let raisedSurface=Color(red:0.063,green:0.102,blue:0.157)
private let secondaryText=Color(red:0.73,green:0.78,blue:0.84)
private let success=Color(red:0.45,green:0.84,blue:0.68)
private let warning=Color(red:1,green:0.74,blue:0.36)
private let danger=Color(red:1,green:0.51,blue:0.47)

private struct CinematicBackdrop:View {
    var body:some View {
        ZStack {
            appBackground
            LinearGradient(colors:[Color(red:0.035,green:0.061,blue:0.094),appBackground,.black.opacity(0.2)],startPoint:.topTrailing,endPoint:.bottomLeading)
        }.ignoresSafeArea()
    }
}
private struct BrandMark:View {
    var compact=false
    var body:some View {
        HStack(spacing:10) {
            Image(systemName:"gamecontroller.fill").font(compact ? .title3:.title).foregroundStyle(.white)
                .frame(width:compact ? 34:44,height:compact ? 34:44).background(accent.opacity(0.2),in:RoundedRectangle(cornerRadius:12,style:.continuous))
            VStack(alignment:.leading,spacing:0) {
                Text("PS5Library").font(compact ? .headline:.title2.bold()).foregroundStyle(.white)
                if !compact {Text("Games without limits").font(.caption).foregroundStyle(secondaryText)}
            }
        }.accessibilityElement(children:.combine)
    }
}
private struct OfflineBanner:View {
    let text:String
    var body:some View {
        Label(text,systemImage:"wifi.slash").font(.footnote.weight(.semibold)).foregroundStyle(warning)
            .padding(.horizontal,14).frame(maxWidth:.infinity,minHeight:44,alignment:.leading)
            .background(warning.opacity(0.1),in:RoundedRectangle(cornerRadius:14,style:.continuous))
            .overlay{RoundedRectangle(cornerRadius:14,style:.continuous).stroke(warning.opacity(0.25))}
    }
}
private struct SectionHeading:View {
    let title:String;var detail:String?=nil
    var body:some View {
        ViewThatFits(in:.horizontal) {
            HStack(alignment:.firstTextBaseline){Text(title).font(.title2.bold());Spacer();if let detail{Text(detail).font(.caption.weight(.semibold)).foregroundStyle(secondaryText)}}
            VStack(alignment:.leading,spacing:4){Text(title).font(.title2.bold());if let detail{Text(detail).font(.caption.weight(.semibold)).foregroundStyle(secondaryText)}}
        }
    }
}
private struct StatusPill:View {
    let text:String;var color:Color=accent;var icon:String?=nil
    var body:some View {
        HStack(spacing:5){if let icon{Image(systemName:icon)};Text(text)}
            .font(.caption2.weight(.bold)).textCase(.uppercase).tracking(0.5).foregroundStyle(color)
            .padding(.horizontal,9).frame(minHeight:26).background(color.opacity(0.14),in:Capsule())
    }
}
private struct PressableCardStyle:ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration:Configuration)->some View {
        configuration.label.opacity(configuration.isPressed ? 0.84:1).scaleEffect(configuration.isPressed ? 0.985:1)
            .animation(reduceMotion ? nil:.easeOut(duration:0.16),value:configuration.isPressed)
    }
}
private extension View {
    func cinematicCard(padding:CGFloat=16)->some View {
        self.padding(padding).background(raisedSurface.opacity(0.88),in:RoundedRectangle(cornerRadius:18,style:.continuous))
            .overlay{RoundedRectangle(cornerRadius:18,style:.continuous).stroke(.white.opacity(0.08))}
    }
    func cinematicList()->some View {self.scrollContentBackground(.hidden).background(CinematicBackdrop())}
}
@main struct PS5LibraryApp:App {
    @StateObject private var store=Store()
    var body:some Scene{WindowGroup{RootView().environmentObject(store).preferredColorScheme(.dark).tint(accent)}}
}
struct ArtworkView:View {
    @EnvironmentObject var store:Store;@Environment(\.accessibilityReduceMotion) private var reduceMotion;let path:String;@State private var image:UIImage?
    var body:some View{ZStack{LinearGradient(colors:[raisedSurface,appBackground],startPoint:.topLeading,endPoint:.bottomTrailing);Image(systemName:"gamecontroller.fill").font(.largeTitle).foregroundStyle(accent.opacity(0.3));if let image{Image(uiImage:image).resizable().scaledToFill().frame(maxWidth:.infinity,maxHeight:.infinity).transition(.opacity)}}
        .clipped().allowsHitTesting(false).accessibilityHidden(true).task(id:(store.account?.id ?? "")+path){image=nil;guard !path.isEmpty,let api=store.api else{return};do{let data=try await api.artwork(path);let decoded=await Task.detached(priority:.utility){UIImage(data:data)?.preparingForDisplay()}.value;if !Task.isCancelled{withAnimation(reduceMotion ? nil:.easeOut(duration:0.2)){image=decoded}}}catch{}}
    }
}
struct RootView:View {
    @EnvironmentObject var store:Store
    @State private var addAccount=false
    var body:some View {
        Group {if store.account==nil{SignIn()}else{tabs}}
            .sheet(isPresented:$addAccount){SignIn()}
            .alert("PS5Library",isPresented:Binding(get:{store.error != nil},set:{if !$0{store.error=nil}})){Button("OK"){store.error=nil}}message:{Text(store.error ?? "")}
    }
    private var tabs:some View {
        TabView {
            NavigationStack{LibraryView()}.tabItem{Label("Library",systemImage:"rectangle.stack.fill")}
            NavigationStack{DownloadsView()}.tabItem{Label("Downloads",systemImage:"arrow.down.circle")}
            NavigationStack{ProfileView()}.tabItem{Label("My PS5",systemImage:"gamecontroller")}
            settings.tabItem{Label("Settings",systemImage:"gearshape")}
        }.background(CinematicBackdrop())
            .toolbarBackground(appBackground.opacity(0.98),for:.tabBar)
            .toolbarBackground(.visible,for:.tabBar)
            .toolbarColorScheme(.dark,for:.tabBar)
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
                    NavigationLink("Console setup"){ConsolesView().navigationTitle("My PS5s")}
                    NavigationLink("Content Sources"){SourcesView().id(store.account?.id)}
                    NavigationLink("Notifications"){NotificationsView().id(store.account?.id)}
                    NavigationLink("Prepared packages on this server"){CacheView()}
                    if store.account?.role=="ADMIN"{NavigationLink("Community Services"){CommunityConnectionView()};InvitationView()}
                }
                Section{Text("Independent homebrew library. Sony/PSN credentials are never required.").font(.footnote).foregroundStyle(secondaryText)}
            }.cinematicList().navigationTitle("Settings")
        }
    }
}
struct LibraryGameRow:View {
    @EnvironmentObject var store:Store
    @Environment(\.dynamicTypeSize) private var typeSize
    let game:Game;let scope:String;let selected:Bool
    private var tileWidth:CGFloat{typeSize.isAccessibilitySize ? 220:164}
    private var release:Release?{game.releases.first(where:{$0.kind=="BASE"}) ?? game.releases.first(where:{$0.kind != "DLC"}) ?? game.releases.first}
    private var entry:LibraryEntry? {
        let ids=Set(game.releases.map(\.id))
        return store.data.library.first{ids.contains($0.releaseId)&&$0.state=="READY_ON_PS5"}
    }
    private var job:Job? {
        let ids=Set(game.releases.map(\.id))
        return store.data.jobs.first{ids.contains($0.releaseId) && !["COMPLETED","READY_ON_PS5","CANCELLED"].contains($0.state)}
    }
    private var location:String {
        if let job{return job.displayStage}
        if scope=="console" {
            return store.data.consoles.first(where:{$0.id==store.data.consoleId})?.storage.first(where:{$0.id==entry?.storageId})?.displayName ?? "This PS5"
        }
        return game.serverCached ? "Prepared on server":"Available on server"
    }
    private var state:(String,Color) {
        if let job{return (readable(job.state),job.state=="ERROR" ? danger:accent)}
        if scope=="console" {return ("Ready",success)}
        if game.serverCached{return ("Prepared",success)}
        return ("Available",accent)
    }
    var body:some View {
        VStack(alignment:.leading,spacing:7) {
            ArtworkView(path:game.coverUrl).frame(width:tileWidth,height:typeSize.isAccessibilitySize ? 150:126)
                .clipShape(RoundedRectangle(cornerRadius:12,style:.continuous))
                .overlay{RoundedRectangle(cornerRadius:12,style:.continuous).stroke(selected ? accent:.white.opacity(0.08),lineWidth:selected ? 2:1)}
                .shadow(color:.black.opacity(selected ? 0.34:0),radius:12,y:7)
            Text(game.title).font(.subheadline.weight(.semibold)).lineLimit(typeSize.isAccessibilitySize ? 2:1)
            HStack(spacing:6){Circle().fill(state.1).frame(width:6,height:6);Text(location).font(.caption2).foregroundStyle(secondaryText).lineLimit(1)}
        }.frame(width:tileWidth,alignment:.leading).padding(.vertical,4)
            .contentShape(Rectangle())
            .accessibilityElement(children:.ignore)
            .accessibilityLabel("\(game.title), version \(release?.version ?? "unknown"), \(location), \(state.0)")
            .accessibilityAddTraits(selected ? .isSelected:[])
    }
}
private struct LibraryStage:View {
    @EnvironmentObject var store:Store;@Environment(\.dynamicTypeSize) private var typeSize
    let game:Game;let scope:String
    private var release:Release?{game.releases.first(where:{$0.kind=="UPDATE"}) ?? game.releases.first(where:{$0.kind=="BASE"}) ?? game.releases.first}
    private var ready:Bool{game.ready(in:store.data.library)}
    private var status:String{ready ? "Available on this PS5":game.serverCached ? "Ready on your Library Server":"Available on your Library Server"}
    var body:some View {
        ZStack(alignment:.bottomLeading) {
            ArtworkView(path:game.heroUrl).frame(maxWidth:.infinity,minHeight:typeSize.isAccessibilitySize ? 520:430)
            LinearGradient(colors:[.clear,appBackground.opacity(0.72),appBackground],startPoint:.top,endPoint:.bottom)
            LinearGradient(colors:[appBackground.opacity(0.88),.clear],startPoint:.leading,endPoint:.trailing)
            VStack(alignment:.leading,spacing:13) {
                HStack(spacing:8){Circle().fill(ready ? success:accent).frame(width:7,height:7);Text(status).font(.subheadline.weight(.semibold)).foregroundStyle(ready ? success:accent)}
                Text(game.title).font(.largeTitle.bold()).tracking(-0.7).lineLimit(typeSize.isAccessibilitySize ? nil:3)
                if let description=game.description,!description.isEmpty {Text(description).font(.body).foregroundStyle(.white.opacity(0.86)).lineLimit(typeSize.isAccessibilitySize ? 5:3)}
                HStack(spacing:10) {
                    if let version=release?.version{Text("Version \(version)")}
                    Text(scope=="console" ? "PS5":"Library Server")
                }.font(.caption).foregroundStyle(secondaryText)
                NavigationLink(value:game){Text("Open game").font(.headline).frame(minWidth:126,minHeight:48)}
                    .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
            }.padding(.horizontal,20).padding(.bottom,24).frame(maxWidth:560,alignment:.leading)
        }.clipped().accessibilityElement(children:.contain)
    }
}
struct GameDetails:View {
    @EnvironmentObject var store:Store;@Environment(\.dynamicTypeSize) private var dynamicTypeSize;let game:Game;@State private var download=false
    @State private var saving=false
    var saved:Bool{store.data.games.first(where:{$0.id==game.id})?.saved ?? false}
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:24) {
                ZStack(alignment:.bottomLeading) {
                    ArtworkView(path:game.heroUrl)
                    LinearGradient(colors:[.clear,appBackground.opacity(0.35),appBackground],startPoint:.top,endPoint:.bottom)
                    VStack(alignment:.leading,spacing:9) {
                        if store.ready(game){StatusPill(text:"Ready on PS5",color:success,icon:"checkmark.circle.fill")}
                        else if game.serverCached{StatusPill(text:"Cached on server",icon:"shippingbox.fill")}
                        Text(game.title).font(.largeTitle.bold()).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil:3)
                        if let genres=game.genres,!genres.isEmpty {
                            Text(genres.prefix(3).joined(separator:" | ")).font(.subheadline.weight(.semibold)).foregroundStyle(secondaryText)
                        }
                    }.padding(18).padding(.top,dynamicTypeSize.isAccessibilitySize ? 180:150)
                }
                    .frame(maxWidth:.infinity,minHeight:dynamicTypeSize.isAccessibilitySize ? 460:360)
                    .clipShape(RoundedRectangle(cornerRadius:22,style:.continuous))
                    .overlay{RoundedRectangle(cornerRadius:22,style:.continuous).stroke(.white.opacity(0.1))}
                VStack(alignment:.leading,spacing:12) {
                    Button("Download & Prepare",systemImage:"arrow.down.circle.fill"){download=true}
                        .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth:.infinity,minHeight:50)
                        .disabled(game.releases.allSatisfy{$0.sources.isEmpty})
                    Button(saved ? "Remove from Saved Games":"Save Game",systemImage:saved ? "heart.fill":"heart"){saveGame()}
                        .buttonStyle(.bordered).controlSize(.large).frame(maxWidth:.infinity,minHeight:50).disabled(saving||store.offline)
                }
                VStack(alignment:.leading,spacing:12) {
                    SectionHeading(title:"About")
                    Text(game.description ?? "Description unavailable.").font(.body).lineSpacing(4).foregroundStyle(.white.opacity(0.94))
                    if let publisher=game.publisher,!publisher.isEmpty {Label(publisher,systemImage:"building.2").font(.footnote).foregroundStyle(secondaryText)}
                }.cinematicCard()
                GameMediaView(game:store.data.games.first(where:{$0.id==game.id}) ?? game).id((store.account?.id ?? "")+game.id)
                    .frame(maxWidth:.infinity,alignment:.leading).cinematicCard()
                VStack(alignment:.leading,spacing:12) {
                    SectionHeading(title:"Available releases",detail:"\(game.releases.count)")
                    ForEach(game.releases){release in
                        HStack(spacing:12) {
                            Image(systemName:release.kind=="DLC" ? "puzzlepiece.extension.fill":"shippingbox.fill").foregroundStyle(accent).frame(width:24)
                            VStack(alignment:.leading,spacing:3){Text(release.label).font(.subheadline.weight(.semibold)).lineLimit(2);if let firmware=release.minimumFirmware{Text("Firmware \(firmware) or newer").font(.caption).foregroundStyle(secondaryText)}}
                            Spacer(minLength:8);Text(bytes(release.size ?? 0)).font(.caption.monospacedDigit()).foregroundStyle(secondaryText)
                        }.padding(14).background(.white.opacity(0.055),in:RoundedRectangle(cornerRadius:14,style:.continuous))
                    }
                }.cinematicCard()
                if let screenshots=game.screenshotUrls,!screenshots.isEmpty {
                    VStack(alignment:.leading,spacing:12) {
                        SectionHeading(title:"Screenshots",detail:"\(screenshots.count)")
                        ScrollView(.horizontal,showsIndicators:false){LazyHStack(spacing:14){ForEach(screenshots,id:\.self){path in Color.clear.frame(width:280).aspectRatio(16/9,contentMode:.fit).overlay{ArtworkView(path:path)}.clipShape(RoundedRectangle(cornerRadius:14,style:.continuous)).overlay{RoundedRectangle(cornerRadius:14,style:.continuous).stroke(.white.opacity(0.08))}}}.scrollClipDisabled()}
                    }
                }
            }.padding(.horizontal,18).padding(.top,8).padding(.bottom,28)
        }.background(CinematicBackdrop()).navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented:$download){InstallationView(game:game)}
    }
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
                        if plan.storage.allSatisfy({!$0.allowed}){Text("No supported destination has enough free space.").foregroundStyle(warning)}
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
                if let failure=failure{Text(failure).foregroundStyle(warning);Button("Check again"){Task{await loadPlan()}}.disabled(planning)}
                if store.offline{Label("Connect to the server to prepare a download.",systemImage:"wifi.slash").foregroundStyle(warning)}
                if busy{ProgressView("Submitting installation...")}
            }.disabled(busy).cinematicList().navigationTitle("Download")
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
    private var activeJobs:[Job]{store.data.jobs.filter{!["COMPLETED","READY_ON_PS5","ERROR","CANCELLED"].contains($0.state)}}
    private var activeSpeed:Int64{activeJobs.reduce(0){$0+$1.speedBytesPerSecond}}
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                if store.offline{OfflineBanner(text:"Server offline - progress is from the last sync")}
                VStack(alignment:.leading,spacing:8) {
                    Text("Preparation and transfer continue safely on your server.").font(.subheadline).foregroundStyle(secondaryText)
                    if !activeJobs.isEmpty {
                        HStack(alignment:.firstTextBaseline) {
                            Text(activeSpeed>0 ? bytes(activeSpeed)+"/s":"Working").font(.title2.bold().monospacedDigit())
                            Spacer()
                            Text("\(activeJobs.count) active").font(.caption.weight(.semibold)).foregroundStyle(secondaryText)
                        }.padding(.top,12)
                    }
                }.padding(.vertical,18)
                if let installations=store.data.installations,!installations.isEmpty {
                    SectionHeading(title:"Installations",detail:"\(installations.count)")
                        .padding(.top,18).padding(.bottom,8)
                    ForEach(installations){item in
                        VStack(alignment:.leading,spacing:10) {
                            HStack(alignment:.top) {
                                VStack(alignment:.leading,spacing:5) {
                                    Text(item.title).font(.headline)
                                    if let console=store.data.consoles.first(where:{$0.id==item.consoleId}) {
                                        Text(console.name+" | "+(console.storage.first(where:{$0.id==item.storageId})?.displayName ?? item.storageId)).font(.caption).foregroundStyle(secondaryText)
                                    }
                                }
                                Spacer()
                                StatusPill(text:readable(item.state),color:item.error==nil ? accent:danger)
                            }
                            Label(item.method=="SHADOWMOUNT" ? "ShadowMountPlus":readable(item.method),systemImage:"shippingbox.fill").font(.caption).foregroundStyle(secondaryText)
                            if let error=item.error{Label(readable(error),systemImage:"exclamationmark.triangle.fill").font(.footnote).foregroundStyle(danger)}
                        }.padding(.vertical,18).overlay(alignment:.bottom){Divider().overlay(.white.opacity(0.1))}
                    }
                }
                if !store.data.jobs.isEmpty{SectionHeading(title:"Server jobs",detail:"\(store.data.jobs.count)").padding(.top,24).padding(.bottom,8)}
                ForEach(store.data.jobs){JobCard(job:$0)}
                if store.data.jobs.isEmpty && (store.data.installations ?? []).isEmpty {
                    ContentUnavailableView("No active downloads",systemImage:"checkmark.circle",description:Text("Downloads keep running on your server when you close the companion."))
                        .frame(maxWidth:.infinity,minHeight:320).cinematicCard()
                }
            }.padding(.horizontal,20).padding(.bottom,24)
        }.background(CinematicBackdrop()).navigationTitle("Downloads").refreshable{await store.refresh()}
    }
}
struct JobCard:View {
    @EnvironmentObject var store:Store;let job:Job
    private var accessibilityTitle:String{job.title ?? "Selected release"}
    private var game:Game?{store.data.games.first(where:{$0.releases.contains(where:{$0.id==job.releaseId})})}
    private var stateColor:Color{job.state=="ERROR" ? danger:["COMPLETED","READY_ON_PS5"].contains(job.state) ? success:accent}
    private var byteProgress:Double?{guard let total=job.totalBytes,total>0 else{return nil};return min(1,max(0,Double(job.downloadedBytes)/Double(total)))}
    private var shownProgress:Double?{job.kind=="BUILD" ? job.progress?.fraction:byteProgress}
    var body:some View {
        VStack(alignment:.leading,spacing:14) {
            HStack(alignment:.top,spacing:14) {
                if let game {
                    ArtworkView(path:game.coverUrl).frame(width:70,height:94).clipShape(RoundedRectangle(cornerRadius:10,style:.continuous))
                } else {
                    Image(systemName:"arrow.down.circle.fill").font(.title).foregroundStyle(accent).frame(width:70,height:94).background(.white.opacity(0.05),in:RoundedRectangle(cornerRadius:10))
                }
                VStack(alignment:.leading,spacing:7) {
                    Text(job.title ?? "Selected release").font(.headline).lineLimit(2)
                    StatusPill(text:readable(job.state),color:stateColor)
                    if job.state=="QUEUED",let position=job.queuePosition{Text("Queue position \(position)").font(.caption).foregroundStyle(secondaryText)}
                    if let console=store.data.consoles.first(where:{$0.id==job.consoleId}) {
                        Label(console.name,systemImage:"gamecontroller.fill").font(.caption)
                        if let destination=console.storage.first(where:{$0.id==job.storageId})?.displayName{Text(destination).font(.caption).foregroundStyle(secondaryText)}
                    }
                }
                Spacer(minLength:0)
                if let shownProgress{Text("\(Int(shownProgress*100))%").font(.title2.bold().monospacedDigit()).foregroundStyle(.white)}
            }
            if job.kind=="BUILD" && job.state != "DOWNLOADING" {
                if job.state=="COMPLETED"{Label("Prepared and verified",systemImage:"checkmark.circle.fill").foregroundStyle(success)}
                else if let progress=job.progress?.fraction,let detail=job.progress?.bytes {
                    ProgressView(value:progress).tint(stateColor).accessibilityLabel("\(accessibilityTitle), \(job.displayStage)").accessibilityValue("\(Int(progress*100)) percent, \(bytes(detail.completedBytes)) of \(bytes(detail.totalBytes))")
                    Text(bytes(detail.completedBytes)+" / "+bytes(detail.totalBytes)).font(.caption.monospacedDigit()).foregroundStyle(secondaryText)
                } else if job.state != "ERROR"{ProgressView().tint(accent)}
                Text(job.displayStage).font(.caption).foregroundStyle(secondaryText)
                if store.account?.role=="ADMIN",let detail=job.progress {
                    HStack(spacing:14) {
                        if let package=detail.package?.state{Label((detail.package?.method.map{readable($0)+" "} ?? "Package ")+readable(package),systemImage:"shippingbox.fill")}
                        if let fakelib=detail.fakelib?.state,!(["UNKNOWN","NOT_REQUIRED"].contains(fakelib)){Label("Backport "+readable(fakelib),systemImage:"puzzlepiece.extension.fill")}
                    }.font(.caption2).foregroundStyle(secondaryText)
                }
            } else if let progress=byteProgress {
                ProgressView(value:progress).tint(stateColor).accessibilityLabel("\(accessibilityTitle), \(job.displayStage)").accessibilityValue("\(Int(progress*100)) percent, \(bytes(job.downloadedBytes)) of \(bytes(job.totalBytes ?? 0))")
                HStack {
                    Text(bytes(job.downloadedBytes)+" / "+bytes(job.totalBytes ?? 0))
                    Spacer()
                    if job.speedBytesPerSecond>0{Text(bytes(job.speedBytesPerSecond)+"/s")}
                }.font(.caption.monospacedDigit()).foregroundStyle(secondaryText)
                if let seconds=job.etaSeconds{Text("About \(seconds/60)m \(seconds%60)s remaining").font(.caption).foregroundStyle(secondaryText)}
            } else if !["ERROR","COMPLETED","CANCELLED"].contains(job.state) {
                ProgressView().tint(accent)
            }
            if let error=job.error{Label(readable(error),systemImage:"exclamationmark.triangle.fill").font(.footnote.weight(.semibold)).foregroundStyle(danger)}
            if let location=job.location{Label(location,systemImage:"folder").font(.caption).foregroundStyle(secondaryText).textSelection(.enabled)}
            if job.retryable{Button("Retry",systemImage:"arrow.clockwise"){control("retry")}.buttonStyle(.borderedProminent).controlSize(.large)}
            else if job.kind=="DOWNLOAD" && !["COMPLETED","CANCELLED"].contains(job.state){
                HStack {
                    Button(job.state=="PAUSED" ? "Resume":"Pause",systemImage:job.state=="PAUSED" ? "play.fill":"pause.fill"){control(job.state=="PAUSED" ? "resume":"pause")}.buttonStyle(.bordered).controlSize(.large)
                    Button("Cancel",role:.destructive){control("cancel")}.buttonStyle(.bordered).controlSize(.large)
                }
            }
            if job.dismissible{Button("Remove from Downloads",role:.destructive){dismiss()}.font(.footnote.weight(.semibold)).frame(minHeight:44)}
        }.padding(.vertical,20).overlay(alignment:.bottom){Divider().overlay(.white.opacity(0.1))}
    }
    func control(_ action:String){store.perform{api in let _:Acknowledgement=try await api.request("/jobs/\(job.id)/control",method:"POST",json:["action":action])}}
    func dismiss(){store.perform{api in let _:Acknowledgement=try await api.request("/jobs/\(job.id)",method:"DELETE")}}
}
struct ConsolesView:View {
    @EnvironmentObject var store:Store
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:18) {
                if store.offline{OfflineBanner(text:"Server offline - console status may be out of date")}
                PairingView()
                SectionHeading(title:"Your consoles",detail:"\(store.data.consoles.count)")
                if store.data.consoles.isEmpty {
                    ContentUnavailableView("No PS5 connected",systemImage:"gamecontroller",description:Text("Open PS5Library on your console and pair it with the code or QR scanner above."))
                        .frame(maxWidth:.infinity,minHeight:260).cinematicCard()
                }
                ForEach(store.data.consoles){console in ConsoleCard(console:console)}
            }.padding(.horizontal,18).padding(.vertical,14)
        }.background(CinematicBackdrop()).id(store.account?.id).refreshable{await store.refresh()}
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
        VStack(alignment:.leading,spacing:14) {
            HStack {
                Image(systemName:"link.circle.fill").font(.title2).foregroundStyle(accent)
                VStack(alignment:.leading,spacing:2){Text("Connect a PS5").font(.headline);Text("Use the code shown by PS5Library").font(.caption).foregroundStyle(secondaryText)}
            }
            TextField("10-character pairing code",text:$code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                .font(.body.monospaced()).padding(.horizontal,14).frame(minHeight:48).background(.white.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                .accessibilityHint("Enter the pairing code displayed on your PS5")
            Button("Scan pairing QR code",systemImage:"qrcode.viewfinder"){scanning=true}.buttonStyle(.bordered).disabled(store.offline)
            Picker("Connect to",selection:$consoleId) {
                Text("Register a new PS5").tag("")
                ForEach(store.data.consoles){Text($0.name).tag($0.id)}
            }
            Text("Choose an existing PS5 for a storefront code. An agent code registers a new console.").font(.caption).foregroundStyle(secondaryText)
            Button(busy ? "Linking...":"Link to my account",systemImage:"link"){claim()}
                .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth:.infinity,minHeight:48)
                .disabled(busy||pairingCode(code)==nil||store.offline||(scannedFrontend==true && consoleId.isEmpty))
            if let failure{Label(failure,systemImage:"exclamationmark.triangle.fill").font(.footnote).foregroundStyle(warning)}
        }.cinematicCard().disabled(busy)
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
    @State private var remotePlay=false
    private var online:Bool{console.presence=="ONLINE"}
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            HStack(alignment:.top,spacing:12) {
                Image(systemName:"gamecontroller.fill").font(.title2).foregroundStyle(.white).frame(width:46,height:46).background(accent.opacity(0.18),in:RoundedRectangle(cornerRadius:14))
                VStack(alignment:.leading,spacing:4) {
                    HStack(spacing:7){Text(console.name).font(.title3.bold());Circle().fill(online ? success:Color.secondary).frame(width:8,height:8).accessibilityHidden(true)}
                    Text(readable(console.presence)).font(.caption.weight(.semibold)).foregroundStyle(online ? success:secondaryText)
                }
                Spacer()
                if console.isDefault{StatusPill(text:"Default",color:accent,icon:"star.fill")}
            }
            HStack(spacing:8) {
                StatusPill(text:"FW "+(console.firmware ?? "Unknown"),color:secondaryText)
                StatusPill(text:"\(console.games) games",color:secondaryText)
            }
            if console.storage.isEmpty {
                Label("Storage information unavailable",systemImage:"externaldrive.badge.questionmark").font(.footnote).foregroundStyle(secondaryText)
            }
            ForEach(console.storage){storage in
                VStack(alignment:.leading,spacing:7) {
                    HStack{Text(storage.displayName).font(.subheadline.weight(.semibold));Spacer();Text(bytes(storage.freeBytes)+" free").font(.caption.monospacedDigit()).foregroundStyle(secondaryText)}
                    ProgressView(value:storage.totalBytes>0 ? min(1,max(0,1-Double(storage.freeBytes)/Double(storage.totalBytes))):0).tint(accent)
                        .accessibilityLabel("\(storage.displayName) storage used").accessibilityValue("\(bytes(max(0,storage.totalBytes-storage.freeBytes))) used, \(bytes(storage.freeBytes)) free")
                }.padding(12).background(.white.opacity(0.05),in:RoundedRectangle(cornerRadius:12,style:.continuous))
            }
            if console.capabilities?.remotePlayPairing == true {
                Button("Pair a Remote Play client",systemImage:"play.rectangle.on.rectangle"){remotePlay=true}
                    .buttonStyle(.borderedProminent).disabled(!online)
            }
            Menu("Manage console",systemImage:"ellipsis.circle") {
                Button("Rename",systemImage:"pencil"){name=console.name;editing=true}
                if !console.isDefault{Button("Make default PS5",systemImage:"star"){update(ConsoleUpdate(isDefault:true))}}
                Button("Refresh firmware",systemImage:"arrow.clockwise"){refreshFirmware()}
                Button("Revoke console access",systemImage:"lock.slash",role:.destructive){revoking=true}
            }.frame(minHeight:44)
            if busy{ProgressView()}
            if !message.isEmpty{Text(message).font(.caption).foregroundStyle(secondaryText).accessibilityLabel(message)}
        }.cinematicCard().disabled(busy||store.offline)
        .alert("Console name",isPresented:$editing) {
            TextField("Name",text:$name)
            Button("Save"){if let valid=consoleName(name){update(ConsoleUpdate(name:valid))}}.disabled(consoleName(name)==nil)
            Button("Cancel",role:.cancel){}
        } message:{Text("Use 1 to 80 characters.")}
        .confirmationDialog("Revoke access for \(console.name)?",isPresented:$revoking,titleVisibility:.visible) {
            Button("Revoke access",role:.destructive){revoke()}
            Button("Cancel",role:.cancel){}
        } message:{Text("This disconnects this console's agent and storefront. Games remain on the console. Reconnecting requires resetting its device identity and pairing again.")}
        .sheet(isPresented:$remotePlay){NavigationStack{RemotePlayPairingView(console:console)}}
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
struct RemotePlayPairingView:View {
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) private var dismiss
    let console:Console
    @State private var pairing:RemotePlayPairing?
    @State private var failure:String?
    var body:some View {
        ScrollView {VStack(alignment:.leading,spacing:20) {
            Text(console.name).font(.title.bold())
            if let pairing {
                switch pairing.state {
                case "REQUESTED": ProgressView("Asking the PS5 for a native Remote Play PIN…")
                case "READY":
                    Text("REMOTE PLAY PIN").font(.caption.bold()).foregroundStyle(accent)
                    Text(pairing.pin ?? "").font(.system(.largeTitle,design:.monospaced).weight(.bold)).textSelection(.enabled)
                    Button("Copy PIN",systemImage:"doc.on.doc"){UIPasteboard.general.string=pairing.pin}.buttonStyle(.borderedProminent)
                    Text("ACCOUNT ID").font(.caption.bold()).foregroundStyle(.secondary)
                    Text(pairing.accountId ?? "").font(.body.monospaced()).textSelection(.enabled)
                    Button("Copy account ID",systemImage:"doc.on.doc"){UIPasteboard.general.string=pairing.accountId}.buttonStyle(.bordered)
                    Text("On a PC connected to the same private network, open chiaki-ng, add this PS5, and enter the account ID and PIN. Remote Play must already be enabled under PS5 Settings > System > Remote Play. The PIN expires after five minutes.").foregroundStyle(.secondary)
                case "PAIRED": Label("Remote Play client paired",systemImage:"checkmark.circle.fill").foregroundStyle(success)
                default: Label(readable(pairing.error ?? pairing.state),systemImage:"exclamationmark.triangle.fill").foregroundStyle(warning)
                }
            } else if let failure { Label(failure,systemImage:"exclamationmark.triangle.fill").foregroundStyle(warning) }
            else { ProgressView("Starting native Remote Play pairing…") }
        }.padding(24).frame(maxWidth:.infinity,alignment:.leading)}.background(CinematicBackdrop()).navigationTitle("Remote Play").toolbar{ToolbarItem(placement:.cancellationAction){Button("Close"){dismiss()}}}
            .task{await pair()}
    }
    func pair() async {
        guard let api=store.api else{return};let owner=store.account?.id
        do {
            var value:RemotePlayPairing=try await api.request("/consoles/\(console.id)/remote-play/pairing",method:"POST")
            guard store.account?.id==owner else{return};pairing=value
            while store.account?.id==owner && ["REQUESTED","READY"].contains(value.state) {
                try await Task.sleep(nanoseconds:1_000_000_000)
                value=try await api.request("/consoles/\(console.id)/remote-play/pairing/\(value.id)")
                if store.account?.id==owner{pairing=value}
            }
        } catch is CancellationError {} catch { if store.account?.id==owner{failure=error.localizedDescription} }
    }
}
struct CacheView:View{@EnvironmentObject var store:Store;@State private var artifacts:[Artifact]=[];var body:some View{List{Section{Text("Verified packages stay on your PC for reuse. Deleting a cached copy keeps the original source and your console's copy.").font(.footnote)};ForEach(artifacts){artifact in VStack(alignment:.leading){Text(artifact.title).font(.headline);Text(artifact.version+" · "+bytes(artifact.size)).font(.caption)}.swipeActions{Button("Delete PC copy",role:.destructive){store.perform{api in let _:Acknowledgement=try await api.request("/artifacts/\(artifact.id)",method:"DELETE");artifacts=try await api.request("/artifacts")}}}}}.cinematicList().navigationTitle("Server cache").task{guard let api=store.api else{return};do{artifacts=try await api.request("/artifacts")}catch{store.error=error.localizedDescription}}}}
struct LibraryView:View {
    @EnvironmentObject var store:Store
    @State private var scope="server"
    @State private var storageId=""
    @State private var query=""
    @State private var savedOnly=false
    @State private var selectedGameId:String?
    var games:[Game] {
        let available = scope=="server" ? GameCollection.server.select(store.data.games) : store.data.games.filter{$0.ready(in:store.data.library,storageId:storageId)}
        return available.filter { game in
            (!savedOnly || game.saved==true) && (query.isEmpty || ([game.title,game.titleId,game.publisher ?? ""]+(game.genres ?? [])).joined(separator:" ").localizedCaseInsensitiveContains(query))
        }.sorted{$0.title.localizedStandardCompare($1.title) == .orderedAscending}
    }
    private var storageName:String {
        guard !storageId.isEmpty else{return "All storage"}
        return store.data.consoles.first(where:{$0.id==store.data.consoleId})?.storage.first(where:{$0.id==storageId})?.displayName ?? "Storage"
    }
    private var selectedGame:Game?{games.first(where:{$0.id==selectedGameId}) ?? games.first}
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                VStack(alignment:.leading,spacing:12) {
                    Picker("Location",selection:$scope) {
                        Label("This PS5",systemImage:"gamecontroller.fill").tag("console")
                        Label("Server",systemImage:"server.rack").tag("server")
                    }.pickerStyle(.segmented)
                    if scope=="console",!store.data.consoles.isEmpty {
                        HStack(spacing:8) {
                            ConsolePicker().pickerStyle(.menu).frame(maxWidth:.infinity,alignment:.leading)
                            Menu {
                                Button("All storage"){storageId=""}
                                ForEach(store.data.consoles.first(where:{$0.id==store.data.consoleId})?.storage ?? []) { storage in
                                    Button(storage.displayName){storageId=storage.id}
                                }
                            } label: {
                                Label(storageName,systemImage:"externaldrive.fill").font(.subheadline.weight(.semibold))
                                    .padding(.horizontal,12).frame(minHeight:44).background(.white.opacity(0.07),in:Capsule())
                            }
                        }
                    }
                    if store.offline { OfflineBanner(text:"Server offline - showing the last synced library") }
                }.padding(.horizontal,18).padding(.vertical,12)
                if store.loading && store.data.games.isEmpty {
                    ProgressView("Syncing library...").frame(maxWidth:.infinity,minHeight:220)
                } else if games.isEmpty {
                    ContentUnavailableView(query.isEmpty ? (savedOnly ? "No saved games here":"No games here yet"):"No matches",systemImage:savedOnly ? "heart":"rectangle.stack",description:Text(query.isEmpty ? (scope=="console" ? "Sync this console's inventory, or switch to Server to see available games.":"Add authorized content to your Library Server to see it here."):"Try another title, publisher, or genre."))
                        .frame(maxWidth:.infinity,minHeight:300).padding(.horizontal,18)
                } else if let selectedGame {
                    LibraryStage(game:selectedGame,scope:scope)
                    VStack(alignment:.leading,spacing:14) {
                        HStack(alignment:.firstTextBaseline) {
                            VStack(alignment:.leading,spacing:3) {
                                Text(scope=="console" ? "On this PS5":"On this server").font(.title2.bold())
                                Text(scope=="console" ? "Installed games reported by your console":"Authorized content available from your Library Server").font(.caption).foregroundStyle(secondaryText)
                            }
                            Spacer()
                            Text("\(games.count) \(games.count==1 ? "game":"games")").font(.caption.weight(.semibold)).foregroundStyle(secondaryText)
                        }
                        ScrollView(.horizontal,showsIndicators:false) {
                            LazyHStack(alignment:.top,spacing:14) {
                                ForEach(games) { game in
                                    Button{withAnimation(.easeOut(duration:0.18)){selectedGameId=game.id}}label:{LibraryGameRow(game:game,scope:scope,selected:game.id==selectedGame.id)}
                                        .buttonStyle(PressableCardStyle())
                                }
                            }.scrollTargetLayout()
                        }.scrollTargetBehavior(.viewAligned).contentMargins(.horizontal,1,for:.scrollContent)
                    }
                    .padding(.horizontal,18).padding(.top,24).padding(.bottom,30)
                }
            }
        }
        .background(CinematicBackdrop()).navigationTitle("Library")
        .searchable(text:$query,prompt:"Search games")
        .toolbar {
            ToolbarItem(placement:.topBarTrailing) {
                Button{savedOnly.toggle()}label:{Image(systemName:savedOnly ? "heart.fill":"heart")}
                    .foregroundStyle(savedOnly ? accent:Color.primary)
                    .accessibilityLabel(savedOnly ? "Show all games":"Show saved games only")
                    .accessibilityAddTraits(savedOnly ? .isSelected:[])
            }
        }
        .navigationDestination(for:Game.self){GameDetails(game:$0)}
        .onChange(of:store.data.consoleId){_,_ in storageId="";selectedGameId=nil}
        .onChange(of:scope){_,_ in storageId="";selectedGameId=nil}
        .onChange(of:games.map(\.id)){_,ids in if !ids.contains(selectedGameId ?? ""){selectedGameId=ids.first}}
        .refreshable{await store.refresh()}
    }
}
private struct TrophyTile:View {
    let name:String;let count:Int;let color:Color
    var body:some View {
        VStack(spacing:6) {
            Image(systemName:"trophy.fill").foregroundStyle(color)
            Text(String(count)).font(.title3.bold().monospacedDigit())
            Text(name).font(.caption2).foregroundStyle(secondaryText)
        }.frame(maxWidth:.infinity,minHeight:76).background(.white.opacity(0.05),in:RoundedRectangle(cornerRadius:12,style:.continuous))
        .accessibilityElement(children:.ignore).accessibilityLabel("\(count) \(name) trophies")
    }
}
struct ProfileView:View {
    @EnvironmentObject var store:Store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var profile:Profile?
    @State private var failure:String?
    @State private var busy=false
    private let trophyColumns=[GridItem(.adaptive(minimum:64),spacing:8)]
    var body:some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                if let profile {
                    let selected=selectedConsole(in:profile)
                    let hero=selected?.games.compactMap{profileGame in store.data.games.first(where:{$0.id==profileGame.gameId})?.heroUrl}.first
                    ZStack(alignment:.bottomLeading) {
                        if let hero{ArtworkView(path:hero).opacity(0.42)}
                        LinearGradient(colors:[.clear,appBackground.opacity(0.76),appBackground],startPoint:.top,endPoint:.bottom)
                        HStack(spacing:18) {
                            Group {
                                if let path=profile.avatarUrl { ArtworkView(path:path) }
                                else {Image(systemName:"person.fill").font(.title).foregroundStyle(accent)}
                            }.frame(width:84,height:84).background(raisedSurface).clipShape(Circle()).overlay{Circle().stroke(.white.opacity(0.86),lineWidth:2)}
                            VStack(alignment:.leading,spacing:6) {
                                Text(profile.username).font(.largeTitle.bold()).tracking(-0.6)
                                if let console=selected,let live=store.data.consoles.first(where:{$0.id==console.id}) {
                                    HStack(spacing:8){Circle().fill(live.presence=="ONLINE" ? success:Color.secondary).frame(width:7,height:7);Text(console.name+" · "+readable(live.presence)).font(.subheadline).foregroundStyle(secondaryText)}
                                } else {Text(readable(profile.role)).font(.subheadline).foregroundStyle(secondaryText)}
                            }
                            Spacer(minLength:0)
                        }
                        .padding(.horizontal,20).padding(.bottom,24)
                    }.frame(maxWidth:.infinity,minHeight:220).clipped()
                    HStack(spacing:10) {
                        Menu("Edit profile",systemImage:"camera.fill") {
                            Button("Use default",role:.destructive){changeAvatar(nil)}
                            ForEach(store.data.games){game in Button(game.title){changeAvatar(game.coverUrl)}}
                        }.buttonStyle(.bordered).controlSize(.large).disabled(busy||store.offline)
                        NavigationLink { CommunityFriendsView() } label: {Label("Friends",systemImage:"person.2.fill").frame(maxWidth:.infinity,minHeight:44)}.buttonStyle(.borderedProminent)
                    }.padding(.horizontal,20).padding(.bottom,22)
                    if profile.consoles.count>1 {
                        Picker("Console",selection:$store.data.consoleId){ForEach(profile.consoles){Text($0.name).tag($0.id)}}
                            .pickerStyle(.menu).controlSize(.large).padding(.horizontal,20).padding(.bottom,12)
                    }
                    if selected==nil {
                        ContentUnavailableView("No consoles on this profile",systemImage:"gamecontroller",description:Text("Pair a PS5 to see its games, trophies, and saves."))
                            .frame(maxWidth:.infinity,minHeight:260).padding(.horizontal,20)
                    }
                    if let console=selected {
                        let live=store.data.consoles.first(where:{$0.id==console.id})
                        VStack(alignment:.leading,spacing:20) {
                            HStack{Image(systemName:"gamecontroller.fill").foregroundStyle(accent);Text(console.name).font(.title2.bold());Spacer();StatusPill(text:readable(live?.presence ?? "OFFLINE"),color:live?.presence=="ONLINE" ? success:secondaryText)}
                            LazyVGrid(columns:[GridItem(.flexible()),GridItem(.flexible())],spacing:0) {
                                profileFact("Status",live?.presence=="ONLINE" ? "Connected":readable(live?.presence ?? "OFFLINE"))
                                profileFact("Firmware",live?.firmware ?? "Not reported")
                                profileFact("Library","\(live?.games ?? console.games.filter(\.available).count) games")
                                profileFact("Runtime",live?.runtime ?? "Not reported")
                            }.overlay{Rectangle().stroke(.white.opacity(0.1),lineWidth:1)}
                            if let storage=live?.storage,!storage.isEmpty {
                                SectionHeading(title:"Storage")
                                ForEach(storage){volume in
                                    VStack(alignment:.leading,spacing:9) {
                                        HStack{Text(volume.displayName).font(.headline);Spacer();Text(bytes(volume.freeBytes)+" free").font(.caption.monospacedDigit()).foregroundStyle(secondaryText)}
                                        ProgressView(value:volume.totalBytes>0 ? min(1,max(0,1-Double(volume.freeBytes)/Double(volume.totalBytes))):0).tint(accent)
                                            .accessibilityLabel("\(volume.displayName) storage used").accessibilityValue("\(bytes(max(0,volume.totalBytes-volume.freeBytes))) used, \(bytes(volume.freeBytes)) free")
                                    }.padding(16).background(raisedSurface.opacity(0.76),in:RoundedRectangle(cornerRadius:14,style:.continuous))
                                }
                            }
                        if let summary=console.trophySummary {
                            SectionHeading(title:"Trophies")
                            LazyVGrid(columns:trophyColumns,spacing:8) {
                                TrophyTile(name:"Platinum",count:summary.earnedTrophies.platinum,color:accent)
                                TrophyTile(name:"Gold",count:summary.earnedTrophies.gold,color:Color(red:1,green:0.78,blue:0.3))
                                TrophyTile(name:"Silver",count:summary.earnedTrophies.silver,color:Color(red:0.76,green:0.82,blue:0.9))
                                TrophyTile(name:"Bronze",count:summary.earnedTrophies.bronze,color:Color(red:0.82,green:0.48,blue:0.27))
                            }
                            Text("Local summary from \(Date(timeIntervalSince1970:summary.modifiedAt).formatted(date:.abbreviated,time:.shortened))").font(.caption).foregroundStyle(secondaryText)
                        } else {
                            Label("Trophy summary unavailable",systemImage:"trophy").font(.footnote).foregroundStyle(secondaryText)
                        }
                        NavigationLink { SaveBackupsView(console:console) } label: {
                            Label("Save backups",systemImage:"externaldrive.badge.timemachine").font(.headline).frame(maxWidth:.infinity,minHeight:46)
                        }.buttonStyle(.bordered)
                        if !console.games.isEmpty {
                            SectionHeading(title:"Games",detail:"\(console.games.filter(\.available).count) available")
                            ScrollView(.horizontal,showsIndicators:false) {
                                LazyHStack(alignment:.top,spacing:12) {
                                    ForEach(console.games){game in
                                        Group {
                                            if let catalog=store.data.games.first(where:{$0.id==game.gameId}) {NavigationLink{GameDetails(game:catalog)}label:{profileGameTile(game)}}
                                            else {profileGameTile(game)}
                                        }.buttonStyle(PressableCardStyle())
                                    }
                                }
                            }.scrollTargetBehavior(.viewAligned)
                        }
                        }.padding(.horizontal,20).padding(.vertical,26).overlay(alignment:.bottom){Divider().overlay(.white.opacity(0.1))}
                    }
                } else if failure==nil {
                    ProgressView("Loading profile...").frame(maxWidth:.infinity,minHeight:300)
                }
                if let failure {
                    VStack(spacing:12){Label(failure,systemImage:"exclamationmark.triangle.fill").foregroundStyle(warning);Button("Retry"){Task{await load()}}.buttonStyle(.borderedProminent)}.frame(maxWidth:.infinity).cinematicCard()
                }
            }.padding(.bottom,24)
        }.background(CinematicBackdrop()).navigationTitle("My Profile").task{await load()}.refreshable{await load()}
    }
    private func selectedConsole(in profile:Profile)->ProfileConsole? {
        profile.consoles.first(where:{$0.id==store.data.consoleId}) ?? profile.consoles.first
    }
    private func profileFact(_ label:String,_ value:String)->some View {
        VStack(alignment:.leading,spacing:7){Text(label).font(.caption).foregroundStyle(secondaryText);Text(value).font(.subheadline.weight(.semibold)).lineLimit(2)}
            .frame(maxWidth:.infinity,minHeight:76,alignment:.leading).padding(.horizontal,14).overlay(alignment:.trailing){Divider().overlay(.white.opacity(0.08))}.overlay(alignment:.bottom){Divider().overlay(.white.opacity(0.08))}
    }
    private func profileGameTile(_ game:ProfileGame)->some View {
        let width:CGFloat=typeSize.isAccessibilitySize ? 210:148
        return VStack(alignment:.leading,spacing:7){ArtworkView(path:game.coverUrl).frame(width:width,height:typeSize.isAccessibilitySize ? 132:96).clipShape(RoundedRectangle(cornerRadius:10,style:.continuous));Text(game.title).font(.caption.weight(.semibold)).lineLimit(typeSize.isAccessibilitySize ? 2:1);Text(game.available ? "Available":"Missing").font(.caption2).foregroundStyle(game.available ? success:secondaryText)}.frame(width:width,alignment:.leading)
    }
    func load() async {
        guard let api=store.api else{return};let owner=store.account?.id
        do {
            let result:Profile=try await api.request("/profile")
            guard !Task.isCancelled,store.account?.id==owner else{return}
            profile=result;if !result.consoles.contains(where:{$0.id==store.data.consoleId}){store.data.consoleId=result.consoles.first?.id ?? ""};failure=nil
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
struct CommunityFriendsView:View {
    @EnvironmentObject var store:Store
    @State private var status:CommunityAccountStatus?
    @State private var friends:[CommunityFriend]=[]
    @State private var requests=CommunityFriendRequests(incoming:[],outgoing:[])
    @State private var handle=""
    @State private var busy=false
    @State private var failure:String?
    var body:some View {
        List {
            Section("Community account") {
                if let account=status?.account {LabeledContent("Connected as",value:"@"+account.handle);Text(account.displayName).foregroundStyle(.secondary)}
                else {LabeledContent("State",value:readable(status?.state ?? "DISCONNECTED"))}
                if status?.configured==false {Text("Community services are not configured on this Library Node.").foregroundStyle(.secondary)}
                else if status?.state=="DISCONNECTED" {Button("Connect Community account"){connect()}.disabled(busy||store.offline)}
                else if status?.state=="AWAITING_OWNER" {
                    if let code=status?.userCode {Text(code).font(.system(.title2,design:.monospaced).weight(.bold)).tracking(3).textSelection(.enabled)}
                    if let location=status?.verificationUriComplete,let url=URL(string:location){Link("Sign in with passkey and authorize",destination:url)}
                    Button("Check authorization"){Task{await refreshLink()}}.disabled(busy)
                }
                if ["CONNECTED","DISCONNECT_PENDING"].contains(status?.state ?? "") {Button(status?.state=="DISCONNECT_PENDING" ? "Retry disconnect":"Disconnect Community account",role:.destructive){disconnect()}.disabled(busy)}
                if let error=status?.error {Text(readable(error)).foregroundStyle(warning)}
            }
            if status?.state=="CONNECTED" {
                Section("Add friend") {HStack{TextField("Exact handle",text:$handle).textInputAutocapitalization(.never).autocorrectionDisabled();Button("Send"){addFriend()}.disabled(busy||handle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)}}
                if !requests.incoming.isEmpty {Section("Requests") {ForEach(requests.incoming){request in if let person=request.from{VStack(alignment:.leading){Text(person.displayName);Text("@"+person.handle).font(.caption).foregroundStyle(.secondary);HStack{Button("Accept"){act(request,"accept")}.buttonStyle(.borderedProminent);Button("Decline",role:.destructive){act(request,"decline")}}}}}}}
                if !requests.outgoing.isEmpty {Section("Sent") {ForEach(requests.outgoing){request in if let person=request.to{HStack{VStack(alignment:.leading){Text(person.displayName);Text("@"+person.handle).font(.caption).foregroundStyle(.secondary)};Spacer();Button("Cancel",role:.destructive){act(request,"cancel")}}}}}}
                Section("Friends") {
                    if friends.isEmpty {Text("No friends yet.").foregroundStyle(.secondary)}
                    ForEach(friends){friend in HStack(spacing:12){Circle().fill(friend.state=="ONLINE" ? success:friend.state=="AWAY" ? warning:Color.secondary).frame(width:10,height:10);VStack(alignment:.leading){Text(friend.displayName);Text("@"+friend.handle+" · "+(friend.session.map{"Playing online · \($0.playerCount)/\($0.maxPlayers)"} ?? readable(friend.state))).font(.caption).foregroundStyle(friend.session == nil ? Color.secondary:Color.accentColor)}}.swipeActions{Button("Unfriend",role:.destructive){unfriend(friend)}}}
                }
            }
            if let failure {Section{Text(failure).foregroundStyle(warning);Button("Retry"){Task{await load()}}}}
            Section {Text("Your Library Node relays Community account, friend and presence requests. Sony credentials are never requested.").font(.footnote).foregroundStyle(.secondary)}
        }.cinematicList().navigationTitle("Community Friends").task{await monitor()}.refreshable{await load()}.disabled(busy)
    }
    func monitor() async {await load();while !Task.isCancelled,status?.state=="AWAITING_OWNER"{try? await Task.sleep(nanoseconds:5_000_000_000);await refreshLink()}}
    @MainActor func load() async {guard let api=store.api else{return};let owner=store.account?.id;do{let value:CommunityAccountStatus=try await api.request("/community/account");guard store.account?.id==owner else{return};status=value;if value.state=="CONNECTED"{async let found:[CommunityFriend]=api.request("/community/friends/presence");async let pending:CommunityFriendRequests=api.request("/community/friends/requests");(friends,requests)=try await(found,pending)}else{friends=[];requests=CommunityFriendRequests(incoming:[],outgoing:[])};failure=nil}catch{if store.account?.id==owner{failure=error.localizedDescription}}}
    func connect(){guard let api=store.api else{return};let owner=store.account?.id;busy=true;Task{@MainActor in defer{busy=false};do{status=try await api.request("/community/account/request",method:"POST",body:CommunityIdentityRequest(deviceName:UIDevice.current.name+" companion"));failure=nil}catch{if store.account?.id==owner{failure=error.localizedDescription}}}}
    @MainActor func refreshLink() async {guard let api=store.api else{return};let owner=store.account?.id;do{let body:[String:String]=[:];let value:CommunityAccountStatus=try await api.request("/community/account/refresh",method:"POST",body:body);guard store.account?.id==owner else{return};status=value;if value.state=="CONNECTED"{await load()};failure=nil}catch{if store.account?.id==owner{failure=error.localizedDescription}}}
    func addFriend(){let value=handle.trimmingCharacters(in:.whitespacesAndNewlines).lowercased();guard let api=store.api,!value.isEmpty else{return};busy=true;Task{@MainActor in defer{busy=false};do{let _:Acknowledgement=try await api.request("/community/friends/requests",method:"POST",body:CommunityFriendRequestBody(handle:value));handle="";await load()}catch{failure=error.localizedDescription}}}
    func act(_ request:CommunityFriendRequest,_ action:String){guard let api=store.api else{return};busy=true;Task{@MainActor in defer{busy=false};do{let method=action=="cancel" ? "DELETE":"POST",path=action=="cancel" ? "/community/friends/requests/\(request.id)":"/community/friends/requests/\(request.id)/\(action)";try await api.send(path,method:method,body:[String:String]());await load()}catch{failure=error.localizedDescription}}}
    func unfriend(_ friend:CommunityFriend){guard let api=store.api else{return};busy=true;Task{@MainActor in defer{busy=false};do{try await api.send("/community/friends/\(friend.handle)",method:"DELETE",body:[String:String]());await load()}catch{failure=error.localizedDescription}}}
    func disconnect(){guard let api=store.api else{return};busy=true;Task{@MainActor in defer{busy=false};do{let body:[String:String]=[:];status=try await api.request("/community/account",method:"DELETE",body:body);friends=[];requests=CommunityFriendRequests(incoming:[],outgoing:[]);failure=nil}catch{failure=error.localizedDescription}}}
}
struct SaveBackupsView:View {
    @EnvironmentObject var store:Store;let console:ProfileConsole
    @State private var backups:[SaveBackup]=[];@State private var portable:[PortableSave]=[];@State private var imports:[SaveImport]=[];@State private var terms:CommunityTerms?;@State private var acceptedRisk=false;@State private var community:[CommunitySave]=[];@State private var communityUnavailable=false
    @State private var busy="";@State private var loading=false;@State private var failure:String?;@State private var exported:(id:String,url:URL)?;@State private var deleting:SaveBackup?
    var live:Console?{store.data.consoles.first{$0.id==console.id}}
    var enabled:Bool{!store.offline && live?.presence=="ONLINE" && live?.capabilities?.saveBackup==true}
    var portableEnabled:Bool{enabled && live?.capabilities?.saveExport==true && live?.capabilities?.saveImport==true && live?.capabilities?.saveRollback==true}
    var body:some View {
        List {
            Section { Text("Encrypted backups remain bound to this PS5. Portable community saves use a separate console-local export/import path and always create an encrypted rollback backup first.").font(.footnote) }
            Section("Saved games") {
                if (console.saveData ?? []).isEmpty { Text("This console has not reported any save slots.").foregroundStyle(.secondary) }
                ForEach(console.saveData ?? []){save in
                    VStack(alignment:.leading,spacing:8) {
                        Text(save.title.isEmpty ? (save.subtitle.isEmpty ? save.saveTitleId:save.subtitle):save.title).font(.headline)
                        Text(save.platform+" | "+save.saveTitleId+" | "+bytes(save.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Back up to server",systemImage:"arrow.up.doc"){request(save)}.buttonStyle(.borderedProminent).disabled(!enabled || !busy.isEmpty || active(save))
                            if terms?.accepted==true,portableEnabled,let game=console.games.first(where:{$0.titleId==save.gameTitleId}) {
                                Menu("Share save",systemImage:"person.2") { ForEach(game.versions,id:\.self){version in Button("Version "+version){preparePortable(save,version)}} }.disabled(!busy.isEmpty)
                            }
                        }
                    }.padding(.vertical,4)
                }
                if !enabled { Text("Open the updated PS5Library app on this console to enable encrypted backups.").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Backup history") {
                if backups.isEmpty { Text("No backups yet.").foregroundStyle(.secondary) }
                ForEach(backups){backup in
                    VStack(alignment:.leading,spacing:8) {
                        Text(backup.saveTitleId+" | "+backup.directory).font(.headline)
                        Text(readable(backup.state)+(backup.totalBytes.map{" | "+bytes(backup.uploadedBytes)+" / "+bytes($0)} ?? " | Waiting for console")).font(.caption).foregroundStyle(.secondary)
                        if let progress=backup.progress,!backup.downloadable { ProgressView(value:progress).accessibilityLabel("\(backup.saveTitleId) backup upload").accessibilityValue("\(bytes(backup.uploadedBytes)) of \(bytes(backup.totalBytes ?? 0))") }
                        if let error=backup.error { Text(readable(error)).font(.caption).foregroundStyle(warning) }
                        HStack {
                            if exported?.id==backup.id,let file=exported?.url { ShareLink(item:file){Label("Save to Files",systemImage:"square.and.arrow.up")} }
                            else if backup.downloadable { Button("Download",systemImage:"arrow.down.doc"){download(backup)}.disabled(!busy.isEmpty) }
                            Button("Delete",role:.destructive){deleting=backup}.disabled(!busy.isEmpty)
                        }
                    }.padding(.vertical,4)
                }
            }
            Section("Community saves") {
                if let terms,terms.accepted==false {
                    Text(terms.body).font(.footnote)
                    Toggle(terms.acceptLabel,isOn:$acceptedRisk)
                    Button("Accept and continue"){acceptTerms(terms)}.disabled(!acceptedRisk || !busy.isEmpty)
                } else if terms?.accepted==true {
                    if !portableEnabled { Text("Portable save mount/import is unavailable on this console runtime.").foregroundStyle(.secondary) }
                    ForEach(portable){save in
                        VStack(alignment:.leading,spacing:6) {
                            Text(save.displayName ?? save.saveTitleId).font(.headline)
                            Text(readable(save.origin)+" | "+save.gameVersion+" | "+readable(save.state)).font(.caption).foregroundStyle(.secondary)
                            if let progress=save.progress,save.state != "READY" { ProgressView(value:progress).accessibilityLabel("\(save.displayName ?? save.saveTitleId) save transfer").accessibilityValue("\(bytes(save.uploadedBytes)) of \(bytes(save.totalBytes ?? 0))") }
                            if let error=save.error { Text(readable(error)).font(.caption).foregroundStyle(warning) }
                            if save.origin=="EXPORT" && save.state=="READY" && save.masterPublicationId==nil { Button("Submit for community review"){publish(save)}.disabled(!busy.isEmpty) }
                            if save.origin=="COMMUNITY" && save.state=="READY" { Button("Import with rollback"){importSave(save)}.disabled(!portableEnabled || !busy.isEmpty || !(console.saveData ?? []).contains(where:{$0.saveTitleId==save.saveTitleId && $0.directory==save.directory})) }
                        }.padding(.vertical,3)
                    }
                    Menu("Find compatible saves",systemImage:"magnifyingglass") { ForEach(console.games.filter(\.available)){game in ForEach(game.versions,id:\.self){version in Button(game.title+" | "+version){find(game,version)}}} }.disabled(!portableEnabled || !busy.isEmpty)
                    ForEach(community){save in
                        VStack(alignment:.leading,spacing:5) { Text(save.displayName).font(.headline);Text(save.publisher+" | "+save.gameVersion+" | "+bytes(save.size)).font(.caption).foregroundStyle(.secondary);if !save.description.isEmpty{Text(save.description).font(.footnote)};Button("Download to my server"){downloadCommunity(save)}.disabled(!busy.isEmpty) }.padding(.vertical,3)
                    }
                    ForEach(imports){item in VStack(alignment:.leading){Text(item.displayName ?? item.saveTitleId).font(.headline);Text("Import "+readable(item.state)+" | rollback "+readable(item.rollbackState)).font(.caption).foregroundStyle(.secondary);if ["REQUESTED","IMPORTING","VERIFYING"].contains(item.state){ProgressView(value:item.progress);Text(bytes(item.downloadedBytes)+" / "+bytes(item.totalBytes)+(item.speedBytesPerSecond>0 ? " | "+bytes(item.speedBytesPerSecond)+"/s":"")).font(.caption.monospacedDigit()).foregroundStyle(.secondary)};if let error=item.error{Text(readable(error)).font(.caption).foregroundStyle(warning)}} }
                } else if communityUnavailable { Text("Community saves are unavailable. Encrypted backups still work.").foregroundStyle(.secondary) }
                else { ProgressView("Loading community terms...") }
            }
            if !busy.isEmpty { ProgressView("Working...") }
            if let failure { Section { Text(failure).foregroundStyle(warning);Button("Retry"){Task{await load()}} } }
        }.cinematicList().navigationTitle(console.name+" Saves").refreshable{await load()}
        .task { while !Task.isCancelled { await load();try? await Task.sleep(nanoseconds:2_000_000_000) } }
        .onDisappear{if let file=exported?.url{try? FileManager.default.removeItem(at:file)}}
        .alert("Delete this backup?",isPresented:Binding(get:{deleting != nil},set:{if !$0{deleting=nil}}),presenting:deleting){backup in
            Button("Delete",role:.destructive){remove(backup)};Button("Cancel",role:.cancel){}
        } message:{_ in Text("This removes the server copy. The save on your PS5 is unchanged.")}
    }
    func active(_ save:SaveSlot)->Bool{backups.contains{$0.consoleId==console.id && $0.localUserId==save.localUserId && $0.platform==save.platform && $0.saveTitleId==save.saveTitleId && $0.directory==save.directory && ["REQUESTED","UPLOADING","VERIFYING"].contains($0.state)}}
    func load() async {guard !loading,let api=store.api else{return};loading=true;defer{loading=false};do{let all:[SaveBackup]=try await api.request("/save-backups");if !Task.isCancelled{backups=all.filter{$0.consoleId==console.id};failure=nil}}catch{if !Task.isCancelled{failure=error.localizedDescription};return};async let allPortable:[PortableSave]?=try? api.request("/portable-saves");async let allImports:[SaveImport]?=try? api.request("/save-imports");async let currentTerms:CommunityTerms?=try? api.request("/community/terms");let result=await(allPortable,allImports,currentTerms);if !Task.isCancelled{if let values=result.0{portable=values.filter{$0.consoleId==nil || $0.consoleId==console.id}};if let values=result.1{imports=values.filter{$0.consoleId==console.id}};terms=result.2;communityUnavailable=result.2==nil}}
    func request(_ save:SaveSlot){run(save.id){api in let _:Acknowledgement=try await api.request("/consoles/\(console.id)/saves/backups",method:"POST",body:SaveBackupRequest(localUserId:save.localUserId,platform:save.platform,saveTitleId:save.saveTitleId,directory:save.directory))}}
    func download(_ backup:SaveBackup){run(backup.id){api in let file=try await api.downloadSave(backup);if let old=exported?.url{try? FileManager.default.removeItem(at:old)};exported=(backup.id,file)}}
    func remove(_ backup:SaveBackup){run(backup.id){api in let _:Acknowledgement=try await api.request("/save-backups/\(backup.id)",method:"DELETE");if exported?.id==backup.id,let file=exported?.url{try? FileManager.default.removeItem(at:file);exported=nil}}}
    func acceptTerms(_ value:CommunityTerms){run("terms"){api in let _:Acknowledgement=try await api.request("/community/terms/accept",method:"POST",body:CommunityConsent(accepted:true,termsVersion:value.version,termsSha256:value.sha256));acceptedRisk=false}}
    func preparePortable(_ save:SaveSlot,_ version:String){run(save.id){api in let _:SaveTaskCreated=try await api.request("/consoles/\(console.id)/saves/exports",method:"POST",body:SaveExportRequest(localUserId:save.localUserId,platform:save.platform,saveTitleId:save.saveTitleId,directory:save.directory,gameVersion:version))}}
    func publish(_ save:PortableSave){run(save.id){api in let _:SaveTaskCreated=try await api.request("/portable-saves/\(save.id)/publish",method:"POST",body:PortablePublication(displayName:save.displayName ?? save.saveTitleId,description:"Shared from "+console.name))}}
    func find(_ game:ProfileGame,_ version:String){guard let api=store.api else{return};busy=game.id;Task{@MainActor in defer{busy=""};do{let value:CommunitySaveCatalog=try await api.request("/community/saves?consoleId=\(console.id)&gameTitleId=\(game.titleId)&gameVersion=\(version)");community=value.versions.flatMap(\.saves);failure=nil}catch{failure=error.localizedDescription}}}
    func downloadCommunity(_ save:CommunitySave){run(save.id){api in let _:SaveTaskCreated=try await api.request("/community/saves/\(save.id)/download",method:"POST",body:CommunityDownloadRequest(consoleId:console.id,gameTitleId:save.gameTitleId,gameVersion:save.gameVersion))}}
    func importSave(_ save:PortableSave){guard let slot=(console.saveData ?? []).first(where:{$0.saveTitleId==save.saveTitleId && $0.directory==save.directory}) else{failure="Create the matching save slot in the game first.";return};run(save.id){api in let _:SaveTaskCreated=try await api.request("/portable-saves/\(save.id)/import",method:"POST",body:SaveImportRequest(consoleId:console.id,localUserId:slot.localUserId))}}
    func run(_ id:String,_ action:@escaping(API) async throws->Void){guard busy.isEmpty,let api=store.api else{return};let owner=store.account?.id;busy=id;failure=nil;Task{@MainActor in defer{busy=""};do{try await action(api);if store.account?.id==owner{await load()}}catch{if store.account?.id==owner{failure=error.localizedDescription}}}}
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
            if let failure=failure{Text(failure).foregroundStyle(warning);Button("Retry"){Task{await load()}}}
        }.cinematicList().navigationTitle("Notifications").task{await load()}.refreshable{await load()}
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
struct CommunityConnectionView:View {
    @EnvironmentObject var store:Store
    @State private var status:CommunityStatus?
    @State private var name="Family Library"
    @State private var busy=false
    @State private var failure:String?
    var body:some View {
        Form {
            Section("Connection") {
                if let status {
                    LabeledContent("State",value:readable(status.state))
                    if let serverId=status.serverId{LabeledContent("Server ID"){Text(serverId).font(.caption.monospaced()).textSelection(.enabled)}}
                    if let reason=status.banReason{LabeledContent("Ban reason",value:reason)}
                    if let error=status.error{LabeledContent("Last error",value:readable(error))}
                } else { ProgressView("Loading community status…") }
            }
            if status?.configured==false {
                Section { Text("Configure Community services on this Library Node, then restart the Node.").foregroundStyle(.secondary) }
            } else if status?.state=="DISCONNECTED" {
                Section("Request access") {
                    TextField("Server name",text:$name)
                    Button("Request Community access"){requestAccess()}.disabled(busy||name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                }
            } else if status?.state=="AWAITING_OWNER" {
                Section("Authorize this server") {
                    if let code=status?.userCode{Text(code).font(.system(.title2,design:.monospaced).weight(.bold)).tracking(3).textSelection(.enabled)}
                    if let value=status?.verificationUriComplete,let url=URL(string:value){Link("Sign in with passkey and authorize",destination:url)}
                    Text("A Community administrator must approve this Library Node after you authorize it.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let status,status.state != "DISCONNECTED" {
                Section { Button("Refresh status"){refresh()}.disabled(busy);Button("Disconnect Community services",role:.destructive){disconnect()}.disabled(busy) }
            }
            Section { Text("This companion only contacts the Library Node. The Node relays approved Community requests; games, packages and console credentials stay local.").font(.footnote).foregroundStyle(.secondary) }
            if let failure{Section{Text(failure).foregroundStyle(warning)}}
        }.cinematicList().navigationTitle("Community Services").task{await monitor()}.refreshable{await load()}.disabled(busy)
    }
    func monitor() async { await load();while !Task.isCancelled,["AWAITING_OWNER","PENDING"].contains(status?.state ?? ""){try? await Task.sleep(nanoseconds:5_000_000_000);await load()} }
    @MainActor func load() async {guard let api=store.api else{return};do{status=try await api.request("/admin/community");failure=nil}catch{failure=error.localizedDescription}}
    func requestAccess(){guard let api=store.api else{return};let displayName=name.trimmingCharacters(in:.whitespacesAndNewlines);busy=true;Task{@MainActor in defer{busy=false};do{status=try await api.request("/admin/community/request",method:"POST",body:CommunityRequest(displayName:displayName));failure=nil}catch{failure=error.localizedDescription}}}
    func refresh(){guard let api=store.api else{return};busy=true;Task{@MainActor in defer{busy=false};do{let empty:[String:String]=[:];status=try await api.request("/admin/community/refresh",method:"POST",body:empty);failure=nil}catch{failure=error.localizedDescription}}}
    func disconnect(){guard let api=store.api else{return};busy=true;Task{@MainActor in defer{busy=false};do{let _:Acknowledgement=try await api.request("/admin/community",method:"DELETE",body:[String:String]());await load()}catch{failure=error.localizedDescription}}}
}
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
                    if let error=source.error{Text(readable(error)).foregroundStyle(warning)}
                    ForEach(Array(source.observations.enumerated()),id:\.offset){_,observation in
                        VStack(alignment:.leading) {
                            Text(observation.path).font(.caption)
                            Text(readable(observation.state)).font(.caption).foregroundStyle(.secondary)
                            if let error=observation.error{Text(readable(error)).font(.caption).foregroundStyle(warning)}
                        }
                    }
                    Button(syncing==source.id ? "Scanning...":"Scan now"){scan(source)}.disabled(syncing != nil||store.offline)
                }
            }
            if let failure=failure{Text(failure).foregroundStyle(warning);Button("Retry"){Task{await load()}}}
        }.cinematicList().navigationTitle("Content Sources")
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
                if let failure=failure{Text(failure).foregroundStyle(warning)}
                if busy{ProgressView("Saving source...")}
            }.disabled(busy).cinematicList().navigationTitle("Add Source")
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
struct SignIn:View {
    @EnvironmentObject var store:Store
    @Environment(\.dismiss) var dismiss
    @State private var server=""
    @State private var username=""
    @State private var password=""
    @State private var invite=""
    @State private var register=false
    @State private var busy=false
    @State private var failure:String?
    var body:some View {
        NavigationStack {
            ZStack {
                CinematicBackdrop()
                ScrollView {
                    VStack(alignment:.leading,spacing:28) {
                        BrandMark()
                        VStack(alignment:.leading,spacing:7) {
                            Text(register ? "Join a library":"Welcome back").font(.largeTitle.bold())
                            Text(register ? "Use an invitation from a server owner to create your private account.":"Connect to your self-hosted library and your paired consoles.").foregroundStyle(secondaryText)
                        }
                        VStack(alignment:.leading,spacing:14) {
                            fieldLabel("SERVER")
                            TextField("https://library.example or 192.168.1.20:3150",text:$server)
                                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.URL)
                                .padding(.horizontal,14).frame(minHeight:50).background(.white.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                            fieldLabel("ACCOUNT")
                            TextField("Username",text:$username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                                .padding(.horizontal,14).frame(minHeight:50).background(.white.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                            SecureField("Password",text:$password).textContentType(register ? .newPassword:.password)
                                .padding(.horizontal,14).frame(minHeight:50).background(.white.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                            if register {
                                TextField("Invitation code",text:$invite).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .padding(.horizontal,14).frame(minHeight:50).background(.white.opacity(0.07),in:RoundedRectangle(cornerRadius:12))
                            }
                            if let failure{Label(failure,systemImage:"exclamationmark.triangle.fill").font(.footnote).foregroundStyle(warning)}
                            Button(register ? "Create account":"Sign in",systemImage:"arrow.right"){
                                busy=true
                                Task{do{try await store.login(server:server,username:username,password:password,invite:invite,register:register);dismiss()}catch{failure=error.localizedDescription};password="";busy=false}
                            }.buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth:.infinity,minHeight:50)
                                .disabled(busy||username.isEmpty||password.isEmpty)
                            Button(register ? "I already have an account":"Use a friend's invitation"){withAnimation(.easeOut(duration:0.18)){register.toggle();failure=nil}}
                                .frame(maxWidth:.infinity,minHeight:44)
                            if busy{ProgressView(register ? "Creating your account...":"Connecting to your library...").frame(maxWidth:.infinity)}
                        }.cinematicCard(padding:18)
                        Label("Your server, your account, and only your consoles.",systemImage:"lock.shield.fill").font(.footnote).foregroundStyle(secondaryText)
                    }.frame(maxWidth:560).padding(.horizontal,22).padding(.vertical,32).frame(maxWidth:.infinity)
                }
            }
            .toolbar{if store.account != nil{ToolbarItem(placement:.cancellationAction){Button("Cancel"){dismiss()}}}}
        }
    }
    @ViewBuilder private func fieldLabel(_ text:String)->some View {
        Text(text).font(.caption2.bold()).tracking(1.6).foregroundStyle(accent)
    }
}

struct GameMediaView:View {
    @EnvironmentObject var store:Store
    let game:Game
    @State private var selection:String?
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            SectionHeading(title:"Media")
            if game.trailer != nil{Button("Watch trailer",systemImage:"play.rectangle.fill"){selection="trailers"}.buttonStyle(.borderedProminent).controlSize(.large).disabled(store.offline)}
            else if let state=game.trailerState{Text("Trailer: "+readable(state)).font(.caption).foregroundStyle(.secondary)}
            if game.music != nil{Button("Play game music",systemImage:"music.note"){selection="music"}.buttonStyle(.bordered).controlSize(.large).disabled(store.offline)}
            else if let state=game.musicState{Text("Music: "+readable(state)).font(.caption).foregroundStyle(.secondary)}
            if game.trailer==nil && game.music==nil && game.trailerState==nil && game.musicState==nil{Text("No media is available for this title.").font(.footnote).foregroundStyle(secondaryText)}
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
                    Text(failure).foregroundStyle(warning)
                    Button("Retry"){attempt+=1}
                } else {
                    ProgressView("Downloading and verifying media...")
                    Text(bytes(asset.size)).font(.caption).foregroundStyle(.secondary)
                }
            }.padding().frame(maxWidth:.infinity,maxHeight:.infinity).background(CinematicBackdrop()).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
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
            }.frame(maxWidth:.infinity,maxHeight:.infinity).background(CinematicBackdrop()).navigationTitle("Scan Pairing Code").navigationBarTitleDisplayMode(.inline)
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
