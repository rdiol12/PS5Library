package com.ps5library.companion.ui

import androidx.lifecycle.ViewModel
import com.ps5library.companion.data.Game
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Holds the library search query and performs filtering. */
class LibraryViewModel : ViewModel() {

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    fun onQuery(value: String) {
        _query.value = value
    }

    fun filter(games: List<Game>, query: String): List<Game> {
        val q = query.trim()
        val matched = if (q.isEmpty()) {
            games
        } else {
            games.filter { game ->
                val haystack = buildList {
                    add(game.title)
                    add(game.titleId)
                    game.publisher?.let { add(it) }
                    game.genres?.let { addAll(it) }
                }.joinToString(" ")
                haystack.contains(q, ignoreCase = true)
            }
        }
        return matched.sortedBy { it.title.lowercase() }
    }
}
