package com.ps5library.companion.data

import android.content.Context
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json

/**
 * Builds everything that is bound to a specific server origin + token:
 * the Retrofit service, a Coil image loader that sends the same auth headers,
 * and the live-events WebSocket.
 */
class ApiClient private constructor(
    val baseUrl: String,
    private val token: String,
    val service: ApiService,
    private val httpClient: OkHttpClient,
    val imageLoader: ImageLoader,
) {

    /** Resolve a possibly-relative artwork/media path against the server origin. */
    fun absoluteUrl(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val trimmedBase = baseUrl.trimEnd('/')
        val trimmedPath = if (path.startsWith("/")) path else "/$path"
        return trimmedBase + trimmedPath
    }

    /** Open the live-events WebSocket. OkHttp upgrades an http(s) URL to ws(s). */
    fun openEvents(after: Long, listener: WebSocketListener): WebSocket {
        val url = "${baseUrl.trimEnd('/')}/api/v1/events/live?after=$after"
        val request = Request.Builder().url(url).build()
        return httpClient.newWebSocket(request, listener)
    }

    companion object {
        val json: Json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            coerceInputValues = true
        }

        fun create(
            context: Context,
            baseUrl: String,
            token: String,
            fallbackUrl: String? = null,
        ): ApiClient {
            val origin = baseUrl.trimEnd('/')

            val headers = Interceptor { chain ->
                val builder = chain.request().newBuilder()
                    .header("X-PS5Library-Client", "companion")
                    .header("Accept", "application/json")
                if (token.isNotEmpty()) {
                    builder.header("Authorization", "Bearer $token")
                }
                chain.proceed(builder.build())
            }

            // Transparently retry a connection failure against the fallback origin
            // (e.g. a Tailscale address) so Retrofit, Coil and the WebSocket all route.
            val fallbackHost = fallbackUrl?.trimEnd('/')?.toHttpUrlOrNull()
            val fallback = Interceptor { chain ->
                val request = chain.request()
                try {
                    chain.proceed(request)
                } catch (e: IOException) {
                    if (fallbackHost == null) throw e
                    val rerouted = request.url.newBuilder()
                        .scheme(fallbackHost.scheme)
                        .host(fallbackHost.host)
                        .port(fallbackHost.port)
                        .build()
                    chain.proceed(request.newBuilder().url(rerouted).build())
                }
            }

            val http = OkHttpClient.Builder()
                .addInterceptor(headers)
                .addInterceptor(fallback)
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .pingInterval(25, TimeUnit.SECONDS)
                .followRedirects(false)
                .build()

            val retrofit = Retrofit.Builder()
                .baseUrl("$origin/")
                .client(http)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()

            val imageLoader = ImageLoader.Builder(context)
                .okHttpClient(http)
                .memoryCache { MemoryCache.Builder(context).maxSizePercent(0.25).build() }
                .diskCache {
                    DiskCache.Builder()
                        .directory(context.cacheDir.resolve("artwork"))
                        .maxSizeBytes(128L * 1024 * 1024)
                        .build()
                }
                .build()

            return ApiClient(origin, token, retrofit.create(ApiService::class.java), http, imageLoader)
        }
    }
}
