package com.ps5library.companion.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ---------------------------------------------------------------------------
// Service discovery / auth
// ---------------------------------------------------------------------------

@Serializable
data class ServiceInfo(
    val compatible: Boolean? = null,
    val service: String? = null,
    val apiVersion: Int? = null,
) {
    /** Accept the simple {compatible:true} shape or the richer node marker. */
    val isCompatible: Boolean
        get() = compatible == true || (service == "ps5library-node" && apiVersion == 1)
}

@Serializable
data class User(
    val id: String,
    val username: String,
    val role: String,
)

@Serializable
data class LoginResponse(
    val user: User,
    val token: String,
)

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
    val inviteToken: String? = null,
)

@Serializable
data class Acknowledgement(
    val ok: Boolean? = null,
    val id: String? = null,
)

@Serializable
data class Invitation(
    val token: String,
)

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

@Serializable
data class Game(
    val id: String,
    val title: String,
    val titleId: String,
    val description: String? = null,
    val publisher: String? = null,
    val genres: List<String>? = null,
    val coverUrl: String,
    val heroUrl: String,
    val screenshotUrls: List<String>? = null,
    val releases: List<Release> = emptyList(),
    val trailer: Media? = null,
    val music: Media? = null,
    val external: ExternalInfo? = null,
) {
    /** A playable (non-DLC) release that the server can actually deliver. */
    val serverAvailable: Boolean
        get() = releases.any { it.kind != "DLC" && (it.sources.isNotEmpty() || !it.artifacts.isNullOrEmpty()) }
}

/** Live third-party details the server attaches when a game is missing its own. */
@Serializable
data class ExternalInfo(
    val releaseDate: String? = null,
    val metacritic: Int? = null,
    val videos: List<String> = emptyList(),
)

/** Direct address of a trailer the server resolved; streamed, never stored. */
@Serializable
data class TrailerStream(
    val video: Track,
) {
    @Serializable
    data class Track(val url: String)
}

@Serializable
data class Release(
    val id: String,
    val version: String,
    val kind: String,
    val size: Long? = null,
    val minimumFirmware: String? = null,
    val sources: List<Source> = emptyList(),
    val artifacts: List<ReleaseArtifact>? = null,
    val title: String? = null,
) {
    val label: String
        get() = (if (kind == "DLC") "DLC: " + (title ?: "Additional content") else kind.readable()) +
            " · " + version
}

@Serializable
data class Source(
    val id: String,
    val name: String,
    val format: String,
)

@Serializable
data class ReleaseArtifact(
    val id: String,
)

@Serializable
data class Media(
    val url: String,
    val sha256: String,
    val size: Long,
    val duration: Double,
)

// ---------------------------------------------------------------------------
// Consoles
// ---------------------------------------------------------------------------

@Serializable
data class Console(
    val id: String,
    val name: String,
    val presence: String,
    val firmware: String? = null,
    val runtime: String,
    val games: Int = 0,
    val storage: List<Storage> = emptyList(),
    val isDefault: Boolean = false,
)

@Serializable
data class Storage(
    val storageId: String,
    val displayName: String,
    val totalBytes: Long,
    val freeBytes: Long,
    val writable: Boolean,
)

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

@Serializable
data class Job(
    val id: String,
    val title: String? = null,
    val releaseId: String,
    val kind: String,
    val state: String,
    val consoleId: String? = null,
    val storageId: String? = null,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val speedBytesPerSecond: Long = 0,
    val etaSeconds: Int? = null,
    val error: String? = null,
    val queuePosition: Int? = null,
    val location: String? = null,
    val progress: BuildProgress? = null,
) {
    val retryable: Boolean get() = state == "ERROR"

    val dismissible: Boolean
        get() = state in setOf("COMPLETED", "READY_ON_PS5", "ERROR", "CANCELLED")

    val active: Boolean
        get() = !dismissible

    /** Fraction 0..1 for the progress bar, or null when the size is unknown. */
    val fraction: Float?
        get() {
            if (kind == "BUILD" && state != "DOWNLOADING") {
                return progress?.fraction
            }
            val total = totalBytes ?: return null
            if (total <= 0) return null
            return (downloadedBytes.toFloat() / total.toFloat()).coerceIn(0f, 1f)
        }

    val displayStage: String
        get() = when (state) {
            "COMPLETED" -> "Prepared and verified"
            "READY_ON_PS5" -> "Ready on PS5"
            "ERROR" -> "Preparation failed"
            "CANCELLED" -> "Preparation cancelled"
            else -> {
                val stage = progress?.stage
                if (!stage.isNullOrEmpty()) stage
                else if (kind != "BUILD") state.readable()
                else when (state) {
                    "QUEUED" -> "Waiting in build queue"
                    "DOWNLOADING" -> "Downloading source"
                    "EXTRACTING" -> "Extracting source"
                    "BUILDING" -> "Preparing package"
                    "VERIFYING" -> "Verifying package"
                    "RETRYING" -> "Retrying preparation"
                    else -> state.readable()
                }
            }
        }

    /** Apply a live progress event, returning an updated copy. */
    fun applying(event: LiveEvent): Job = copy(
        state = event.state,
        downloadedBytes = event.progress.downloadedBytes,
        totalBytes = event.progress.totalBytes,
        speedBytesPerSecond = event.progress.speedBytesPerSecond,
        etaSeconds = event.progress.etaSeconds,
        progress = event.progress.conversion ?: progress,
    )
}

@Serializable
data class BuildProgress(
    val stage: String? = null,
    val completedStages: Int? = null,
    val totalStages: Int? = null,
    val operation: ByteProgress? = null,
    val extraction: ByteProgress? = null,
    val staging: ByteProgress? = null,
) {
    private val bytes: ByteProgress? get() = operation ?: extraction ?: staging
    val fraction: Float? get() = bytes?.fraction
}

@Serializable
data class ByteProgress(
    val completedBytes: Long,
    val totalBytes: Long,
) {
    val fraction: Float?
        get() = if (totalBytes > 0) (completedBytes.toFloat() / totalBytes.toFloat()).coerceIn(0f, 1f) else null
}

@Serializable
data class JobControl(
    val action: String,
)

// ---------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------

@Serializable
data class Installation(
    val id: String,
    val title: String,
    val state: String,
    val error: String? = null,
    val method: String,
    val consoleId: String,
    val storageId: String,
)

// ---------------------------------------------------------------------------
// Live events (WebSocket)
// ---------------------------------------------------------------------------

@Serializable
data class LiveEvents(
    val events: List<LiveEvent> = emptyList(),
)

@Serializable
data class LiveEvent(
    val id: Long,
    val jobId: String,
    val state: String,
    val progress: LiveProgress,
    val createdAt: String? = null,
) {
    val terminal: Boolean
        get() = state in setOf("COMPLETED", "READY_ON_PS5", "ERROR", "CANCELLED")
}

@Serializable
data class LiveProgress(
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val speedBytesPerSecond: Long = 0,
    val etaSeconds: Int? = null,
    val conversion: BuildProgress? = null,
)

// ---------------------------------------------------------------------------
// Persisted session
// ---------------------------------------------------------------------------

@Serializable
data class Account(
    val server: String,
    val username: String,
    val role: String,
    val token: String,
    val fallbackServer: String? = null,
)

/** Everything the UI renders from a single refresh. */
data class Snapshot(
    val games: List<Game> = emptyList(),
    val consoles: List<Console> = emptyList(),
    val jobs: List<Job> = emptyList(),
    val installations: List<Installation> = emptyList(),
)

@Serializable
data class InstallationPlanRequest(
    val sourceReleaseId: String,
    val consoleId: String,
    val method: String? = null,
)

@Serializable
data class InstallationRequest(
    val sourceReleaseId: String,
    val consoleId: String,
    val storageId: String,
    val method: String? = null,
)

@Serializable
data class InstallationPlan(
    val method: String? = null,
    val methods: List<String> = emptyList(),
    val compatibility: Compatibility = Compatibility(),
    val storage: List<PlanDestination> = emptyList(),
    val allowed: Boolean = false,
    val reason: String = "",
    val online: Boolean? = null,
    val estimated: Boolean = false,
    val message: String? = null,
) {
    @Serializable
    data class Compatibility(
        val status: String = "",
        val method: String? = null,
    )

    @Serializable
    data class PlanDestination(
        val storageId: String,
        val displayName: String = "",
        val freeBytes: Long = 0,
        val requiredBytes: Long = 0,
        val allowed: Boolean = false,
    )
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

fun String.readable(): String =
    replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }

fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit++
    }
    return if (unit == 0) "${bytes} B" else String.format("%.1f %s", value, units[unit])
}

fun formatSpeed(bytesPerSecond: Long): String =
    if (bytesPerSecond <= 0) "" else "${formatBytes(bytesPerSecond)}/s"

fun formatEta(seconds: Int?): String {
    val s = seconds ?: return ""
    if (s <= 0) return ""
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return when {
        h > 0 -> "${h}h ${m}m left"
        m > 0 -> "${m}m ${sec}s left"
        else -> "${sec}s left"
    }
}
