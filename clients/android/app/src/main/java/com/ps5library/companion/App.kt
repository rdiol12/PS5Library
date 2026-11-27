package com.ps5library.companion

import android.app.Application
import com.ps5library.companion.data.Repository

/**
 * Holds the single [Repository] instance. The repository owns the active
 * authenticated client, so it must be shared across every ViewModel.
 */
class App : Application() {
    val repository: Repository by lazy { Repository(applicationContext) }
}
