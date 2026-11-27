package com.ps5library.companion.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Single source of truth for all server communication. Holds the active
 * [ApiClient] once a session is bound, and exposes suspend/flow APIs the
 * ViewModels call. Mirrors the iOS Store's behaviour (partial-refresh
 * tolerance, live job events) in idiomatic Kotlin.
 */
class Repository(private val context: Context) {

    val tokens = TokenStore(context)

    @Volatile
    private var client: ApiClient? = null

    fun current(): ApiClient? = client

    fun absoluteUrl(path: String?): String? = client?.absoluteUrl(path)

    /** Validate a server address before showing the sign-in form. */
    suspend fun validate(server: String): Boolean = withContext(Dispatchers.IO) {
        val origin = ServerAddress.normalize(server)
            ?: throw IOException("Enter HTTPS, or a private LAN / Tailscale address such as 192.168.1.20:13150.")
        val http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()
        val request = Request.Builder()
            .url("$origin/api/v1/service-info")
            .header("X-PS5Library-Client", "companion")
            .header("Accept", "application/json")
            .build()
        val response: Response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw IOException("Cannot reach a PS5Library server at that address.")
        }
        response.use {
            if (!it.isSuccessful) {
                throw IOException("This address is not a compatible PS5Library server.")
            }
            val body = it.body?.bytes() ?: ByteArray(0)
            if (body.size > 1024) {
                throw IOException("This address is not a compatible PS5Library server.")
            }
            val info = runCatching {
                ApiClient.json.decodeFromString(ServiceInfo.serializer(), String(body))
            }.getOrNull()
            if (info?.isCompatible != true) {
                throw IOException("This address is not a compatible PS5Library server.")
            }
            true
        }
    }

    /**
     * Sign in or register; returns the account to persist/bind. Validates the
     * primary address (and the fallback if one was supplied) first. Login runs
     * against the primary origin, with the fallback tried on connection failure.
     */
    suspend fun authenticate(
        server: String,
        fallbackServer: String?,
        username: String,
        password: String,
        register: Boolean,
        inviteToken: String,
    ): Account = withContext(Dispatchers.IO) {
        val origin = ServerAddress.normalize(server)
            ?: throw IOException("Enter HTTPS, or a private LAN / Tailscale address such as 192.168.1.20:13150.")
        val fallbackOrigin = fallbackServer?.takeIf { it.isNotBlank() }?.let {
            ServerAddress.normalize(it)
                ?: throw IOException("Enter a valid Tailscale address such as 100.100.1.1:13150.")
        }?.takeIf { it != origin }

        validate(origin)
        if (fallbackOrigin != null) validate(fallbackOrigin)

        val anon = ApiClient.create(context, origin, token = "", fallbackUrl = fallbackOrigin)
        val body = LoginRequest(
            username = username,
            password = password,
            inviteToken = if (register) inviteToken.ifBlank { null } else null,
        )
        val result = try {
            if (register) anon.service.register(body) else anon.service.login(body)
        } catch (e: Exception) {
            throw IOException(friendly(e, register))
        }
        Account(
            server = origin,
            username = result.user.username,
            role = result.user.role,
            token = result.token,
            fallbackServer = fallbackOrigin,
        )
    }

    /** Bind an account as the active session (after login or on relaunch). */
    fun bind(account: Account) {
        client = ApiClient.create(context, account.server, account.token, account.fallbackServer)
    }

    suspend fun refresh(): Snapshot = withContext(Dispatchers.IO) {
        val api = client ?: throw IOException("Not signed in.")
        coroutineScope {
            val games = async { runCatching { api.service.catalog() }.getOrNull() }
            val consoles = async { runCatching { api.service.consoles() }.getOrNull() }
            val jobs = async { runCatching { api.service.jobs() }.getOrNull() }
            val installations = async { runCatching { api.service.installations() }.getOrNull() }
            awaitAll(games, consoles, jobs, installations)
            val g = games.await()
            val c = consoles.await()
            val j = jobs.await()
            val i = installations.await()
            if (g == null && c == null && j == null && i == null) {
                throw IOException("Cannot reach PS5Library.")
            }
            Snapshot(
                games = g ?: emptyList(),
                consoles = c ?: emptyList(),
                jobs = j ?: emptyList(),
                installations = i ?: emptyList(),
            )
        }
    }

    suspend fun control(jobId: String, action: String) = withContext(Dispatchers.IO) {
        client?.service?.controlJob(jobId, JobControl(action))
        Unit
    }

    suspend fun dismiss(jobId: String) = withContext(Dispatchers.IO) {
        client?.service?.dismissJob(jobId)
        Unit
    }

    suspend fun removeInstallation(id: String) = withContext(Dispatchers.IO) {
        client?.service?.removeInstallation(id)
        Unit
    }

    suspend fun planInstallation(
        sourceReleaseId: String,
        consoleId: String,
        method: String?,
    ): InstallationPlan? = withContext(Dispatchers.IO) {
        client?.service?.planInstallation(
            InstallationPlanRequest(sourceReleaseId, consoleId, method),
        )
    }

    suspend fun requestInstallation(request: InstallationRequest) = withContext(Dispatchers.IO) {
        client?.service?.requestInstallation(request)
        Unit
    }

    suspend fun createInvite(): Invitation? = withContext(Dispatchers.IO) {
        client?.service?.createInvite()
    }

    suspend fun logout() {
        val api = client
        client = null
        tokens.clear()
        if (api != null) {
            withContext(Dispatchers.IO) { runCatching { api.service.logout() } }
        }
    }

    /**
     * Cold flow of live event batches from the server WebSocket. The collector
     * is responsible for merging them into job state; it completes (closes the
     * socket) on failure so the caller can fall back to polling.
     */
    fun events(after: Long): Flow<LiveEvents> = callbackFlow {
        val api = client
        if (api == null) {
            close()
            return@callbackFlow
        }
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val batch = runCatching {
                    ApiClient.json.decodeFromString(LiveEvents.serializer(), text)
                }.getOrNull()
                if (batch != null) trySend(batch)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                close(t)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close()
            }
        }
        val socket = api.openEvents(after, listener)
        awaitClose { socket.cancel() }
    }

    private fun friendly(e: Exception, register: Boolean): String {
        val message = e.message ?: ""
        return when {
            message.contains("401") || message.contains("403") ->
                if (register) "Registration was rejected. Check the invite token."
                else "Incorrect username or password."
            else -> if (register) "Could not create the account." else "Could not sign in."
        }
    }
}
