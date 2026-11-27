package com.ps5library.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ps5library.companion.App
import com.ps5library.companion.data.Account
import com.ps5library.companion.data.Job
import com.ps5library.companion.data.Repository
import com.ps5library.companion.data.Snapshot
import kotlinx.coroutines.Job as CoJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

sealed interface Auth {
    data object Loading : Auth
    data object SignedOut : Auth
    data class SignedIn(val account: Account) : Auth
}

/**
 * The session hub: owns auth state, the live catalog/console/job snapshot,
 * the polling loop and the live-events WebSocket. Every content screen reads
 * from here; [ConnectViewModel] performs the sign-in and hands the account to
 * [adopt].
 */
class SessionViewModel(app: Application) : AndroidViewModel(app) {

    val repository: Repository = (app as App).repository

    private val _auth = MutableStateFlow<Auth>(Auth.Loading)
    val auth: StateFlow<Auth> = _auth.asStateFlow()

    private val _snapshot = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _offline = MutableStateFlow(false)
    val offline: StateFlow<Boolean> = _offline.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _liveConnected = MutableStateFlow(false)
    val liveConnected: StateFlow<Boolean> = _liveConnected.asStateFlow()

    private var pollJob: CoJob? = null
    private var liveJob: CoJob? = null

    init {
        val account = repository.tokens.load()
        if (account != null) {
            repository.bind(account)
            _auth.value = Auth.SignedIn(account)
            startSession()
        } else {
            _auth.value = Auth.SignedOut
        }
    }

    /** Called by [ConnectViewModel] after a successful sign-in. */
    fun adopt(account: Account) {
        _auth.value = Auth.SignedIn(account)
        startSession()
    }

    private fun startSession() {
        stopSession()
        _loading.value = true
        pollJob = viewModelScope.launch {
            refreshNow()
            while (true) {
                delay(if (_liveConnected.value) 30_000L else 3_000L)
                refreshNow()
            }
        }
        liveJob = viewModelScope.launch { collectEvents() }
    }

    private fun stopSession() {
        pollJob?.cancel(); pollJob = null
        liveJob?.cancel(); liveJob = null
        _liveConnected.value = false
    }

    suspend fun refreshNow() {
        try {
            val next = repository.refresh()
            _snapshot.value = next
            _offline.value = false
            _error.value = null
        } catch (e: Exception) {
            _offline.value = true
            if (_snapshot.value.games.isEmpty()) {
                _error.value = e.message ?: "Cannot reach PS5Library."
            }
        } finally {
            _loading.value = false
        }
    }

    private suspend fun collectEvents() {
        var cursor = 0L
        while (true) {
            try {
                repository.events(cursor)
                    .catch { _liveConnected.value = false }
                    .collect { batch ->
                        _liveConnected.value = true
                        _offline.value = false
                        var needsRefresh = false
                        val jobs = _snapshot.value.jobs.toMutableList()
                        for (event in batch.events) {
                            cursor = maxOf(cursor, event.id)
                            val index = jobs.indexOfFirst { it.id == event.jobId }
                            if (index >= 0) {
                                jobs[index] = jobs[index].applying(event)
                            } else {
                                needsRefresh = true
                            }
                            if (event.terminal) needsRefresh = true
                        }
                        if (batch.events.isNotEmpty()) {
                            _snapshot.value = _snapshot.value.copy(jobs = jobs)
                        }
                        if (needsRefresh) refreshNow()
                    }
            } catch (_: Exception) {
                // fall through to reconnect
            }
            _liveConnected.value = false
            delay(5_000L)
        }
    }

    fun refresh() {
        viewModelScope.launch { refreshNow() }
    }

    fun control(job: Job, action: String) {
        viewModelScope.launch {
            try {
                repository.control(job.id, action)
                refreshNow()
            } catch (e: Exception) {
                _error.value = e.message ?: "Could not update the job."
            }
        }
    }

    fun dismiss(job: Job) {
        viewModelScope.launch {
            try {
                repository.dismiss(job.id)
                refreshNow()
            } catch (e: Exception) {
                _error.value = e.message ?: "Could not dismiss the job."
            }
        }
    }

    fun removeInstallation(id: String) {
        viewModelScope.launch {
            try {
                repository.removeInstallation(id)
                refreshNow()
            } catch (e: Exception) {
                _error.value = e.message ?: "Could not remove the installation."
            }
        }
    }

    fun clearError() {
        _error.value = null
    }

    fun signOut() {
        stopSession()
        _snapshot.value = Snapshot()
        viewModelScope.launch { repository.logout() }
        _auth.value = Auth.SignedOut
    }
}
