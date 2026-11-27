package com.ps5library.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Gamepad
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VideogameAsset
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.ps5library.companion.ui.Auth
import com.ps5library.companion.ui.ConnectViewModel
import com.ps5library.companion.ui.LibraryViewModel
import com.ps5library.companion.ui.SessionViewModel
import com.ps5library.companion.ui.components.LocalServerImages
import com.ps5library.companion.ui.components.LoadingState
import com.ps5library.companion.ui.components.OfflineBanner
import com.ps5library.companion.ui.components.ServerImages
import com.ps5library.companion.ui.screens.ConnectScreen
import com.ps5library.companion.ui.screens.ConsolesScreen
import com.ps5library.companion.ui.screens.DownloadsScreen
import com.ps5library.companion.ui.screens.GameDetailScreen
import com.ps5library.companion.ui.screens.LibraryScreen
import com.ps5library.companion.ui.screens.SettingsScreen
import com.ps5library.companion.ui.theme.PS5LibraryTheme
import androidx.compose.runtime.CompositionLocalProvider

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            PS5LibraryTheme {
                AppRoot()
            }
        }
    }
}

private enum class Tab(val route: String, val label: String, val icon: ImageVector) {
    Library("library", "Library", Icons.Filled.VideogameAsset),
    Downloads("downloads", "Downloads", Icons.Filled.Download),
    Consoles("consoles", "My PS5", Icons.Filled.Gamepad),
    Settings("settings", "Settings", Icons.Filled.Settings),
}

@Composable
private fun AppRoot() {
    val session: SessionViewModel = viewModel()
    val connect: ConnectViewModel = viewModel()
    val auth by session.auth.collectAsStateWithLifecycle()

    // Rebuild the authenticated image context whenever the session changes.
    val serverImages = remember(auth) {
        val client = session.repository.current()
        ServerImages(loader = client?.imageLoader) { path -> client?.absoluteUrl(path) }
    }

    CompositionLocalProvider(LocalServerImages provides serverImages) {
        when (auth) {
            is Auth.Loading -> LoadingState(Modifier.fillMaxSize())
            is Auth.SignedOut -> ConnectScreen(session = session, connect = connect)
            is Auth.SignedIn -> SignedInScaffold(session = session)
        }
    }
}

@Composable
private fun SignedInScaffold(session: SessionViewModel) {
    val navController = rememberNavController()
    val library: LibraryViewModel = viewModel()
    val snackbar = remember { SnackbarHostState() }

    val error by session.error.collectAsStateWithLifecycle()
    val offline by session.offline.collectAsStateWithLifecycle()

    LaunchedEffect(error) {
        val message = error
        if (message != null) {
            snackbar.showSnackbar(message)
            session.clearError()
        }
    }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val showBottomBar = Tab.entries.any { it.route == currentRoute }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            if (showBottomBar) {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    Tab.entries.forEach { tab ->
                        val selected = backStackEntry?.destination?.hierarchy
                            ?.any { it.route == tab.route } == true
                        NavigationBarItem(
                            selected = selected,
                            onClick = {
                                navController.navigate(tab.route) {
                                    popUpTo(navController.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (offline) OfflineBanner()
            NavHost(
                navController = navController,
                startDestination = Tab.Library.route,
                modifier = Modifier.fillMaxSize(),
            ) {
                composable(Tab.Library.route) {
                    LibraryScreen(
                        session = session,
                        library = library,
                        onOpenGame = { id -> navController.navigate("game/$id") },
                    )
                }
                composable(Tab.Downloads.route) {
                    DownloadsScreen(session = session)
                }
                composable(Tab.Consoles.route) {
                    ConsolesScreen(session = session)
                }
                composable(Tab.Settings.route) {
                    SettingsScreen(session = session)
                }
                composable("game/{gameId}") { entry ->
                    GameDetailScreen(
                        session = session,
                        gameId = entry.arguments?.getString("gameId").orEmpty(),
                        onBack = { navController.popBackStack() },
                    )
                }
            }
        }
    }
}
