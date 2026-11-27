package com.ps5library.companion.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Gamepad
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ps5library.companion.data.Console
import com.ps5library.companion.data.Storage
import com.ps5library.companion.data.formatBytes
import com.ps5library.companion.data.readable
import com.ps5library.companion.ui.SessionViewModel
import com.ps5library.companion.ui.components.EmptyState

@Composable
fun ConsolesScreen(
    session: SessionViewModel,
    modifier: Modifier = Modifier,
) {
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val consoles = snapshot.consoles

    if (consoles.isEmpty()) {
        EmptyState(
            icon = Icons.Filled.Gamepad,
            title = "No consoles linked",
            detail = "Link a PS5 to your PS5Library server to see it here.",
            modifier = modifier,
        )
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(consoles, key = { it.id }) { console ->
            ConsoleCard(console)
        }
    }
}

@Composable
private fun ConsoleCard(console: Console) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PresenceDot(console.presence)
                Spacer(Modifier.size(8.dp))
                Text(console.name, style = MaterialTheme.typography.titleMedium)
                if (console.isDefault) {
                    Icon(
                        Icons.Filled.Star,
                        contentDescription = "Default",
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier
                            .padding(start = 6.dp)
                            .size(16.dp),
                    )
                }
            }
            val summary = buildList {
                add(console.presence.readable())
                console.firmware?.let { add("FW $it") }
                add("${console.games} games")
            }.joinToString(" · ")
            Text(
                summary,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )

            if (console.storage.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                console.storage.forEach { storage ->
                    StorageRow(storage)
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
    }
}

@Composable
private fun PresenceDot(presence: String) {
    val color = when (presence.lowercase()) {
        "online", "available" -> MaterialTheme.colorScheme.secondary
        "standby", "rest" -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun StorageRow(storage: Storage) {
    val used = (storage.totalBytes - storage.freeBytes).coerceAtLeast(0)
    val fraction = if (storage.totalBytes > 0) {
        (used.toFloat() / storage.totalBytes.toFloat()).coerceIn(0f, 1f)
    } else 0f
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(storage.displayName, style = MaterialTheme.typography.labelLarge)
            Text(
                "${formatBytes(storage.freeBytes)} free",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(4.dp))
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "${formatBytes(used)} of ${formatBytes(storage.totalBytes)} used" +
                if (!storage.writable) " · read-only" else "",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}
