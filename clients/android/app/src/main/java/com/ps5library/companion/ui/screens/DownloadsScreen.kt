package com.ps5library.companion.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ps5library.companion.data.Installation
import com.ps5library.companion.data.Job
import com.ps5library.companion.data.formatBytes
import com.ps5library.companion.data.formatEta
import com.ps5library.companion.data.formatSpeed
import com.ps5library.companion.data.readable
import com.ps5library.companion.ui.SessionViewModel
import com.ps5library.companion.ui.components.EmptyState

@Composable
fun DownloadsScreen(
    session: SessionViewModel,
    modifier: Modifier = Modifier,
) {
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val jobs = snapshot.jobs
    val installations = snapshot.installations

    if (jobs.isEmpty() && installations.isEmpty()) {
        EmptyState(
            icon = Icons.Filled.CheckCircle,
            title = "Nothing in progress",
            detail = "Downloads and preparation jobs will appear here with live progress.",
            modifier = modifier,
        )
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (jobs.isNotEmpty()) {
            item { SectionLabel("Jobs") }
            items(jobs, key = { it.id }) { job ->
                JobCard(
                    job = job,
                    onControl = { action -> session.control(job, action) },
                    onDismiss = { session.dismiss(job) },
                )
            }
        }
        if (installations.isNotEmpty()) {
            item { SectionLabel("Installations") }
            items(installations, key = { it.id }) { installation ->
                val dismissState = rememberSwipeToDismissBoxState(
                    confirmValueChange = { value ->
                        if (value != SwipeToDismissBoxValue.Settled) {
                            session.removeInstallation(installation.id)
                            true
                        } else {
                            false
                        }
                    },
                )
                SwipeToDismissBox(
                    state = dismissState,
                    backgroundContent = {
                        Surface(
                            color = MaterialTheme.colorScheme.errorContainer,
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            Box(
                                contentAlignment = Alignment.CenterEnd,
                                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                            ) {
                                Icon(
                                    Icons.Filled.Delete,
                                    contentDescription = "Remove installation",
                                    tint = MaterialTheme.colorScheme.onErrorContainer,
                                )
                            }
                        }
                    },
                ) {
                    InstallationCard(installation)
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 4.dp),
    )
}

@Composable
private fun JobCard(
    job: Job,
    onControl: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                job.title ?: job.kind.readable(),
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                job.displayStage,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )

            Spacer(Modifier.height(10.dp))
            val fraction = job.fraction
            if (job.active) {
                if (fraction != null) {
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            }

            val meta = buildList {
                if (fraction != null) add("${(fraction * 100).toInt()}%")
                job.totalBytes?.let { add("${formatBytes(job.downloadedBytes)} / ${formatBytes(it)}") }
                formatSpeed(job.speedBytesPerSecond).takeIf { it.isNotEmpty() }?.let { add(it) }
                formatEta(job.etaSeconds).takeIf { it.isNotEmpty() }?.let { add(it) }
                job.queuePosition?.let { if (job.state == "QUEUED") add("Queue #$it") }
            }.joinToString("  ·  ")
            if (meta.isNotEmpty()) {
                Text(
                    meta,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }

            if (job.error != null) {
                Text(
                    job.error,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    job.retryable -> {
                        TextButton(onClick = { onControl("retry") }) {
                            Icon(Icons.Filled.Refresh, contentDescription = null)
                            Text("Retry", modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                    job.active -> {
                        if (job.state == "PAUSED") {
                            TextButton(onClick = { onControl("resume") }) {
                                Icon(Icons.Filled.PlayArrow, contentDescription = null)
                                Text("Resume", modifier = Modifier.padding(start = 6.dp))
                            }
                        } else {
                            TextButton(onClick = { onControl("pause") }) {
                                Icon(Icons.Filled.Pause, contentDescription = null)
                                Text("Pause", modifier = Modifier.padding(start = 6.dp))
                            }
                        }
                        TextButton(onClick = { onControl("cancel") }) {
                            Icon(Icons.Filled.Cancel, contentDescription = null)
                            Text("Cancel", modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
                if (job.dismissible) {
                    TextButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = null)
                        Text("Dismiss", modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun InstallationCard(installation: Installation) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(installation.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${installation.state.readable()} · ${installation.method.readable()}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
            if (installation.error != null) {
                Text(
                    installation.error,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}
