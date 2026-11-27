package com.ps5library.companion.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ps5library.companion.data.Game
import com.ps5library.companion.data.Release
import com.ps5library.companion.data.formatBytes
import com.ps5library.companion.ui.SessionViewModel
import com.ps5library.companion.ui.components.EmptyState
import com.ps5library.companion.ui.components.ServerImage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GameDetailScreen(
    session: SessionViewModel,
    gameId: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val game = snapshot.games.firstOrNull { it.id == gameId }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(game?.title ?: "Game", maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        if (game == null) {
            EmptyState(
                icon = Icons.Filled.Error,
                title = "Game not found",
                detail = "It may have been removed from the catalog.",
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }
        GameDetailContent(
            game = game,
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun GameDetailContent(game: Game, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .clip(RoundedCornerShape(0.dp)),
        ) {
            ServerImage(path = game.heroUrl, modifier = Modifier.fillMaxSize())
        }

        Column(modifier = Modifier.padding(16.dp)) {
            Text(game.title, style = MaterialTheme.typography.headlineSmall)
            if (game.publisher != null) {
                Text(
                    game.publisher,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }

            if (!game.genres.isNullOrEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 12.dp),
                ) {
                    game.genres.forEach { genre ->
                        AssistChip(onClick = {}, label = { Text(genre) })
                    }
                }
            }

            // Availability-only primary action (full install flow is intentionally out of scope).
            Spacer(Modifier.height(16.dp))
            val available = game.serverAvailable
            Button(
                onClick = {},
                enabled = available,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.CloudDownload, contentDescription = null)
                Text(
                    if (available) "Available to download & prepare" else "Not available on this server",
                    modifier = Modifier.padding(start = 8.dp),
                )
            }

            if (game.description != null) {
                Text(
                    "About",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
                )
                Text(
                    game.description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (game.releases.isNotEmpty()) {
                Text(
                    "Releases",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
                )
                game.releases.forEach { release ->
                    ReleaseRow(release)
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
}

@Composable
private fun ReleaseRow(release: Release) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(release.label, style = MaterialTheme.typography.bodyLarge)
                val detail = buildList {
                    release.size?.let { add(formatBytes(it)) }
                    release.minimumFirmware?.let { add("FW $it+") }
                    if (release.sources.isNotEmpty()) add("${release.sources.size} source(s)")
                }.joinToString(" · ")
                if (detail.isNotEmpty()) {
                    Text(
                        detail,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }
    }
}
