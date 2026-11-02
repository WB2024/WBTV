package com.wbtv.tv

import android.app.Application
import android.view.KeyEvent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/** Where the D-pad focus is while the guide is open. */
enum class Zone { GRID, TOOLBAR }

class AppVm(app: Application) : AndroidViewModel(app) {
    val prefs = Prefs(app)
    private val viewer = UUID.randomUUID().toString().take(12)
    var api: Api = Api(prefs.server, prefs.key)
        private set

    // ---- state the UI observes ------------------------------------------------
    var server by mutableStateOf(prefs.server)
    var themeId by mutableStateOf(prefs.theme)
    var autoFullscreen by mutableStateOf(prefs.autoFullscreen)
    var allChannels by mutableStateOf<List<Channel>>(emptyList())
    var channels by mutableStateOf<List<Channel>>(emptyList()) // after the filter chips
    var filter by mutableStateOf(ChannelFilter.byId(prefs.filter))
    var zone by mutableStateOf(Zone.GRID)
    var toolbarIdx by mutableStateOf(0)                         // 0..filters.size-1 = chips, filters.size = Settings
    var programmes by mutableStateOf<Map<Int, List<Programme>>>(emptyMap())
    var epgFrom by mutableStateOf(0.0)
    var nowSec by mutableStateOf(System.currentTimeMillis() / 1000.0)
    var sel by mutableStateOf(Sel(0, null))
    var viewStart by mutableStateOf(0.0)          // left edge of the guide timeline (epoch s)
    var playingId by mutableStateOf<Int?>(null)
    var guideVisible by mutableStateOf(true)
    var showSettings by mutableStateOf(false)
    var osdUntil by mutableLongStateOf(0L)
    var osdDigits by mutableStateOf("")
    var status by mutableStateOf<String?>(null)    // loading / error text
    var detail by mutableStateOf<ItemDetail?>(null)
    var toast by mutableStateOf<String?>(null)
    var paused by mutableStateOf(false)
    var behindSec by mutableStateOf(0.0)           // how far behind live we are (after pausing / skipping back)
    var serverSettings by mutableStateOf<JsonObject?>(null)
    var settingsNote by mutableStateOf<String?>(null)

    /** Chips that have at least one channel (All is always there), so the row never overflows the screen. */
    val visibleFilters: List<ChannelFilter> get() = ChannelFilter.entries.filter { it == ChannelFilter.ALL || it == filter || allChannels.any(it.test) }

    val spanSec get() = SPAN_MIN * 60.0
    private var nav = GuideNav(emptyList(), emptyMap())
    private var lastChannelId: Int? = null
    private var digitJob: Job? = null
    private var detailJob: Job? = null
    private var lastBack = 0L
    private var retries = 0
    private var baselineOffsetMs: Long? = null     // the normal live latency, so "behind live" only counts time we've given up

    // ---- player ----------------------------------------------------------------
    val player: ExoPlayer = ExoPlayer.Builder(app).build().apply {
        playWhenReady = true
        addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                val id = playingId ?: return
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    // paused / rewound for longer than the server buffer: jump back to live
                    seekToDefaultPosition(); prepare(); baselineOffsetMs = null; return
                }
                // live HLS: the server may still be spinning the channel up, or have hiccupped. Keep trying (a little slower each
                // time, at most every 9 s) for as long as this channel is selected, so a blip in the night never leaves an error screen.
                retries++
                if (retries > 8) status = "Reconnecting… (${error.errorCodeName})"
                viewModelScope.launch { delay(1500L * retries.coerceAtMost(6)); if (playingId == id) startStream(id) }
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    retries = 0; status = null
                    if (baselineOffsetMs == null && playWhenReady) baselineOffsetMs = edgeDistanceMs()
                }
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                paused = !playWhenReady
                // the info banner stays up while paused
                osdUntil = if (paused) Long.MAX_VALUE else System.currentTimeMillis() + 4500
            }
        })
    }

    init {
        viewModelScope.launch {
            while (true) {
                delay(1000)
                val off = edgeDistanceMs()
                val base = baselineOffsetMs
                behindSec = if (playingId != null && off != null && base != null) ((off - base) / 1000.0).coerceAtLeast(0.0) else 0.0
            }
        }
        viewModelScope.launch { while (true) { delay(5000); nowSec = System.currentTimeMillis() / 1000.0 } }
        viewModelScope.launch { while (true) { delay(5 * 60_000L); if (api.base.isNotEmpty()) refresh(false) } }
        if (api.base.isEmpty()) showSettings = true else viewModelScope.launch { refresh(true) }
    }

    // ---- data ------------------------------------------------------------------
    suspend fun refresh(initial: Boolean) {
        runCatching {
            if (initial) status = "Loading guide…"
            val now = System.currentTimeMillis() / 1000
            val from = (now / 1800) * 1800 - 2 * 3600
            val ch = api.channels()
            val epg = api.epg(from, from + 14 * 3600)
            allChannels = ch
            programmes = epg.programmes.mapKeys { it.key.toInt() }
            epgFrom = from.toDouble()
            nowSec = epg.now
            rebuildChannels()
            status = if (ch.isEmpty()) "No channels yet — add a library in the WBTV web UI" else null
            if (initial) {
                var idx = channels.indexOfFirst { it.id == prefs.lastChannel }
                if (idx < 0 && allChannels.any { it.id == prefs.lastChannel }) { applyFilter(ChannelFilter.ALL); idx = channels.indexOfFirst { it.id == prefs.lastChannel } }
                setSel(nav.atNow(idx.coerceAtLeast(0), nowSec), snapView = true)
                if (idx >= 0) tune(idx, fullscreen = true) else guideVisible = true
            } else {
                val keep = programmes[channels.getOrNull(sel.ch)?.id]?.firstOrNull { it.id == sel.prog?.id }
                setSel(if (keep != null) Sel(sel.ch, keep) else nav.atNow(sel.ch, nowSec), snapView = false)
            }
        }.onFailure { status = "Can't reach ${api.base.ifEmpty { "a server" }}: ${it.message}" }
    }

    /** Apply the filter chip to the full channel list. */
    private fun rebuildChannels() {
        var list = allChannels.filter(filter.test)
        if (list.isEmpty() && filter != ChannelFilter.ALL) { filter = ChannelFilter.ALL; prefs.filter = filter.id; list = allChannels }
        channels = list
        nav = GuideNav(list, programmes)
    }

    fun applyFilter(f: ChannelFilter) {
        filter = f; prefs.filter = f.id
        rebuildChannels()
        setSel(nav.atNow(0, nowSec), snapView = true)
    }

    private fun setSel(s: Sel, snapView: Boolean) {
        sel = s
        viewStart = if (snapView || viewStart == 0.0) {
            val p = s.prog
            if (p != null && p.airsAt(nowSec)) (nowSec / 1800).toLong() * 1800.0 - 1800 else (p?.start ?: nowSec) - 600
        } else GuideNav.scrollTo(viewStart, spanSec - 600, s.prog)
        detail = null
        detailJob?.cancel()
        val p = s.prog ?: return
        detailJob = viewModelScope.launch { delay(250); detail = runCatching { api.item(p.item) }.getOrNull() }
    }

    // ---- connection / settings -----------------------------------------------------
    fun openSettings() { showSettings = true; loadServerSettings() }

    fun connect(newServer: String, newKey: String, onResult: (String?) -> Unit) = viewModelScope.launch {
        val candidate = Api(newServer, newKey.trim())
        if (candidate.base.isEmpty()) { onResult("Enter your WBTV server address"); return@launch }
        runCatching { candidate.channels() }.onFailure {
            onResult(if (it.message?.contains("401") == true) "This server is password protected. Enter its access key (WBTV Setup > Settings > Security)." else "Can't reach ${candidate.base}: ${it.message}")
            return@launch
        }
        val changed = candidate.base != api.base || candidate.key != api.key
        prefs.server = candidate.base
        prefs.key = candidate.key
        server = candidate.base
        if (changed) { stopStream(); playingId = null; api = candidate; prefs.lastChannel = -1 }
        showSettings = false
        onResult(null)
        refresh(changed)
    }

    fun setTheme(id: String) { themeId = id; prefs.theme = id }
    fun updateAutoFullscreen(on: Boolean) { autoFullscreen = on; prefs.autoFullscreen = on }

    fun loadServerSettings() {
        if (api.base.isEmpty()) return
        viewModelScope.launch {
            serverSettings = runCatching { api.settings() }.getOrNull()
            settingsNote = if (serverSettings == null) "Couldn't load the server's settings" else null
        }
    }

    fun serverBool(key: String) = serverSettings?.get(key)?.jsonPrimitive?.booleanOrNull
    fun serverInt(key: String) = serverSettings?.get(key)?.jsonPrimitive?.intOrNull

    /** Change a setting on the server itself (ads, announcements, rescans, pause buffer...). */
    fun setServerSetting(key: String, value: Any) {
        val cur = serverSettings
        val prim: JsonPrimitive = when (value) {
            is Boolean -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            else -> JsonPrimitive(value.toString())
        }
        if (cur != null) serverSettings = JsonObject(cur + (key to prim))
        viewModelScope.launch {
            runCatching { api.putSettings(mapOf(key to value)) }
                .onSuccess { serverSettings = it; settingsNote = "Saved. Changes to ads and announcements re-plan the upcoming schedule." }
                .onFailure { settingsNote = "Couldn't save: ${it.message}"; loadServerSettings() }
        }
    }

    fun scanNow() {
        viewModelScope.launch {
            runCatching { api.scanNow() }.onFailure { settingsNote = "Couldn't start a scan: ${it.message}"; return@launch }
            repeat(60) {
                val s = runCatching { api.scanStatus() }.getOrNull() ?: return@launch
                val running = s["running"]?.jsonPrimitive?.booleanOrNull == true
                settingsNote = if (running) "Scanning: ${s["phase"]?.jsonPrimitive?.contentOrNull ?: ""}…" else "Scan finished"
                if (!running) return@launch
                delay(1500)
            }
        }
    }

    // ---- tuning ----------------------------------------------------------------
    fun tune(index: Int, fullscreen: Boolean = true) {
        val ch = channels.getOrNull(index) ?: return
        if (playingId != ch.id) {
            lastChannelId = playingId
            stopStream()
            playingId = ch.id
            prefs.lastChannel = ch.id
            retries = 0
            status = null
            startStream(ch.id)
        }
        if (fullscreen) guideVisible = false
        osdUntil = System.currentTimeMillis() + 4500
    }

    private fun startStream(channelId: Int) {
        baselineOffsetMs = null
        paused = false; behindSec = 0.0
        player.setMediaItem(MediaItem.Builder().setUri(api.liveUrl(channelId, viewer)).setMimeType(MimeTypes.APPLICATION_M3U8)
            .setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setMinPlaybackSpeed(1f).setMaxPlaybackSpeed(1f).build()).build())
        player.prepare()
        player.playWhenReady = true
    }

    private fun stopStream() {
        player.stop(); player.clearMediaItems()
        paused = false; behindSec = 0.0
        playingId?.let { id -> viewModelScope.launch { api.leave(id, viewer) } }
    }

    /**
     * Distance from the playback position to the live edge (end of the playlist window), in ms. Our HLS playlist has no wall-clock
     * timestamps, so ExoPlayer's own liveOffset is unavailable; the window length minus the position works instead and grows while paused.
     */
    private fun edgeDistanceMs(): Long? {
        val d = player.duration
        return if (d != C.TIME_UNSET && player.isCurrentMediaItemLive) d - player.currentPosition else null
    }

    // ---- pause / rewind live TV (the server keeps a rolling buffer) ------------------------
    fun togglePause() { if (playingId != null) player.playWhenReady = !player.playWhenReady }

    fun goLive() {
        if (playingId == null) return
        player.seekToDefaultPosition(); player.playWhenReady = true
        behindSec = 0.0
        osdUntil = System.currentTimeMillis() + 4500
    }

    fun seekBy(seconds: Int) {
        if (playingId == null) return
        if (seconds > 0 && behindSec <= seconds + 3) { goLive(); return } // skipping past the live edge = back to live
        player.seekTo((player.currentPosition + seconds * 1000L).coerceAtLeast(0))
        osdUntil = if (paused) Long.MAX_VALUE else System.currentTimeMillis() + 4500
    }

    /** Activity left the foreground: stop pulling video and free the server-side encoder. */
    fun onBackground() { if (playingId != null) { player.stop(); player.clearMediaItems(); playingId?.let { id -> viewModelScope.launch { api.leave(id, viewer) } } } }

    /** Back in the foreground: rejoin the live stream (we're deliberately *not* paused-in-time, it's TV). */
    private var firstStart = true
    fun onForeground() {
        if (firstStart) { firstStart = false; return } // initial launch is handled by init{}
        playingId?.let { startStream(it) }
        viewModelScope.launch { nowSec = System.currentTimeMillis() / 1000.0; if (api.base.isNotEmpty()) refresh(false) }
    }

    private fun playingIndex() = channels.indexOfFirst { it.id == playingId }
    fun currentProgramme(ch: Channel?, at: Double = nowSec) = ch?.let { programmes[it.id]?.firstOrNull { p -> p.airsAt(at) } }
    fun nextProgramme(ch: Channel?, at: Double = nowSec) = ch?.let { programmes[it.id]?.firstOrNull { p -> p.start > at } }

    // ---- keys ------------------------------------------------------------------
    /** @return true if the key was consumed. Called from Activity.dispatchKeyEvent (ACTION_DOWN only). */
    fun onKey(code: Int, repeat: Int): Boolean {
        if (showSettings) return false // the settings screen uses normal focus navigation
        if (allChannels.isEmpty()) {
            return when (code) {
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> { openSettings(); true }
                else -> false
            }
        }
        digit(code)?.let { enterDigit(it); return true }
        return if (guideVisible) guideKey(code, repeat) else playerKey(code, repeat)
    }

    private fun playerKey(code: Int, repeat: Int): Boolean {
        val idx = playingIndex()
        when (code) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> if (repeat == 0 || repeat % 4 == 0) tune(wrap(idx + 1))
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> if (repeat == 0 || repeat % 4 == 0) tune(wrap(idx - 1))
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_LAST_CHANNEL -> goLastChannel()
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BUTTON_Y -> osdUntil = if (paused) Long.MAX_VALUE else System.currentTimeMillis() + 6000
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_GUIDE, KeyEvent.KEYCODE_TV_DATA_SERVICE -> openGuide()
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> openSettings()
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> togglePause()
            KeyEvent.KEYCODE_MEDIA_PLAY -> if (paused) togglePause()
            KeyEvent.KEYCODE_MEDIA_PAUSE -> if (!paused) togglePause()
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD, KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD -> seekBy(-30)
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD, KeyEvent.KEYCODE_MEDIA_STEP_FORWARD -> seekBy(30)
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BUTTON_B -> {
                val now = System.currentTimeMillis()
                if (now - lastBack < 2000) return false // second Back inside 2s -> let the system close the app
                lastBack = now
                toast = "Press Back again to exit"
                viewModelScope.launch { delay(2000); toast = null }
            }
            else -> return false
        }
        return true
    }

    private fun goLastChannel() {
        val id = lastChannelId ?: return
        var i = channels.indexOfFirst { it.id == id }
        if (i < 0 && allChannels.any { it.id == id }) { applyFilter(ChannelFilter.ALL); i = channels.indexOfFirst { it.id == id } }
        if (i >= 0) tune(i)
    }

    private fun guideKey(code: Int, repeat: Int): Boolean {
        if (zone == Zone.TOOLBAR) return toolbarKey(code, repeat)
        val now = nowSec
        when (code) {
            KeyEvent.KEYCODE_DPAD_LEFT -> setSel(nav.left(sel), false)
            KeyEvent.KEYCODE_DPAD_RIGHT -> setSel(nav.right(sel), false)
            KeyEvent.KEYCODE_DPAD_UP -> {
                val up = nav.up(sel, now)
                // already on the top row: move up into the filter chips / Settings button
                if (up.ch == sel.ch) { zone = Zone.TOOLBAR; toolbarIdx = visibleFilters.indexOf(filter).coerceAtLeast(0) } else setSel(up, false)
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> setSel(nav.down(sel, now), false)
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> setSel(nav.vertical(sel, -PAGE, now), false)
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> setSel(nav.vertical(sel, PAGE, now), false)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                if (repeat == 0) {
                    val ch = channels.getOrNull(sel.ch)
                    // OK on the channel we're already watching = go full screen. Otherwise tune it if the programme is live, or if the
                    // channel is between programmes (adverts / announcement) since it is still on air. Fullscreen follows the setting.
                    if (ch?.id == playingId) guideVisible = false
                    else if (nav.tunable(sel.ch, sel.prog, now)) tune(sel.ch, fullscreen = autoFullscreen)
                }
            }
            KeyEvent.KEYCODE_GUIDE -> if (playingId != null) guideVisible = false
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> openSettings()
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BUTTON_B -> {
                if (playingId != null) guideVisible = false else return false
            }
            else -> return false
        }
        return true
    }

    /** Keys while the focus is on the filter chips (and the Settings button) above the grid. */
    private fun toolbarKey(code: Int, repeat: Int): Boolean {
        val filters = visibleFilters
        when (code) {
            KeyEvent.KEYCODE_DPAD_LEFT -> toolbarIdx = (toolbarIdx - 1).coerceAtLeast(0)
            KeyEvent.KEYCODE_DPAD_RIGHT -> toolbarIdx = (toolbarIdx + 1).coerceAtMost(filters.size)
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BUTTON_B -> zone = Zone.GRID
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> if (repeat == 0) {
                if (toolbarIdx < filters.size) applyFilter(filters[toolbarIdx]) else openSettings()
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> openSettings()
            KeyEvent.KEYCODE_DPAD_UP -> {}
            else -> return false
        }
        return true
    }

    private fun openGuide() {
        guideVisible = true
        zone = Zone.GRID
        val idx = playingIndex().takeIf { it >= 0 } ?: sel.ch
        nowSec = System.currentTimeMillis() / 1000.0
        setSel(nav.atNow(idx, nowSec), snapView = true)
    }

    private fun wrap(i: Int) = if (channels.isEmpty()) 0 else ((i % channels.size) + channels.size) % channels.size

    private fun digit(code: Int): Int? = when (code) {
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> code - KeyEvent.KEYCODE_0
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> code - KeyEvent.KEYCODE_NUMPAD_0
        else -> null
    }

    private fun enterDigit(d: Int) {
        osdDigits = (osdDigits + d).takeLast(3)
        osdUntil = System.currentTimeMillis() + 2500
        digitJob?.cancel()
        digitJob = viewModelScope.launch {
            delay(1400)
            val n = osdDigits.toIntOrNull()
            osdDigits = ""
            var idx = channels.indexOfFirst { it.number == n }
            if (idx < 0 && allChannels.any { it.number == n }) { applyFilter(ChannelFilter.ALL); idx = channels.indexOfFirst { it.number == n } }
            if (idx >= 0) { setSel(nav.atNow(idx, nowSec), snapView = true); tune(idx, fullscreen = !guideVisible) }
            else osdUntil = 0
        }
    }

    override fun onCleared() {
        player.release()
        super.onCleared()
    }

    companion object {
        const val SPAN_MIN = 200.0 // minutes of guide visible at once
        const val PAGE = 8
    }
}
