package com.ps5library.companion.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Securely persists the signed-in account (server + token) with EncryptedSharedPreferences. */
class TokenStore(context: Context) {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "ps5library-session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun load(): Account? {
        val server = prefs.getString(KEY_SERVER, null) ?: return null
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        val username = prefs.getString(KEY_USERNAME, null) ?: return null
        val role = prefs.getString(KEY_ROLE, null) ?: "user"
        val fallback = prefs.getString(KEY_FALLBACK, null)
        return Account(
            server = server,
            username = username,
            role = role,
            token = token,
            fallbackServer = fallback,
        )
    }

    fun save(account: Account) {
        prefs.edit()
            .putString(KEY_SERVER, account.server)
            .putString(KEY_TOKEN, account.token)
            .putString(KEY_USERNAME, account.username)
            .putString(KEY_ROLE, account.role)
            .putString(KEY_FALLBACK, account.fallbackServer)
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_SERVER = "server"
        const val KEY_TOKEN = "token"
        const val KEY_USERNAME = "username"
        const val KEY_ROLE = "role"
        const val KEY_FALLBACK = "fallback"
    }
}
