package com.ps5library.companion.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VideogameAsset
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ps5library.companion.data.Game
import com.ps5library.companion.ui.LibraryViewModel
import com.ps5library.companion.ui.SessionViewModel
import com.ps5library.companion.ui.components.EmptyState
import com.ps5library.companion.ui.components.LoadingState
import com.ps5library.companion.ui.components.ServerImage

@Composable
fun LibraryScreen(
    session: SessionViewModel,
    library: LibraryViewModel,
    onOpenGame: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val loading by session.loading.collectAsStateWithLifecycle()
    val query by library.query.collectAsStateWithLifecycle()
    val games = remember(snapshot.games, query) { library.filter(snapshot.games, query) }

    Column(modifier = modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = library::onQuery,
            placeholder = { Text("Search games") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )

        when {
            loading && snapshot.games.isEmpty() -> LoadingState()
            games.isEmpty() -> EmptyState(
                icon = Icons.Filled.VideogameAsset,
                title = if (query.isBlank()) "No games yet" else "No matches",
                detail = if (query.isBlank())
                    "Add sources on your PS5Library server to populate the catalog."
                else "Try a different search.",
            )
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 150.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(games, key = { it.id }) { game ->
                    GameCard(game = game, onClick = { onOpenGame(game.id) })
                }
            }
        }
    }
}

@Composable
private fun GameCard(game: Game, onClick: () -> Unit) {
    Column(
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(0.72f)
                .clip(RoundedCornerShape(12.dp)),
        ) {
            ServerImage(path = game.coverUrl, modifier = Modifier.fillMaxSize())
        }
        Text(
            game.title,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        if (game.publisher != null) {
            Text(
                game.publisher,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
