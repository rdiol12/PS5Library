package com.ps5library.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ps5library.companion.App
import com.ps5library.companion.data.Account
import com.ps5library.companion.data.Repository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ConnectState(
    val lan: String = "",
    val tailscale: String = "",
    val username: String = "",
    val password: String = "",
    val invite: String = "",
    val register: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
) {
    /** LAN is primary when present; otherwise Tailscale is used as the primary. */
    val primaryAddress: String get() = lan.trim().ifBlank { tailscale.trim() }

    /** Tailscale becomes a fallback only when a LAN address is also provided. */
    val fallbackAddress: String?
        get() = if (lan.isNotBlank() && tailscale.isNotBlank()) tailscale.trim() else null

    val hasAddress: Boolean get() = lan.isNotBlank() || tailscale.isNotBlank()

    val passwordValid: Boolean get() = if (register) password.length >= 12 else password.isNotEmpty()

    val canSubmit: Boolean
        get() = hasAddress && username.isNotBlank() && passwordValid &&
            (!register || invite.isNotBlank()) && !busy
}

/**
 * Owns the Connect / Sign-in form. The user supplies a LAN/IP address and/or a
 * Tailscale address; whichever are present are validated against
 * /api/v1/service-info before authentication.
 */
class ConnectViewModel(app: Application) : AndroidViewModel(app) {

    private val repository: Repository = (app as App).repository

    private val _state = MutableStateFlow(ConnectState())
    val state: StateFlow<ConnectState> = _state.asStateFlow()

    fun onLan(value: String) {
        _state.value = _state.value.copy(lan = value, error = null)
    }

    fun onTailscale(value: String) {
        _state.value = _state.value.copy(tailscale = value, error = null)
    }

    fun onUsername(value: String) {
        _state.value = _state.value.copy(username = value, error = null)
    }

    fun onPassword(value: String) {
        _state.value = _state.value.copy(password = value, error = null)
    }

    fun onInvite(value: String) {
        _state.value = _state.value.copy(invite = value, error = null)
    }

    fun toggleRegister() {
        _state.value = _state.value.copy(register = !_state.value.register, error = null)
    }

    fun submit(onAuthenticated: (Account) -> Unit) {
        val current = _state.value
        if (!current.canSubmit) return
        _state.value = current.copy(busy = true, error = null)
        viewModelScope.launch {
            try {
                val account = repository.authenticate(
                    server = current.primaryAddress,
                    fallbackServer = current.fallbackAddress,
                    username = current.username.trim(),
                    password = current.password,
                    register = current.register,
                    inviteToken = current.invite.trim(),
                )
                repository.tokens.save(account)
                repository.bind(account)
                _state.value = ConnectState()
                onAuthenticated(account)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    busy = false,
                    error = e.message ?: "Could not sign in.",
                )
            }
        }
    }
}
