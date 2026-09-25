import Foundation

func serverAddressAllowed(_ url: URL) -> Bool {
    guard let scheme=url.scheme?.lowercased(),let rawHost=url.host?.lowercased(),!rawHost.isEmpty,
          url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path.isEmpty||url.path=="/" else{return false}
    if scheme=="https" { return true }
    guard scheme=="http" else{return false}
    let host=rawHost.trimmingCharacters(in:CharacterSet(charactersIn:"[]")),plain=host.split(separator:"%",maxSplits:1).first.map(String.init) ?? host
    if plain=="localhost" || plain.hasSuffix(".local") { return true }
    let parts=plain.split(separator:".",omittingEmptySubsequences:false)
    if parts.count==4,parts.allSatisfy({!$0.isEmpty&&$0.allSatisfy(\.isNumber)}),parts.allSatisfy({Int($0).map{(0...255).contains($0)}==true}) {
        let a=Int(parts[0])!,b=Int(parts[1])!
        return a==10 || a==127 || (a==172&&(16...31).contains(b)) || (a==192&&b==168) || (a==169&&b==254) || (a==100&&(64...127).contains(b))
    }
    if plain.contains(":") { return plain=="::1" || plain.hasPrefix("fc") || plain.hasPrefix("fd") || ["fe8","fe9","fea","feb"].contains(where:plain.hasPrefix) }
    return false
}
func normalizedServerAddress(_ input: String) -> URL? {
    let value=input.trimmingCharacters(in:.whitespacesAndNewlines)
    guard !value.isEmpty else{return nil}
    let candidate=value.contains("://") ? value:"http://"+value
    guard let url=URL(string:candidate),serverAddressAllowed(url) else{return nil}
    return url
}
func serverConnectionMessage(_ error: Error, server: URL) -> String? {
    guard let failure=error as? URLError else{return nil}
    if failure.code == .secureConnectionFailed || failure.code == .serverCertificateUntrusted {
        var parts=URLComponents(url:server,resolvingAgainstBaseURL:false)
        parts?.scheme="http"
        if let local=parts?.url,serverAddressAllowed(local) {
            return "Secure connection failed. This private server is not serving trusted HTTPS. Enter \(local.absoluteString) to use it on your local network."
        }
    }
    if [.notConnectedToInternet,.cannotConnectToHost,.cannotFindHost,.timedOut,.networkConnectionLost].contains(failure.code) {
        return "Cannot reach PS5Library. Connect the iPhone to the server's Wi-Fi and enable PS5Library under Settings > Privacy & Security > Local Network."
    }
    return nil
}
func webSocketScheme(for scheme: String?) -> String { scheme?.lowercased()=="http" ? "ws":"wss" }
private func defaultPort(for scheme: String?) -> Int { scheme?.lowercased()=="http" ? 80:443 }

struct Account: Codable, Identifiable, Equatable {
    var id: String; var server: URL; var username: String; var role: String
}
struct User: Decodable { let id: String; let username: String; let role: String }
struct Login: Decodable { let user: User; let token: String }
struct Game: Codable, Identifiable, Hashable {
    let id: String; let title: String; let titleId: String
    let description: String?; let publisher: String?; let genres: [String]?
    let coverUrl: String; let heroUrl: String; let screenshotUrls: [String]?
    let releases: [Release]
    let trailer: MediaAsset?; let music: MediaAsset?
    let trailerState: String?; let musicState: String?
    let saved: Bool?; let addedAt: String?; let releaseDate: String?; let recentlyUpdated: Bool?
    var serverReady: Bool { releases.contains { $0.kind != "DLC" && !($0.artifacts ?? []).isEmpty } }
    func ready(in library: [LibraryEntry], storageId: String = "") -> Bool {
        releases.contains { release in library.contains {
            $0.releaseId == release.id && $0.state == "READY_ON_PS5" && (storageId.isEmpty || $0.storageId == storageId)
        } }
    }
}
struct Release: Codable, Identifiable, Hashable {
    let id: String; let version: String; let kind: String; let size: Int64?
    let region: String?; let languages: [String]?; let minimumFirmware: String?
    let sources: [SourceRelease]
    let title: String?; let artifacts: [ReleaseArtifact]?
    var label: String { (kind == "DLC" ? "DLC: " + (title ?? "Additional content") : readable(kind)) + " · " + version }
}
struct ReleaseArtifact: Codable, Hashable { let id: String }
struct MediaAsset: Codable, Hashable {
    let url: String; let sha256: String; let size: Int64; let duration: Double
    func valid(for kind: String) -> Bool {
        let limit:Int64 = kind == "music" ? 8*1024*1024 : 128*1024*1024
        return ["music","trailers"].contains(kind) && url.hasPrefix("/api/v1/"+kind+"/") && !url.contains("..") && !url.contains("%") && !url.contains("?") && !url.contains("#") && size>0 && size<limit && duration>0 && duration<=180.1 && sha256.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil
    }
}
struct SourceRelease: Codable, Identifiable, Hashable { let id: String; let name: String; let format: String }
struct Storage: Codable, Identifiable {
    var id: String { storageId }; let storageId: String; let displayName: String
    let totalBytes: Int64; let freeBytes: Int64; let writable: Bool
}
struct Console: Codable, Identifiable {
    let id: String; let name: String; let presence: String; let firmware: String?
    let runtime: String; let games: Int; let storage: [Storage]; let isDefault: Bool
    let capabilities: ConsoleCapabilities?
}
struct ConsoleCapabilities: Codable { let remotePlayPairing: Bool?; let saveBackup: Bool?; let saveExport:Bool?;let saveImport:Bool?;let saveRollback:Bool? }
struct RemotePlayPairing: Codable, Identifiable {
    let id: String; let state: String; let expiresAt: String; let updatedAt: String?
    let error: String?; let pin: String?; let accountId: String?
}
struct ConsoleUpdate: Encodable { var name: String? = nil; var isDefault: Bool? = nil }
struct CatalogSource: Decodable, Identifiable {
    struct Observation: Decodable { let path: String; let state: String; let error: String? }
    let id: String; let name: String; let type: String; let last_synced: String?; let error: String?
    let autoPrepare: String?; let shareCatalog: Bool?; let observations: [Observation]
}
struct SourceInput: Encodable {
    var name: String; var type: String; var location: String
    var tokenEnv: String? = nil; var scanIntervalMinutes: Int? = nil
    var autoPrepare: String? = nil; var shareCatalog = false
    var validationError: String? {
        guard (1...120).contains(name.utf16.count) else{return "Use a source name of 1 to 120 characters."}
        guard (1...2048).contains(location.utf16.count) else{return "Enter a location of 1 to 2048 characters."}
        if ["LOCAL_FOLDER","WATCH_FOLDER"].contains(type) {
            let path=location.replacingOccurrences(of:"\\",with:"/")
            if path.hasPrefix("/") || path.contains(":") || path.components(separatedBy:"/").contains("..") {
                return "Use a folder relative to the server's configured source root."
            }
        }
        if let tokenEnv=tokenEnv,(!tokenEnv.hasPrefix("REPOSITORY_TOKEN_") || tokenEnv.range(of:"^[A-Z][A-Z0-9_]{1,80}$",options:.regularExpression)==nil) {
            return "Enter the server environment variable name, not its secret value."
        }
        return nil
    }
}
struct FirmwareRefresh: Decodable { let requestId: String }
struct PairingQR {
    let code: String; let frontend: Bool
    init?(_ payload: String, server: URL) {
        guard payload.utf8.count<=2048,serverAddressAllowed(server),
              let parts=URLComponents(string:payload),parts.scheme?.lowercased()==server.scheme?.lowercased(),
              parts.host?.lowercased()==server.host?.lowercased(),parts.host != nil,
              (parts.port ?? defaultPort(for:parts.scheme))==(server.port ?? defaultPort(for:server.scheme)),parts.user==nil,parts.password==nil,
              parts.fragment==nil,parts.percentEncodedPath=="/pair" else{return nil}
        let query=parts.queryItems ?? []
        let codes=query.filter{$0.name=="code"},kinds=query.filter{$0.name=="kind"}
        guard query.allSatisfy({["code","kind"].contains($0.name)}),codes.count==1,kinds.count<=1,
              let raw=codes.first?.value,let code=pairingCode(raw),
              kinds.isEmpty || kinds.first?.value=="frontend" else{return nil}
        self.code=code;frontend = !kinds.isEmpty
    }
}
func pairingCode(_ input: String) -> String? {
    let value=input.trimmingCharacters(in:.whitespacesAndNewlines).uppercased()
    return value.count == 10 && value.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) } ? value : nil
}
func consoleName(_ input: String) -> String? {
    let value=input.trimmingCharacters(in:.whitespacesAndNewlines)
    return (1...80).contains(value.utf16.count) ? value : nil
}
struct LibraryEntry: Codable {
    let releaseId: String; let storageId: String; let state: String; let registered: Bool
}
struct Job: Codable, Identifiable {
    let id: String; let title: String?; let releaseId: String; let kind: String; let state: String
    let consoleId: String?; let storageId: String?; let downloadedBytes: Int64; let totalBytes: Int64?
    let speedBytesPerSecond: Int64; let etaSeconds: Int?; let error: String?; let location: String?; let progress: BuildProgress?
    var retryable: Bool { state == "ERROR" }
    var dismissible: Bool { ["COMPLETED","READY_ON_PS5","ERROR","CANCELLED"].contains(state) }
}
struct BuildProgress: Codable { let stage: String?; let completedStages: Int?; let totalStages: Int? }
struct Featured: Codable { let gameId: String?; let heroUrl: String?; let state: String; let nextRotationAt: String }
struct Plan: Decodable {
    struct Compatibility: Decodable { let status: String; let method: String? }
    struct Destination: Decodable, Identifiable {
        var id: String { storageId }; let storageId: String; let displayName: String
        let freeBytes: Int64; let requiredBytes: Int64; let allowed: Bool
    }
    let method: String?; let methods: [String]; let compatibility: Compatibility
    let storage: [Destination]; let allowed: Bool; let reason: String; let online: Bool?; let estimated: Bool
    let message: String?
}
struct InstallationSelection: Encodable, Hashable {
    let sourceReleaseId: String; let consoleId: String; var method: String? = nil
}
struct InstallationRequest: Encodable {
    let sourceReleaseId: String; let consoleId: String; let storageId: String; let method: String
}
struct InstallationStatus: Codable, Identifiable {
    let id: String; let title: String; let state: String; let error: String?
    let method: String; let consoleId: String; let storageId: String
}
struct ReviewedInstallation {
    let selection: InstallationSelection; let plan: Plan
    func submission(for current: InstallationSelection, storageId: String) -> InstallationRequest? {
        guard current==selection,!current.sourceReleaseId.isEmpty,!current.consoleId.isEmpty,plan.allowed,
              let method=plan.method,plan.methods.contains(method),
              current.method==nil || current.method==method,
              plan.storage.contains(where:{$0.id==storageId && $0.allowed}) else{return nil}
        return InstallationRequest(sourceReleaseId:current.sourceReleaseId,consoleId:current.consoleId,storageId:storageId,method:method)
    }
}
struct Artifact: Decodable, Identifiable { let id: String; let title: String; let version: String; let format: String; let size: Int64; let verified: Bool }
struct Acknowledgement: Decodable { let id: String?; let ok: Bool?; let consoleId: String? }
struct Invitation: Decodable { let token: String }
struct CommunityStatus: Decodable {
    let configured:Bool;let masterUrl:String?;let displayName:String?;let serverId:String?;let state:String
    let userCode:String?;let verificationUri:String?;let verificationUriComplete:String?;let expiresAt:String?;let banReason:String?;let error:String?;let updatedAt:String?
}
struct CommunityRequest: Encodable { let displayName:String }
struct Events: Decodable { struct Event: Decodable { let id: Int64 }; let events: [Event] }
struct Snapshot: Codable { var games: [Game]; var consoles: [Console]; var jobs: [Job]; var featured: Featured?; var library: [LibraryEntry]; var consoleId: String; var installations: [InstallationStatus]? = nil }
struct Profile: Decodable {
    let username: String; let role: String; let avatarUrl: String?; let consoles: [ProfileConsole]
}
struct ProfileConsole: Decodable, Identifiable {
    let id: String; let name: String; let trophySummary: TrophySummary?; let trophySyncedAt: String?
    let games: [ProfileGame]; let saveData: [SaveSlot]?
}
struct SaveSlot: Decodable, Identifiable {
    var id:String { localUserId+"|"+platform+"|"+saveTitleId+"|"+directory }
    let localUserId:String;let platform:String; let gameTitleId:String; let saveTitleId:String; let directory:String
    let title:String; let subtitle:String; let detail:String; let sizeBytes:Int64; let modifiedAt:Double
}
struct SaveBackupRequest: Encodable { let localUserId:String; let platform:String; let saveTitleId:String; let directory:String }
struct SaveBackup: Decodable, Identifiable {
    let id:String; let consoleId:String; let localUserId:String; let platform:String; let gameTitleId:String; let saveTitleId:String; let directory:String
    let sourceModifiedAt:Int64; let format:String; let state:String; let totalBytes:Int64?; let uploadedBytes:Int64; let sha256:String?; let error:String?
    let createdAt:String; let updatedAt:String; let downloadUrl:String?
    var progress:Double? { guard let totalBytes,totalBytes>0 else{return nil};return min(1,max(0,Double(uploadedBytes)/Double(totalBytes))) }
    var downloadable:Bool { state=="READY" && totalBytes==uploadedBytes && totalBytes != nil && sha256?.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil && downloadUrl=="/api/v1/save-backups/\(id)/download" }
}
struct CommunityTerms:Decodable {let version:String;let sha256:String;let body:String;let acceptLabel:String;let accepted:Bool}
struct PortableSave:Decodable,Identifiable {
    let id:String;let origin:String;let consoleId:String?;let localUserId:String?;let platform:String;let gameTitleId:String;let saveTitleId:String;let directory:String;let gameVersion:String;let state:String;let totalBytes:Int64?;let uploadedBytes:Int64;let displayName:String?;let masterPublicationId:String?;let masterState:String?;let error:String?
    var progress:Double?{guard let totalBytes,totalBytes>0 else{return nil};return min(1,max(0,Double(uploadedBytes)/Double(totalBytes)))}
}
struct SaveImport:Decodable,Identifiable {let id:String;let archiveId:String;let consoleId:String;let localUserId:String;let rollbackBackupId:String;let state:String;let rollbackState:String;let displayName:String?;let gameTitleId:String;let gameVersion:String;let saveTitleId:String;let directory:String;let downloadedBytes:Int64;let totalBytes:Int64;let speedBytesPerSecond:Int64;let error:String?;var progress:Double{totalBytes>0 ? min(1,max(0,Double(downloadedBytes)/Double(totalBytes))):0}}
struct CommunitySaveCatalog:Decodable {struct Version:Decodable {let gameVersion:String;let saves:[CommunitySave]};let gameTitleId:String;let versions:[Version]}
struct CommunitySave:Decodable,Identifiable {let id:String;let platform:String;let gameTitleId:String;let saveTitleId:String;let gameVersion:String;let region:String?;let displayName:String;let description:String;let size:Int64;let publisher:String}
struct SaveExportRequest:Encodable {let localUserId:String;let platform:String;let saveTitleId:String;let directory:String;let gameVersion:String}
struct CommunityConsent:Encodable {let accepted:Bool;let termsVersion:String;let termsSha256:String}
struct PortablePublication:Encodable {let displayName:String;let description:String}
struct CommunityDownloadRequest:Encodable {let consoleId:String;let gameTitleId:String;let gameVersion:String}
struct SaveImportRequest:Encodable {let consoleId:String;let localUserId:String}
struct SaveTaskCreated:Decodable {let id:String?;let state:String;let rollbackBackupId:String?;let publicationId:String?}
struct ProfileGame: Decodable, Identifiable {
    var id: String { gameId }; let gameId: String; let title: String;let titleId:String; let platform: String
    let available: Bool; let coverUrl: String;let versions:[String]
}
struct TrophySummary: Decodable {
    struct Counts: Decodable { let platinum: Int; let gold: Int; let silver: Int; let bronze: Int }
    let modifiedAt: Double; let earnedTrophies: Counts
}
struct Notice: Decodable, Identifiable {
    let id: String; let consoleId: String?; let code: String; let message: String; let createdAt: String
}
enum GameCollection: String, CaseIterable, Identifiable {
    case all = "All Games", recent = "Recently Added", updated = "Recently Updated"
    case releases = "New Releases", saved = "Saved Games", server = "Ready on Server"
    var id: String { rawValue }
    func select(_ games: [Game], query: String = "", genre: String = "") -> [Game] {
        let result = games.filter { game in
            let matches = (query.isEmpty || ([game.title, game.titleId, game.publisher ?? ""] + (game.genres ?? [])).joined(separator: " ").localizedCaseInsensitiveContains(query)) && (genre.isEmpty || (game.genres ?? []).contains(genre))
            guard matches else { return false }
            switch self {
            case .saved: return game.saved == true
            case .server: return game.serverReady
            case .updated: return game.recentlyUpdated == true
            case .recent: return game.releases.contains { !$0.sources.isEmpty }
            default: return true
            }
        }
        switch self {
        case .recent: return result.sorted { ($0.addedAt ?? "") > ($1.addedAt ?? "") }
        case .releases: return result.sorted { ($0.releaseDate ?? "") > ($1.releaseDate ?? "") }
        default: return result.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        }
    }
}
func bytes(_ number: Int64) -> String { ByteCountFormatter.string(fromByteCount: number, countStyle: .file) }
func readable(_ state: String) -> String { state.replacingOccurrences(of: "_", with: " ").capitalized }
