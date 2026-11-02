package com.wbtv.tv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL

/** Tiny client for the WBTV server's JSON API. `key` is the access key when the server has a password set. */
class Api(rawBase: String, val key: String = "") {
    val base: String = normalise(rawBase)

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    private suspend fun request(method: String, path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            if (key.isNotEmpty()) c.setRequestProperty("Authorization", "Bearer $key")
            c.connectTimeout = 5000
            c.readTimeout = 20000
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            if (c.responseCode !in 200..299) error("HTTP ${c.responseCode}")
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }

    private suspend fun get(path: String) = request("GET", path)

    suspend fun channels(): List<Channel> = json.decodeFromString(get("/api/channels"))

    suspend fun epg(from: Long, to: Long): EpgResponse = json.decodeFromString(get("/api/epg?from=$from&to=$to"))

    suspend fun item(id: Int): ItemDetail = json.decodeFromString(get("/api/items/$id"))

    // ---- server settings (ads, announcements, rescans, pause buffer...) ----
    suspend fun settings(): JsonObject = json.parseToJsonElement(get("/api/settings")).jsonObject

    suspend fun putSettings(patch: Map<String, Any>): JsonObject {
        val body = buildJsonObject {
            for ((k, v) in patch) when (v) {
                is Boolean -> put(k, v)
                is Number -> put(k, v)
                else -> put(k, v.toString())
            }
        }
        return json.parseToJsonElement(request("PUT", "/api/settings", body.toString())).jsonObject
    }

    suspend fun scanNow() { request("POST", "/api/scan", "{}") }

    suspend fun scanStatus(): JsonObject = json.parseToJsonElement(get("/api/scan")).jsonObject

    private val keyQ get() = if (key.isEmpty()) "" else "&key=$key"

    fun liveUrl(channelId: Int, viewer: String) = "$base/live/$channelId/index.m3u8?v=$viewer$keyQ"

    fun artUrl(itemId: Int) = "$base/api/art/$itemId" + if (key.isEmpty()) "" else "?key=$key"

    /** Tell the server we stopped watching so it can shut the channel's encoder down. */
    suspend fun leave(channelId: Int, viewer: String) = withContext(Dispatchers.IO) {
        runCatching {
            val c = URL("$base/live/$channelId/stop?v=$viewer$keyQ").openConnection() as HttpURLConnection
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
