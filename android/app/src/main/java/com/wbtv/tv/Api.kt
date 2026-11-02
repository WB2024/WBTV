package com.wbtv.tv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL

/** Tiny client for the WBTV server's JSON API (no auth, plain LAN http). */
class Api(rawBase: String) {
    val base: String = normalise(rawBase)

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 5000
            c.readTimeout = 20000
            if (c.responseCode !in 200..299) error("HTTP ${c.responseCode}")
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }

    suspend fun channels(): List<Channel> = json.decodeFromString(get("/api/channels"))

    suspend fun epg(from: Long, to: Long): EpgResponse = json.decodeFromString(get("/api/epg?from=$from&to=$to"))

    suspend fun item(id: Int): ItemDetail = json.decodeFromString(get("/api/items/$id"))

    fun liveUrl(channelId: Int, viewer: String) = "$base/live/$channelId/index.m3u8?v=$viewer"

    fun artUrl(itemId: Int) = "$base/api/art/$itemId"

    /** Tell the server we stopped watching so it can shut the channel's encoder down. */
    suspend fun leave(channelId: Int, viewer: String) = withContext(Dispatchers.IO) {
        runCatching {
            val c = URL("$base/live/$channelId/stop?v=$viewer").openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = 3000
            c.readTimeout = 3000
            c.responseCode
            c.disconnect()
        }
    }

    companion object {
        fun normalise(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (s.isEmpty()) return ""
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            return s
        }
    }
}
