package com.wbtv.tv

import android.content.Context
import androidx.core.content.edit

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("wbtv", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit { putString("server", v) }

    var key: String
        get() = sp.getString("key", "") ?: ""
        set(v) = sp.edit { putString("key", v) }

    var theme: String
        get() = sp.getString("theme", "classic") ?: "classic"
        set(v) = sp.edit { putString("theme", v) }

    var autoFullscreen: Boolean
        get() = sp.getBoolean("autoFullscreen", true)
        set(v) = sp.edit { putBoolean("autoFullscreen", v) }

    var filter: String
        get() = sp.getString("filter", "all") ?: "all"
        set(v) = sp.edit { putString("filter", v) }

    var lastChannel: Int
        get() = sp.getInt("lastChannel", -1)
        set(v) = sp.edit { putInt("lastChannel", v) }
}
