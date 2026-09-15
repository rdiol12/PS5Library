import Foundation

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
}
struct Release: Codable, Identifiable, Hashable {
    let id: String; let version: String; let kind: String; let size: Int64?
    let region: String?; let languages: [String]?; let minimumFirmware: String?
    let sources: [SourceRelease]
}
struct SourceRelease: Codable, Identifiable, Hashable { let id: String; let name: String; let format: String }
struct Storage: Codable, Identifiable {
    var id: String { storageId }; let storageId: String; let displayName: String
    let totalBytes: Int64; let freeBytes: Int64; let writable: Bool
}
struct Console: Codable, Identifiable {
    let id: String; let name: String; let presence: String; let firmware: String?
    let runtime: String; let games: Int; let storage: [Storage]; let isDefault: Bool
}
struct LibraryEntry: Codable {
    let releaseId: String; let storageId: String; let state: String; let registered: Bool
}
struct Job: Codable, Identifiable {
    let id: String; let title: String?; let releaseId: String; let kind: String; let state: String
    let consoleId: String?; let storageId: String?; let downloadedBytes: Int64; let totalBytes: Int64?
    let speedBytesPerSecond: Int64; let etaSeconds: Int?; let error: String?; let progress: BuildProgress?
}
struct BuildProgress: Codable { let stage: String; let completedStages: Int; let totalStages: Int }
struct Featured: Codable { let gameId: String?; let heroUrl: String?; let state: String; let nextRotationAt: String }
struct Plan: Decodable {
    struct Compatibility: Decodable { let status: String; let method: String? }
    struct Destination: Decodable, Identifiable {
        var id: String { storageId }; let storageId: String; let displayName: String
        let freeBytes: Int64; let requiredBytes: Int64; let allowed: Bool
    }
    let method: String; let methods: [String]; let compatibility: Compatibility
    let storage: [Destination]; let allowed: Bool; let reason: String; let online: Bool; let estimated: Bool
}
struct Artifact: Decodable, Identifiable { let id: String; let title: String; let version: String; let format: String; let size: Int64; let verified: Bool }
struct Acknowledgement: Decodable { let id: String?; let ok: Bool?; let consoleId: String? }
struct Invitation: Decodable { let token: String }
struct Events: Decodable { struct Event: Decodable { let id: Int64 }; let events: [Event] }
struct Snapshot: Codable { var games: [Game]; var consoles: [Console]; var jobs: [Job]; var featured: Featured?; var library: [LibraryEntry]; var consoleId: String }
func bytes(_ number: Int64) -> String { ByteCountFormatter.string(fromByteCount: number, countStyle: .file) }
func readable(_ state: String) -> String { state.replacingOccurrences(of: "_", with: " ").capitalized }
