import Foundation

struct CommunityStatus: Decodable {
    let configured: Bool
    let displayName: String?
    let serverId: String?
    let state: String
    let userCode: String?
    let verificationUriComplete: String?
    let expiresAt: String?
    let banReason: String?
    let error: String?
    let updatedAt: String?
}

struct CommunityRequest: Encodable {
    let displayName: String
}

struct CommunityIdentity: Decodable {
    let id: String
    let handle: String
    let displayName: String
}

struct CommunityAccountStatus: Decodable {
    let configured: Bool
    let state: String
    let userCode: String?
    let verificationUriComplete: String?
    let expiresAt: String?
    let account: CommunityIdentity?
    let error: String?
    let updatedAt: String?
}

struct CommunityIdentityRequest: Encodable {
    let deviceName: String
}

struct CommunityGameSessionSummary: Decodable {
    let id: String
    let adapterId: String
    let gameTitleId: String
    let gameVersion: String
    let playerCount: Int
    let maxPlayers: Int
    let expiresAt: String
}

struct CommunityFriend: Decodable, Identifiable {
    let id: String
    let handle: String
    let displayName: String
    let state: String
    let updatedAt: String?
    let session: CommunityGameSessionSummary?
}

struct CommunityFriendRequest: Decodable, Identifiable {
    let id: String
    let createdAt: String
    let from: CommunityIdentity?
    let to: CommunityIdentity?
}

struct CommunityFriendRequests: Decodable {
    let incoming: [CommunityFriendRequest]
    let outgoing: [CommunityFriendRequest]
}

struct CommunityFriendRequestBody: Encodable {
    let handle: String
}

struct Profile: Decodable {
    let username: String
    let role: String
    let avatarUrl: String?
    let consoles: [ProfileConsole]
}

struct ProfileConsole: Decodable, Identifiable {
    let id: String
    let name: String
    let trophySummary: TrophySummary?
    let trophySyncedAt: String?
    let games: [ProfileGame]
    let saveData: [SaveSlot]?
}

struct SaveSlot: Decodable, Identifiable {
    var id: String { localUserId + "|" + platform + "|" + saveTitleId + "|" + directory }
    let localUserId: String
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let directory: String
    let title: String
    let subtitle: String
    let detail: String
    let sizeBytes: Int64
    let modifiedAt: Double
}

struct SaveBackupRequest: Encodable {
    let localUserId: String
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let directory: String
}

struct SaveBackup: Decodable, Identifiable {
    let id: String
    let consoleId: String
    let localUserId: String
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let directory: String
    let sourceModifiedAt: Int64
    let format: String
    let state: String
    let totalBytes: Int64?
    let uploadedBytes: Int64
    let sha256: String?
    let error: String?
    let createdAt: String
    let updatedAt: String
    let downloadUrl: String?
    var progress: Double? { byteFraction(uploadedBytes, totalBytes) }

    var downloadable: Bool {
        state == "READY" && totalBytes == uploadedBytes && totalBytes != nil && sha256?.range(
            of: "^[a-f0-9]{64}$",
            options: .regularExpression
        ) != nil && downloadUrl == "/api/v1/save-backups/\(id)/download"
    }
}

struct CommunityTerms: Decodable {
    let version: String
    let sha256: String
    let body: String
    let acceptLabel: String
    let accepted: Bool
}

struct PortableSave: Decodable, Identifiable {
    let id: String
    let origin: String
    let consoleId: String?
    let localUserId: String?
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let directory: String
    let gameVersion: String
    let state: String
    let totalBytes: Int64?
    let uploadedBytes: Int64
    let displayName: String?
    let masterPublicationId: String?
    let masterState: String?
    let error: String?
    var progress: Double? { byteFraction(uploadedBytes, totalBytes) }
}

struct SaveImport: Decodable, Identifiable {
    let id: String
    let archiveId: String
    let consoleId: String
    let localUserId: String
    let rollbackBackupId: String
    let state: String
    let rollbackState: String
    let displayName: String?
    let gameTitleId: String
    let gameVersion: String
    let saveTitleId: String
    let directory: String
    let downloadedBytes: Int64
    let totalBytes: Int64
    let speedBytesPerSecond: Int64
    let error: String?
    var progress: Double { byteFraction(downloadedBytes, totalBytes) ?? 0 }
}

struct CommunitySaveCatalog: Decodable {
    struct Version: Decodable {
        let gameVersion: String
        let saves: [CommunitySave]
    }

    let gameTitleId: String
    let versions: [Version]
}

struct CommunitySave: Decodable, Identifiable {
    let id: String
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let gameVersion: String
    let region: String?
    let displayName: String
    let description: String
    let size: Int64
    let publisher: String
}

struct SaveExportRequest: Encodable {
    let localUserId: String
    let platform: String
    let gameTitleId: String
    let saveTitleId: String
    let directory: String
    let gameVersion: String
}

struct CommunityConsent: Encodable {
    let accepted: Bool
    let termsVersion: String
    let termsSha256: String
}

struct PortablePublication: Encodable {
    let displayName: String
    let description: String
}

struct CommunityDownloadRequest: Encodable {
    let consoleId: String
    let gameTitleId: String
    let gameVersion: String
}

struct SaveImportRequest: Encodable {
    let consoleId: String
    let localUserId: String
}

struct SaveTaskCreated: Decodable {
    let id: String?
    let state: String
    let rollbackBackupId: String?
    let publicationId: String?
}

struct ProfileGame: Decodable, Identifiable {
    var id: String { gameId }
    let gameId: String
    let title: String
    let titleId: String
    let platform: String
    let available: Bool
    let coverUrl: String
    let versions: [String]
}

struct TrophySummary: Decodable {
    struct Counts: Decodable {
        let platinum: Int
        let gold: Int
        let silver: Int
        let bronze: Int
    }

    let modifiedAt: Double
    let earnedTrophies: Counts
}

struct Notice: Decodable, Identifiable {
    let id: String
    let consoleId: String?
    let code: String
    let message: String
    let createdAt: String
}
