package com.ps5library.companion.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Mirrors the iOS companion's server-address policy: HTTPS is always accepted,
 * plain HTTP only for loopback / .local / private-LAN / Tailscale-style hosts.
 */
object ServerAddress {

    /** Normalize user input into a validated base origin, or null if it is not allowed. */
    fun normalize(input: String): String? {
        val value = input.trim()
        if (value.isEmpty()) return null
        val candidate = if (value.contains("://")) value else "http://$value"
        val url = candidate.toHttpUrlOrNull() ?: return null
        // Reject anything carrying a path, query, fragment or credentials.
        if (url.encodedPath != "/" && url.encodedPath.isNotEmpty()) return null
        if (url.querySize != 0 || url.fragment != null) return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        if (!isAllowed(url)) return null
        // Rebuild a clean origin (scheme://host[:port]).
        val port = if (url.port == HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
        return "${url.scheme}://${url.host}$port"
    }

    fun isAllowed(url: HttpUrl): Boolean {
        val scheme = url.scheme.lowercase()
        if (scheme == "https") return true
        if (scheme != "http") return false
        return isPrivateHost(url.host.lowercase())
    }

    private fun isPrivateHost(rawHost: String): Boolean {
        val host = rawHost.trim('[', ']')
        val plain = host.substringBefore('%')
        if (plain == "localhost" || plain.endsWith(".local")) return true

        val octets = plain.split('.')
        if (octets.size == 4 && octets.all { it.isValidOctet() }) {
            val a = octets[0].toInt()
            val b = octets[1].toInt()
            return a == 10 ||
                a == 127 ||
                (a == 172 && b in 16..31) ||
                (a == 192 && b == 168) ||
                (a == 169 && b == 254) ||
                (a == 100 && b in 64..127) // Tailscale CGNAT range
        }

        if (plain.contains(':')) {
            return plain == "::1" ||
                plain.startsWith("fc") ||
                plain.startsWith("fd") ||
                listOf("fe8", "fe9", "fea", "feb").any { plain.startsWith(it) }
        }
        return false
    }

    private fun String.isValidOctet(): Boolean {
        if (isEmpty() || length > 3) return false
        if (length > 1 && startsWith("0")) return false
        if (!all { it in '0'..'9' }) return false
        return toInt() in 0..255
    }
}
