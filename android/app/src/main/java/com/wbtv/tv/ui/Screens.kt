package com.wbtv.tv.ui

import android.view.LayoutInflater
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.wbtv.tv.AppVm
import com.wbtv.tv.Channel
import com.wbtv.tv.ChannelFilter
import com.wbtv.tv.Programme
import com.wbtv.tv.R
import com.wbtv.tv.Themes
import com.wbtv.tv.WbtvTheme
import com.wbtv.tv.Zone
import com.wbtv.tv.themeById
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())
private fun hm(sec: Double) = timeFmt.format(Date((sec * 1000).toLong()))
private fun clock(s: Double) = "%d:%02d".format((s / 60).toInt(), (s % 60).toInt())

@Composable
fun WbtvRoot(vm: AppVm) {
    val t = themeById(vm.themeId)
    MaterialTheme(colorScheme = darkColorScheme()) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
            val u = maxHeight.value / 540f // everything is designed at 540dp tall and scaled from there
            val screenW = maxWidth
            val titleH = if (t.previewRight) 28f * u else 0f
            val headerH = 172f * u
            val pvH = headerH - 24f * u
            val pvW = pvH * 16f / 9f

            if (vm.guideVisible) {
                Column(Modifier.fillMaxSize().background(t.bg)) {
                    if (t.previewRight) TitleBar(vm, t, u, Modifier.height(titleH.dp))
                    Header(vm, t, u, pvW, Modifier.height(headerH.dp))
                    Toolbar(vm, t, u)
                    Guide(vm, t, u, screenW, Modifier.weight(1f))
                }
            }

            val inGuide = vm.guideVisible
            val pvAlign = if (t.previewRight) Alignment.TopEnd else Alignment.TopStart
            val pvPad = Modifier.padding(start = 12.dp * u, end = 12.dp * u, top = (12f * u + titleH).dp).size(pvW.dp, pvH.dp)
            PlayerSurface(vm, if (inGuide) Modifier.align(pvAlign).then(pvPad).border(2.dp, t.frame, RoundedCornerShape(3.dp)) else Modifier.fillMaxSize())
            if (vm.playingId == null && inGuide) {
                Box(Modifier.align(pvAlign).then(pvPad), Alignment.Center) {
                    Text("Select a channel\nand press OK", color = t.dim, fontSize = (13 * u).sp)
                }
            }

            Osd(vm, t, u)
            val loading = vm.status?.startsWith("Loading") == true
            if (loading) {
                Box(Modifier.fillMaxSize().background(Color.Black), Alignment.Center) {
                    Image(painterResource(R.drawable.splash), contentDescription = "Loading your TV guide", modifier = Modifier.fillMaxWidth(0.5f))
                }
            } else vm.status?.let {
                Text(it, color = Color.White, fontSize = (18 * u).sp, modifier = Modifier.align(Alignment.Center).background(Color(0xCC000000), RoundedCornerShape(8.dp)).padding(16.dp))
            }
            vm.toast?.let {
                Text(it, color = Color.White, fontSize = (16 * u).sp, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 48.dp * u).background(Color(0xCC000000), RoundedCornerShape(8.dp)).padding(12.dp))
            }
            if (vm.showSettings) SettingsScreen(vm, t, u)
        }
    }
}

@Composable
private fun PlayerSurface(vm: AppVm, modifier: Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { ctx -> (LayoutInflater.from(ctx).inflate(R.layout.wbtv_player_view, null) as PlayerView).also { it.player = vm.player } },
        update = { it.player = vm.player },
    )
}

// ------------------------------------------------------------------ title strip (Satellite themes) and header (info panel)

@Composable
private fun TitleBar(vm: AppVm, t: WbtvTheme, u: Float, modifier: Modifier) {
    val fmt = remember { SimpleDateFormat("EEE d MMM  HH:mm", Locale.getDefault()) }
    Row(modifier.fillMaxWidth().background(t.panel).padding(horizontal = 18.dp * u), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(22.dp * u)) {
        Text("WBTV", color = t.accent, fontSize = (17 * u).sp, fontWeight = FontWeight.Black)
        Text(fmt.format(Date((vm.nowSec * 1000).toLong())), color = t.txt, fontSize = (14 * u).sp)
        Text(vm.filter.label.uppercase(), color = t.txt, fontSize = (19 * u).sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Header(vm: AppVm, t: WbtvTheme, u: Float, pvW: Float, modifier: Modifier) {
    val p = vm.sel.prog
    val ch = vm.channels.getOrNull(vm.sel.ch)
    val side = (pvW + 24f * u + 8f * u).dp
    val startPad = if (t.previewRight) 20.dp * u else side
    val endPad = if (t.previewRight) side else 20.dp * u
    Box(modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(t.top1, t.top2)))) {
        Row(Modifier.fillMaxSize().padding(start = startPad, end = endPad, top = 12.dp * u, bottom = 8.dp * u), horizontalArrangement = Arrangement.spacedBy(14.dp * u)) {
            if (p != null) {
                AsyncImage(
                    model = vm.api.artUrl(p.item), contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxHeight().width((100f * u).dp).clip(RoundedCornerShape(3.dp)).border(2.dp, t.frame, RoundedCornerShape(3.dp)).background(Color.Black),
                )
                Column(Modifier.weight(1f)) {
                    val d = vm.detail?.takeIf { it.id == p.item }
                    Text(p.title, color = t.txt, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (p.subtitle.isNotBlank()) {
                        val se = if (p.season != null && p.episode != null) "S${p.season} E${p.episode} – " else ""
                        Text(se + p.subtitle, color = t.accent, fontSize = (14 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    val tag = when { p.airsAt(vm.nowSec) -> "NOW"; p.end <= vm.nowSec -> "EARLIER"; else -> "NEXT" }
                    val genres = (d?.genres ?: p.genres).take(3).joinToString(", ")
                    val meta = listOfNotNull(tag, "${ch?.number ?: ""} ${ch?.name ?: ""}".trim(), "${hm(p.start)}–${hm(p.end)}", p.year?.toString(), p.mpaa?.ifBlank { null }, genres.ifBlank { null }).joinToString("  ·  ")
                    Text(meta, color = t.dim, fontSize = (12 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(3.dp * u))
                    Text(d?.plot?.ifBlank { null } ?: p.plot.orEmpty(), color = t.txt, fontSize = (13 * u).sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    d?.actors?.takeIf { it.isNotEmpty() }?.let { Text("Starring: " + it.take(5).joinToString { a -> a.name }, color = t.dim, fontSize = (11 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            } else Text(ch?.name ?: "", color = t.txt, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold)
        }
        if (!t.previewRight) Text(hm(vm.nowSec), color = t.sel, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.TopEnd).padding(14.dp * u))
    }
}

// ------------------------------------------------------------------ filter chips + Settings button

@Composable
private fun Toolbar(vm: AppVm, t: WbtvTheme, u: Float) {
    val filters = vm.visibleFilters
    Row(
        Modifier.fillMaxWidth().height((30f * u).dp).background(t.panel).padding(horizontal = 12.dp * u),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp * u),
    ) {
        filters.forEachIndexed { i, f ->
            Chip("${f.label}  ${vm.allChannels.count(f.test)}", vm.filter == f, vm.zone == Zone.TOOLBAR && vm.toolbarIdx == i, t, u)
        }
        Spacer(Modifier.weight(1f))
        Chip("⚙  Settings", false, vm.zone == Zone.TOOLBAR && vm.toolbarIdx == filters.size, t, u)
    }
}

@Composable
private fun Chip(text: String, active: Boolean, focused: Boolean, t: WbtvTheme, u: Float) {
    val shape = if (t.flat) RectangleShape else RoundedCornerShape(50)
    Box(
        Modifier.clip(shape).background(if (active) t.sel else if (focused) t.cell else Color.Transparent)
            .border(if (focused) 3.dp else 1.dp, if (focused) Color.White else t.dim.copy(alpha = .6f), shape)
            .padding(horizontal = 12.dp * u, vertical = 2.dp * u),
    ) {
        Text(text, color = if (active) t.selTxt else if (focused) Color.White else t.dim, fontSize = (12.5f * u).sp, fontWeight = if (active || focused) FontWeight.Bold else FontWeight.Normal)
    }
}

// ------------------------------------------------------------------ guide grid

@Composable
private fun Guide(vm: AppVm, t: WbtvTheme, u: Float, totalW: Dp, modifier: Modifier) {
    val chW = (196f * u).dp
    val rowH = (46f * u).dp
    val headH = (24f * u).dp
    val dpPerMin = (totalW - chW).value / AppVm.SPAN_MIN.toFloat()
    val viewRel by animateFloatAsState(((vm.viewStart - vm.epgFrom)).toFloat(), tween(220), label = "scroll")
    val listState = rememberLazyListState()
    val rulerTxt = if (t.rulerTxt != Color.Unspecified) t.rulerTxt else t.dim

    // keep the selected row on screen
    LaunchedEffect(vm.sel.ch, vm.channels.size) {
        val vis = listState.layoutInfo.visibleItemsInfo
        if (vis.isEmpty()) return@LaunchedEffect
        val first = vis.first().index
        val last = vis.last { it.offset + it.size <= listState.layoutInfo.viewportEndOffset + 2 }.index
        when {
            vm.sel.ch < first -> listState.animateScrollToItem(vm.sel.ch)
            vm.sel.ch > last -> listState.animateScrollToItem((vm.sel.ch - (last - first)).coerceAtLeast(0))
        }
    }

    Column(modifier.fillMaxWidth().background(t.bg)) {
        // time ruler
        Row(Modifier.fillMaxWidth().height(headH).background(t.head)) {
            Box(Modifier.width(chW).fillMaxHeight(), Alignment.CenterStart) { Text("  CHANNEL", color = rulerTxt, fontSize = (11 * u).sp, fontWeight = FontWeight.Bold) }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                var tick = (((vm.epgFrom + viewRel) / 1800).toLong() * 1800).toDouble()
                while (tick < vm.epgFrom + viewRel + AppVm.SPAN_MIN * 60 + 1800) {
                    val x = ((tick - vm.epgFrom - viewRel) / 60.0 * dpPerMin).toFloat()
                    if (x > -40) Text("| " + hm(tick), color = rulerTxt, fontSize = (12 * u).sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(x = x.dp).padding(top = 3.dp * u))
                    tick += 1800
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                itemsIndexed(vm.channels, key = { _, c -> c.id }) { i, ch ->
                    ChannelRow(vm, t, u, ch, i, chW, rowH, dpPerMin, viewRel)
                }
            }
            // "now" marker
            val nx = ((vm.nowSec - vm.epgFrom - viewRel) / 60.0 * dpPerMin).toFloat()
            if (nx >= 0) Box(Modifier.offset(x = chW + nx.dp).width(2.dp).fillMaxHeight().background(t.now))
        }
    }
}

@Composable
private fun ChannelRow(vm: AppVm, t: WbtvTheme, u: Float, ch: Channel, index: Int, chW: Dp, rowH: Dp, dpPerMin: Float, viewRel: Float) {
    val playing = vm.playingId == ch.id
    val selRow = t.flat && vm.zone == Zone.GRID && vm.sel.ch == index // flat themes highlight the whole channel box of the selected row
    val labelBg = when {
        selRow -> Brush.horizontalGradient(listOf(t.sel, t.sel))
        playing -> Brush.horizontalGradient(listOf(t.play1, t.play2))
        else -> Brush.horizontalGradient(listOf(t.chan1, t.chan2))
    }
    Row(Modifier.fillMaxWidth().height(rowH)) {
        Row(
            Modifier.width(chW).fillMaxHeight().padding(vertical = if (t.flat) 2.dp else 0.dp).background(labelBg).padding(horizontal = 8.dp * u),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp * u),
        ) {
            Text("${ch.number ?: ""}", color = if (selRow) t.selTxt else if (t.flat) t.txt else t.sel, fontWeight = FontWeight.Bold, fontSize = (15 * u).sp, modifier = Modifier.width((28 * u).dp))
            Text(
                if (t.flat) ch.name.uppercase() else ch.name, color = if (selRow) t.selTxt else t.txt, fontSize = (12.5f * u).sp, lineHeight = (14f * u).sp,
                fontWeight = if (t.flat) FontWeight.ExtraBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        Box(Modifier.weight(1f).fillMaxHeight().clip(RectangleShape)) {
            val spanSec = AppVm.SPAN_MIN * 60
            val winStart = vm.epgFrom + viewRel
            for (p in vm.programmes[ch.id].orEmpty()) {
                if (p.end < winStart - 600 || p.start > winStart + spanSec + 600) continue
                Cell(vm, t, u, p, selected = vm.zone == Zone.GRID && vm.sel.ch == index && vm.sel.prog?.id == p.id, x = ((p.start - winStart) / 60.0 * dpPerMin).toFloat(), w = ((p.end - p.start) / 60.0 * dpPerMin).toFloat())
            }
        }
    }
}

@Composable
private fun Cell(vm: AppVm, t: WbtvTheme, u: Float, p: Programme, selected: Boolean, x: Float, w: Float) {
    val past = p.end <= vm.nowSec
    val live = p.airsAt(vm.nowSec)
    val shape = if (t.flat) RectangleShape else RoundedCornerShape(3.dp)
    val bg = when { selected -> Brush.verticalGradient(listOf(t.sel, t.sel)); past -> Brush.verticalGradient(listOf(t.past, t.past)); else -> Brush.verticalGradient(listOf(t.cell, t.cell2)) }
    val txt = if (selected) t.selTxt else if (past) t.dim else t.txt
    val sub = if (selected) t.selTxt.copy(alpha = .75f) else t.dim
    val clip = if (x < 0) (-x).coerceAtMost(w - 20f) else 0f // keep the title visible when the cell starts left of the window
    val gap = if (t.flat) 3f else 2f
    Box(
        Modifier.offset(x = x.dp + (gap / 2).dp).width((w - gap).coerceAtLeast(2f).dp).fillMaxHeight().padding(vertical = 2.dp)
            .clip(shape).background(bg)
            .then(if (selected) Modifier.border(2.dp, t.selLine, shape) else if (live && !t.flat) Modifier.border(2.dp, t.accent.copy(alpha = .6f), shape) else Modifier),
    ) {
        Column(Modifier.padding(start = (6f * u + clip).dp, end = 4.dp, top = 2.dp * u)) {
            Text(p.title, color = txt, fontWeight = FontWeight.Bold, fontSize = (12.5f * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val s = if (p.subtitle.isNotBlank()) (if (p.season != null && p.episode != null) "S${p.season}E${p.episode} · " else "") + p.subtitle else p.year?.toString().orEmpty()
            Text(s, color = sub, fontSize = (10.5f * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ------------------------------------------------------------------ on-screen banner (what's on, progress, minutes left, pause state)

@Composable
private fun Osd(vm: AppVm, t: WbtvTheme, u: Float) {
    val nowMs by produceState(System.currentTimeMillis()) { while (true) { delay(1000); value = System.currentTimeMillis() } }
    val visible = (vm.osdUntil > nowMs && !vm.guideVisible) || vm.osdDigits.isNotEmpty()
    if (!visible || vm.showSettings) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.align(Alignment.BottomStart).padding(start = 48.dp * u, end = 48.dp * u, bottom = 36.dp * u).fillMaxWidth()
                .background(t.panel.copy(alpha = .92f), RoundedCornerShape(8.dp)).border(1.dp, t.frame, RoundedCornerShape(8.dp)).padding(14.dp * u),
        ) {
            if (vm.osdDigits.isNotEmpty()) {
                Text(vm.osdDigits + "_", color = t.sel, fontSize = (34 * u).sp, fontWeight = FontWeight.Bold)
            } else {
                val ch = vm.allChannels.firstOrNull { it.id == vm.playingId }
                val behind = if (vm.behindSec > 20) vm.behindSec else 0.0           // a few seconds of live latency is normal
                val at = nowMs / 1000.0 - behind                                    // the broadcast time we are actually watching
                val cur = vm.currentProgramme(ch, at)
                val next = vm.nextProgramme(ch, at)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp * u)) {
                    Text("${ch?.number ?: ""}", color = t.sel, fontSize = (30 * u).sp, fontWeight = FontWeight.Bold)
                    Text(ch?.name ?: "", color = t.txt, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    val state = if (vm.paused) "⏸  PAUSED" else if (behind > 0) "⏪  ${clock(behind)} behind live" else ""
                    if (state.isNotEmpty()) Text(state, color = t.sel, fontSize = (16 * u).sp, fontWeight = FontWeight.Bold)
                }
                if (cur != null) {
                    Text(cur.title + if (cur.subtitle.isNotBlank()) " – " + cur.subtitle else "", color = t.txt, fontSize = (16 * u).sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val frac = ((at - cur.start) / (cur.end - cur.start)).coerceIn(0.0, 1.0).toFloat()
                    val left = kotlin.math.ceil((cur.end - at) / 60).toInt().coerceAtLeast(1)
                    Row(Modifier.padding(vertical = 6.dp * u), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp * u)) {
                        Box(Modifier.weight(1f).height((8f * u).dp).clip(RoundedCornerShape(50)).background(t.dim.copy(alpha = .35f))) {
                            Box(Modifier.fillMaxWidth(frac).fillMaxHeight().background(t.accent))
                        }
                        Text("$left min left  ·  until ${hm(cur.end)}", color = t.txt, fontSize = (14 * u).sp)
                    }
                } else Text("Adverts and announcements", color = t.txt, fontSize = (16 * u).sp, fontWeight = FontWeight.Bold)
                if (next != null) Text("Next: ${next.title}   (${hm(next.start)})", color = t.dim, fontSize = (14 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (vm.paused) Text("Press play to resume  ·  fast-forward to return to live", color = t.dim, fontSize = (12 * u).sp)
                else if (behind > 0) Text("Press fast-forward to return to live", color = t.dim, fontSize = (12 * u).sp)
            }
        }
    }
}

// ------------------------------------------------------------------ settings

@Composable
private fun TvButton(
    text: String, on: Boolean, t: WbtvTheme, u: Float, modifier: Modifier = Modifier,
    container: Color = if (on) t.sel else t.cell, content: Color = if (on) t.selTxt else t.txt, marked: Boolean = false, onClick: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(10.dp)
    Button(
        onClick = onClick, shape = shape,
        modifier = modifier.onFocusChanged { focused = it.isFocused }
            .then(if (focused) Modifier.border(3.dp, Color.White, shape) else if (marked) Modifier.border(3.dp, t.sel, shape) else Modifier),
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
    ) { Text(text, fontSize = (13 * u).sp) }
}

@Composable
private fun SettingsScreen(vm: AppVm, t: WbtvTheme, u: Float) {
    val first = vm.server.isBlank()
    BackHandler(enabled = !first) { vm.showSettings = false }
    val initialFocus = remember { FocusRequester() }
    var address by remember { mutableStateOf(vm.server.ifBlank { "192.168.1.110:8420" }) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(250); runCatching { initialFocus.requestFocus() } } // don't let the text field grab focus (and pop the on-screen keyboard)

    fun onOff(b: Boolean?) = when (b) { true -> "ON"; false -> "OFF"; null -> "…" }

    Box(Modifier.fillMaxSize().background(t.panel)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 56.dp * u, vertical = 22.dp * u),
            verticalArrangement = Arrangement.spacedBy(8.dp * u),
        ) {
            // Close sits at the top-LEFT so that pressing Down always lands on the first theme button
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp * u)) {
                if (!first) TvButton("✕  Close", false, t, u, Modifier.focusRequester(initialFocus)) { vm.showSettings = false }
                Text(if (first) "Welcome to WBTV" else "Settings", color = t.txt, fontSize = (26 * u).sp, fontWeight = FontWeight.Bold)
            }

            if (!first) {
                Heading("Appearance", t, u)
                Themes.chunked(5).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp * u)) {
                        for (th in row) TvButton(th.label, false, t, u, container = th.cell, content = th.txt, marked = th.id == t.id) { vm.setTheme(th.id) }
                    }
                }

                Heading("Behaviour", t, u)
                TvButton("Go fullscreen when selecting a programme:  ${onOff(vm.autoFullscreen)}", vm.autoFullscreen, t, u) { vm.updateAutoFullscreen(!vm.autoFullscreen) }

                Heading("Server  (these change WBTV itself, for every screen)", t, u)
                if (vm.serverSettings == null) {
                    Text(vm.settingsNote ?: "Loading the server's settings…", color = t.dim, fontSize = (13 * u).sp)
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp * u)) {
                        val ads = vm.serverBool("adsEnabled")
                        TvButton("Ad breaks:  ${onOff(ads)}", ads == true, t, u) { vm.setServerSetting("adsEnabled", ads != true) }
                        val promos = vm.serverBool("promosEnabled")
                        TvButton("\"Coming up next\" announcements:  ${onOff(promos)}", promos == true, t, u) { vm.setServerSetting("promosEnabled", promos != true) }
                        val scan = vm.serverBool("autoScan")
                        TvButton("Automatic rescans:  ${onOff(scan)}", scan == true, t, u) { vm.setServerSetting("autoScan", scan != true) }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp * u), verticalAlignment = Alignment.CenterVertically) {
                        Text("Pause / rewind buffer:", color = t.dim, fontSize = (13 * u).sp)
                        val cur = vm.serverInt("pauseBufferMinutes")
                        for ((label, mins) in listOf("Off" to 0, "5 min" to 5, "10 min" to 10, "20 min" to 20)) {
                            TvButton(label, cur == mins, t, u) { vm.setServerSetting("pauseBufferMinutes", mins) }
                        }
                        TvButton("Scan library now", false, t, u) { vm.scanNow() }
                    }
                    vm.settingsNote?.let { Text(it, color = t.accent, fontSize = (12 * u).sp) }
                }
            }

            Heading(if (first) "Address of your WBTV server" else "Connection", t, u)
            OutlinedTextField(value = address, onValueChange = { address = it; error = null }, singleLine = true, modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, color = Color(0xFFFF8A8A), fontSize = (13 * u).sp) }
            TvButton(if (busy) "Connecting…" else if (first) "Connect" else "Connect to this address", false, t, u, if (first) Modifier.focusRequester(initialFocus) else Modifier) {
                busy = true; vm.connect(address) { e -> busy = false; error = e }
            }
            if (!first) Text("Tip: press Menu any time to open this screen, or move up from the top channel in the guide.", color = t.dim, fontSize = (12 * u).sp)
        }
    }
}

@Composable
private fun Heading(text: String, t: WbtvTheme, u: Float) {
    Text(text, color = t.accent, fontSize = (15 * u).sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp * u))
}
