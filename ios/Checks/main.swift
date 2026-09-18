import Foundation

func game(_ id: String, _ extra: String = "", releases: String = "[]") throws -> Game {
    try JSONDecoder().decode(Game.self, from: Data("""
    {"id":"\(id)","title":"\(id)","titleId":"BREW05002","coverUrl":"/api/v1/artwork/a/cover","heroUrl":"/api/v1/artwork/a/hero","releases":\(releases)\(extra)}
    """.utf8))
}
let older = try game("older", ",\"saved\":true,\"addedAt\":\"2026-09-01\",\"genres\":[\"Action\"]", releases: """
[{"id":"base","version":"1","kind":"BASE","sources":[{"id":"source","name":"Local","format":"folder"}],"artifacts":[{"id":"artifact"}]}]
""")
let newer = try game("newer", ",\"addedAt\":\"2026-09-17\",\"recentlyUpdated\":true", releases: """
[{"id":"dlc","version":"1","kind":"DLC","sources":[{"id":"source","name":"Local","format":"folder"}],"artifacts":[{"id":"artifact"}]}]
""")
let legacy = try game("legacy")
let games = [older, legacy, newer]
assert(GameCollection.saved.select(games).map(\.id) == ["older"])
assert(GameCollection.server.select(games).map(\.id) == ["older"])
assert(GameCollection.recent.select(games).map(\.id) == ["newer", "older"])
assert(GameCollection.updated.select(games).map(\.id) == ["newer"])
assert(GameCollection.all.select(games, query: "brew05002", genre: "Action").map(\.id) == ["older"])
assert(legacy.saved == nil && !legacy.serverReady)
let inventory = try JSONDecoder().decode([LibraryEntry].self, from: Data(#"[{"releaseId":"base","storageId":"usb0","state":"READY_ON_PS5","registered":true},{"releaseId":"dlc","storageId":"internal","state":"MISSING","registered":false}]"#.utf8))
assert(older.ready(in:inventory, storageId:"usb0"))
assert(!older.ready(in:inventory, storageId:"internal"))
assert(!newer.ready(in:inventory))
let progress = try JSONDecoder().decode(BuildProgress.self, from: Data(#"{"package":{"state":"BUILDING"}}"#.utf8))
assert(progress.stage == nil)
let profile = try JSONDecoder().decode(Profile.self, from: Data(#"{"username":"Owner","role":"MEMBER","avatarUrl":null,"consoles":[{"id":"one","name":"PS5","trophySummary":null,"trophySyncedAt":null,"games":[]}]}"#.utf8))
assert(profile.consoles[0].trophySummary == nil)
let summary = try JSONDecoder().decode(TrophySummary.self, from: Data(#"{"modifiedAt":1741335221,"earnedTrophies":{"platinum":0,"gold":1,"silver":2,"bronze":4}}"#.utf8))
assert(summary.earnedTrophies.bronze == 4)
let snapshot = Snapshot(games:games,consoles:[],jobs:[],featured:nil,library:inventory,consoleId:"console")
let restored = try JSONDecoder().decode(Snapshot.self,from:JSONEncoder().encode(snapshot))
assert(GameCollection.saved.select(restored.games).map(\.id) == ["older"])
assert(restored.games[0].ready(in:restored.library))
let job = try JSONDecoder().decode(Job.self,from:Data(#"{"id":"job","title":"Build","releaseId":"base","kind":"BUILD","state":"BUILDING","consoleId":null,"storageId":null,"downloadedBytes":0,"totalBytes":null,"speedBytesPerSecond":0,"etaSeconds":null,"error":null,"progress":{"package":{"state":"BUILDING"},"fakelib":{"state":"SEPARATED"}}}"#.utf8))
assert(job.progress != nil && job.progress?.stage == nil)
let failedJob = try JSONDecoder().decode(Job.self,from:Data(#"{"id":"failed","title":"Build","releaseId":"base","kind":"BUILD","state":"ERROR","consoleId":null,"storageId":null,"downloadedBytes":0,"totalBytes":null,"speedBytesPerSecond":0,"etaSeconds":null,"error":"CORRUPT_INPUT","location":"Server cache / artifacts/game.pkg","progress":null}"#.utf8))
assert(failedJob.retryable && failedJob.dismissible && failedJob.location?.hasSuffix("game.pkg")==true)
let notice = try JSONDecoder().decode(Notice.self,from:Data(#"{"id":"notice","consoleId":null,"code":"TEST_NOTICE","message":"Waiting for console","createdAt":"2026-09-17T12:00:00.000Z"}"#.utf8))
assert(notice.message == "Waiting for console")
let dlc = try JSONDecoder().decode(Release.self,from:Data(#"{"id":"dlc","kind":"DLC","version":"1","title":"Expansion","sources":[]}"#.utf8))
assert(dlc.label == "DLC: Expansion · 1")
print("iOS model and collection checks passed")
assert(pairingCode("  ab12cd34ef\n") == "AB12CD34EF")
assert(pairingCode("abcdefghij") == nil)
assert(pairingCode("ABC123") == nil)
assert(pairingCode("AB12 CD34EF") == nil)
let update = try JSONSerialization.jsonObject(with:JSONEncoder().encode(ConsoleUpdate(isDefault:true))) as! [String:Any]
assert(update["isDefault"] as? Bool == true && update["name"] == nil)
assert(consoleName("  Living Room  ") == "Living Room")
assert(consoleName(" \n ") == nil)
assert(consoleName(String(repeating:"a",count:81)) == nil)
print("iOS console input checks passed")
let sources=try JSONDecoder().decode([CatalogSource].self,from:Data(#"[{"id":"one","name":"Local","type":"LOCAL_FOLDER","last_synced":null,"error":null,"autoPrepare":null,"shareCatalog":false,"observations":[{"path":"game","state":"ERROR","error":"INVALID_INPUT"}]}]"#.utf8))
assert(sources[0].observations[0].error == "INVALID_INPUT")
assert(SourceInput(name:"Local",type:"LOCAL_FOLDER",location:"games").validationError == nil)
assert(SourceInput(name:"Local",type:"LOCAL_FOLDER",location:"../games").validationError != nil)
assert(SourceInput(name:"Local",type:"LOCAL_FOLDER",location:"C:\\games").validationError != nil)
assert(SourceInput(name:"",type:"LOCAL_FOLDER",location:"games").validationError != nil)
assert(SourceInput(name:"Private",type:"PRIVATE_HTTP",location:"https://example.com/library.json",tokenEnv:"REPOSITORY_TOKEN_TEST").validationError == nil)
assert(SourceInput(name:"Private",type:"PRIVATE_HTTP",location:"https://example.com/library.json",tokenEnv:"TOKEN_1").validationError != nil)
assert(SourceInput(name:"Private",type:"PRIVATE_HTTP",location:"https://example.com/library.json",tokenEnv:"secret value").validationError != nil)
print("iOS source checks passed")
let sourceBody=try JSONSerialization.jsonObject(with:JSONEncoder().encode(SourceInput(name:"Watch",type:"WATCH_FOLDER",location:".",scanIntervalMinutes:30,autoPrepare:"BOTH",shareCatalog:true))) as! [String:Any]
assert(sourceBody["scanIntervalMinutes"] as? Int == 30)
assert(sourceBody["shareCatalog"] as? Bool == true && sourceBody["tokenEnv"] == nil)
let firmware=try JSONDecoder().decode(FirmwareRefresh.self,from:Data(#"{"requestId":"refresh-id"}"#.utf8))
assert(firmware.requestId == "refresh-id")
let media=MediaAsset(url:"/api/v1/music/game",sha256:String(repeating:"a",count:64),size:1024,duration:60)
assert(media.valid(for:"music"))
assert(!media.valid(for:"trailers"))
assert(!MediaAsset(url:"https://other.example/movie",sha256:media.sha256,size:1024,duration:60).valid(for:"music"))
assert(!MediaAsset(url:media.url,sha256:"bad",size:1024,duration:60).valid(for:"music"))
assert(!MediaAsset(url:media.url,sha256:media.sha256,size:9*1024*1024,duration:60).valid(for:"music"))
assert(!MediaAsset(url:media.url,sha256:media.sha256,size:1024,duration:181).valid(for:"music"))
assert(legacy.trailer == nil && legacy.music == nil)
assert(!MediaAsset(url:"/api/v1/music/%2e%2e/other",sha256:media.sha256,size:1024,duration:60).valid(for:"music"))
assert(!MediaAsset(url:media.url,sha256:media.sha256,size:0,duration:60).valid(for:"music"))
let trailer=try JSONDecoder().decode(MediaAsset.self,from:Data(("{\"url\":\"/api/v1/trailers/game\",\"sha256\":\""+media.sha256+"\",\"size\":1234,\"duration\":179.5}").utf8))
assert(trailer.valid(for:"trailers"))
let restoredMedia=try JSONDecoder().decode(MediaAsset.self,from:JSONEncoder().encode(trailer))
assert(restoredMedia == trailer)
print("iOS media metadata checks passed")
let pairingServer=URL(string:"https://library.example:443")!
let scanned=PairingQR("https://library.example/pair?code=ab12cd34ef&kind=frontend",server:pairingServer)
assert(scanned?.code == "AB12CD34EF" && scanned?.frontend == true)
assert(PairingQR("https://library.example/pair?code=AB12CD34EF",server:pairingServer)?.frontend == false)
for invalid in [
    "https://other.example/pair?code=AB12CD34EF",
    "http://library.example/pair?code=AB12CD34EF",
    "https://library.example:444/pair?code=AB12CD34EF",
    "https://user@library.example/pair?code=AB12CD34EF",
    "https://library.example/other?code=AB12CD34EF",
    "https://library.example/pair?code=AB12CD34EF&code=1234567890",
    "https://library.example/pair?code=AB12CD34EF&kind=unknown",
    "https://library.example/pair?code=AB12CD34EF#ignored",
    "https://library.example/pair?code=AB12CD34EF&next=https://other.example",
    "AB12CD34EF"
] { assert(PairingQR(invalid,server:pairingServer)==nil,invalid) }
print("iOS QR pairing checks passed")
let unsupported=try JSONDecoder().decode(Plan.self,from:Data(#"{"method":null,"methods":[],"compatibility":{"status":"UNSUPPORTED_METHOD","method":null},"storage":[],"allowed":false,"reason":"UNSUPPORTED_METHOD","message":"No supported method","estimated":false}"#.utf8))
assert(unsupported.method == nil && unsupported.online == nil)
let allowedPlan=try JSONDecoder().decode(Plan.self,from:Data(#"{"method":"HOMEBREW","methods":["HOMEBREW"],"compatibility":{"status":"NATIVE_COMPATIBLE"},"storage":[{"storageId":"usb","displayName":"USB","freeBytes":100,"requiredBytes":10,"allowed":true},{"storageId":"internal","displayName":"Internal","freeBytes":0,"requiredBytes":10,"allowed":false}],"allowed":true,"reason":"READY_TO_PREPARE","online":false,"estimated":false}"#.utf8))
let choice=InstallationSelection(sourceReleaseId:"source",consoleId:"console")
let review=ReviewedInstallation(selection:choice,plan:allowedPlan)
assert(review.submission(for:choice,storageId:"usb")?.method == "HOMEBREW")
assert(review.submission(for:choice,storageId:"internal") == nil)
assert(review.submission(for:choice,storageId:"missing") == nil)
assert(review.submission(for:InstallationSelection(sourceReleaseId:"other",consoleId:"console"),storageId:"usb") == nil)
assert(review.submission(for:InstallationSelection(sourceReleaseId:"source",consoleId:"other"),storageId:"usb") == nil)
assert(review.submission(for:InstallationSelection(sourceReleaseId:"source",consoleId:"console",method:"FPKG"),storageId:"usb") == nil)
assert(ReviewedInstallation(selection:choice,plan:unsupported).submission(for:choice,storageId:"usb") == nil)
print("iOS installation plan checks passed")
let installation=try JSONDecoder().decode(InstallationStatus.self,from:Data(#"{"id":"install","state":"WAITING_FOR_PS5","error":null,"method":"HOMEBREW","sourceReleaseId":"source","consoleId":"console","storageId":"usb","sourceJobId":null,"transferJobId":null,"artifactId":null,"createdAt":"2026-09-17T12:00:00Z","title":"My homebrew"}"#.utf8))
assert(installation.state == "WAITING_FOR_PS5")
assert(restored.installations == nil)
