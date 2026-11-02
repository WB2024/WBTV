package com.wbtv.tv.ui

import android.view.LayoutInflater
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.wbtv.tv.AppVm
import com.wbtv.tv.Channel
import com.wbtv.tv.Programme
import com.wbtv.tv.R
import com.wbtv.tv.Themes
import com.wbtv.tv.WbtvTheme
import com.wbtv.tv.themeById
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())
private fun hm(sec: Double) = timeFmt.format(Date((sec * 1000).toLong()))

@Composable
fun WbtvRoot(vm: AppVm) {
    val t = themeById(vm.themeId)
    MaterialTheme(colorScheme = darkColorScheme()) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
            val u = maxHeight.value / 540f // everything is designed at 540dp tall and scaled from there
            val headerH = 190f * u
            val gridW = maxWidth

            if (vm.guideVisible) {
                Column(Modifier.fillMaxSize().background(t.bg)) {
                    Header(vm, t, u, Modifier.height(headerH.dp))
                    Guide(vm, t, u, gridW, Modifier.weight(1f))
                }
            }

            val inGuide = vm.guideVisible
            PlayerSurface(
                vm,
                if (inGuide) Modifier.padding(12.dp * u).size(((headerH - 24f * u) * 16f / 9f).dp, (headerH - 24f * u).dp)
                    .align(Alignment.TopStart).border(2.dp, t.frame, RoundedCornerShape(3.dp)) else Modifier.fillMaxSize(),
            )
            if (vm.playingId == null && inGuide) {
                Box(Modifier.padding(12.dp * u).size(((headerH - 24f * u) * 16f / 9f).dp, (headerH - 24f * u).dp).align(Alignment.TopStart), Alignment.Center) {
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
            if (vm.showSettings) SettingsDialog(vm, t, u)
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

// ------------------------------------------------------------------ header (info panel)

@Composable
private fun Header(vm: AppVm, t: WbtvTheme, u: Float, modifier: Modifier) {
    val p = vm.sel.prog
    val ch = vm.channels.getOrNull(vm.sel.ch)
    val playerW = ((190f * u - 24f * u) * 16f / 9f).dp + 24.dp * u
    Box(modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(t.top1, t.top2)))) {
        Row(Modifier.fillMaxSize().padding(start = playerW + 8.dp * u, end = 20.dp * u, top = 12.dp * u, bottom = 8.dp * u), horizontalArrangement = Arrangement.spacedBy(14.dp * u)) {
            if (p != null) {
                AsyncImage(
                    model = vm.api.artUrl(p.item), contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxHeight().width((110f * u).dp).clip(RoundedCornerShape(3.dp)).border(2.dp, t.frame, RoundedCornerShape(3.dp)).background(Color.Black),
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
                    Spacer(Modifier.height(4.dp * u))
                    Text(d?.plot?.ifBlank { null } ?: p.plot.orEmpty(), color = t.txt, fontSize = (13 * u).sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    d?.actors?.takeIf { it.isNotEmpty() }?.let { Text("Starring: " + it.take(5).joinToString { a -> a.name }, color = t.dim, fontSize = (11 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            } else Text(ch?.name ?: "", color = t.txt, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold)
        }
        Text(hm(vm.nowSec), color = t.sel, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.TopEnd).padding(14.dp * u))
    }
}

// ------------------------------------------------------------------ guide grid

@Composable
private fun Guide(vm: AppVm, t: WbtvTheme, u: Float, totalW: Dp, modifier: Modifier) {
    val chW = (150f * u).dp
    val rowH = (50f * u).dp
    val headH = (26f * u).dp
    val dpPerMin = (totalW - chW).value / AppVm.SPAN_MIN.toFloat()
    val viewRel by animateFloatAsState(((vm.viewStart - vm.epgFrom)).toFloat(), tween(220), label = "scroll")
    val listState = rememberLazyListState()

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
            Box(Modifier.width(chW).fillMaxHeight(), Alignment.CenterStart) { Text("  Channel", color = t.dim, fontSize = (11 * u).sp) }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                var tick = (((vm.epgFrom + viewRel) / 1800).toLong() * 1800).toDouble()
                while (tick < vm.epgFrom + viewRel + AppVm.SPAN_MIN * 60 + 1800) {
                    val x = ((tick - vm.epgFrom - viewRel) / 60.0 * dpPerMin).toFloat()
                    if (x > -40) Text("| " + hm(tick), color = t.dim, fontSize = (12 * u).sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(x = x.dp).padding(top = 4.dp * u))
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
    Row(Modifier.fillMaxWidth().height(rowH)) {
        Row(
            Modifier.width(chW).fillMaxHeight().background(Brush.horizontalGradient(if (playing) listOf(t.play1, t.play2) else listOf(t.chan1, t.chan2))).padding(horizontal = 8.dp * u),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp * u),
        ) {
            Text("${ch.number ?: ""}", color = t.sel, fontWeight = FontWeight.Bold, fontSize = (15 * u).sp, modifier = Modifier.width((28 * u).dp))
            Text(ch.name, color = t.txt, fontSize = (13 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(0.dp))) {
            val spanSec = AppVm.SPAN_MIN * 60
            val winStart = vm.epgFrom + viewRel
            for (p in vm.programmes[ch.id].orEmpty()) {
                if (p.end < winStart - 600 || p.start > winStart + spanSec + 600) continue
                Cell(vm, t, u, p, selected = vm.sel.ch == index && vm.sel.prog?.id == p.id, x = ((p.start - winStart) / 60.0 * dpPerMin).toFloat(), w = ((p.end - p.start) / 60.0 * dpPerMin).toFloat())
            }
        }
    }
}

@Composable
private fun Cell(vm: AppVm, t: WbtvTheme, u: Float, p: Programme, selected: Boolean, x: Float, w: Float) {
    val past = p.end <= vm.nowSec
    val live = p.airsAt(vm.nowSec)
    val shape = RoundedCornerShape(3.dp)
    val bg = when { selected -> Brush.verticalGradient(listOf(t.sel, t.sel)); past -> Brush.verticalGradient(listOf(t.past, t.past)); else -> Brush.verticalGradient(listOf(t.cell, t.cell2)) }
    val txt = if (selected) t.selTxt else if (past) t.dim else t.txt
    val sub = if (selected) t.selTxt.copy(alpha = .75f) else t.dim
    val clip = if (x < 0) (-x).coerceAtMost(w - 20f) else 0f // keep the title visible when the cell starts left of the window
    Box(
        Modifier.offset(x = x.dp + 1.dp).width((w - 2f).coerceAtLeast(2f).dp).fillMaxHeight().padding(vertical = 2.dp)
            .clip(shape).background(bg)
            .then(if (selected) Modifier.border(2.dp, t.selLine, shape) else if (live) Modifier.border(2.dp, t.accent.copy(alpha = .6f), shape) else Modifier),
    ) {
        Column(Modifier.padding(start = (6f * u + clip).dp, end = 4.dp, top = 3.dp * u)) {
            Text(p.title, color = txt, fontWeight = FontWeight.Bold, fontSize = (12.5f * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val s = if (p.subtitle.isNotBlank()) (if (p.season != null && p.episode != null) "S${p.season}E${p.episode} · " else "") + p.subtitle else p.year?.toString().orEmpty()
            Text(s, color = sub, fontSize = (10.5f * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ------------------------------------------------------------------ on-screen banner

@Composable
private fun Osd(vm: AppVm, t: WbtvTheme, u: Float) {
    var tick by remember { mutableStateOf(0L) }
    LaunchedEffect(vm.osdUntil) {
        tick = System.currentTimeMillis()
        val left = vm.osdUntil - System.currentTimeMillis()
        if (left > 0) { kotlinx.coroutines.delay(left + 50); tick = System.currentTimeMillis() }
    }
    val visible = vm.osdUntil > System.currentTimeMillis() && !vm.guideVisible || vm.osdDigits.isNotEmpty()
    if (!visible || vm.showSettings) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.align(Alignment.BottomStart).padding(start = 48.dp * u, end = 48.dp * u, bottom = 36.dp * u).fillMaxWidth()
                .background(t.panel.copy(alpha = .92f), RoundedCornerShape(8.dp)).border(1.dp, t.frame, RoundedCornerShape(8.dp)).padding(14.dp * u),
        ) {
            if (vm.osdDigits.isNotEmpty()) {
                Text(vm.osdDigits + "_", color = t.sel, fontSize = (34 * u).sp, fontWeight = FontWeight.Bold)
            } else {
                val ch = vm.channels.firstOrNull { it.id == vm.playingId }
                val now = vm.currentProgramme(ch)
                val next = vm.nextProgramme(ch, now)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp * u)) {
                    Text("${ch?.number ?: ""}", color = t.sel, fontSize = (30 * u).sp, fontWeight = FontWeight.Bold)
                    Text(ch?.name ?: "", color = t.txt, fontSize = (22 * u).sp, fontWeight = FontWeight.Bold)
                }
                if (now != null) Text("Now: ${now.title}${if (now.subtitle.isNotBlank()) " – " + now.subtitle else ""}   (until ${hm(now.end)})", color = t.txt, fontSize = (16 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (next != null) Text("Next: ${next.title}   (${hm(next.start)})", color = t.dim, fontSize = (14 * u).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

// ------------------------------------------------------------------ settings

@Composable
private fun SettingsDialog(vm: AppVm, t: WbtvTheme, u: Float) {
    var server by remember { mutableStateOf(vm.server.ifBlank { "192.168.1.110:8420" }) }
    var theme by remember { mutableStateOf(vm.themeId) }
    var autoFs by remember { mutableStateOf(vm.autoFullscreen) }
    val saveFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { kotlinx.coroutines.delay(250); runCatching { saveFocus.requestFocus() } } // don't let the text field grab focus (and pop the on-screen keyboard)
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val first = vm.server.isBlank()
    Dialog(onDismissRequest = { if (!first) vm.showSettings = false }) {
        Column(Modifier.background(t.panel, RoundedCornerShape(10.dp)).border(2.dp, t.frame, RoundedCornerShape(10.dp)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (first) "Welcome to WBTV" else "Setup", color = t.txt, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text("Address of your WBTV server", color = t.dim, fontSize = 14.sp)
            OutlinedTextField(value = server, onValueChange = { server = it; error = null }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("Theme", color = t.dim, fontSize = 14.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (th in Themes.take(4)) ThemeButton(th, th.id == theme) { theme = th.id }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (th in Themes.drop(4)) ThemeButton(th, th.id == theme) { theme = th.id }
            }
            Text("Behaviour", color = t.dim, fontSize = 14.sp)
            Button(onClick = { autoFs = !autoFs }, modifier = Modifier.focusProperties { down = saveFocus }, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2B3A7A), contentColor = Color.White)) {
                Text("Go fullscreen when selecting a programme:  " + if (autoFs) "ON" else "OFF", fontSize = 13.sp)
            }
            error?.let { Text(it, color = Color(0xFFFF8A8A), fontSize = 13.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(enabled = !busy, modifier = Modifier.focusRequester(saveFocus), onClick = { busy = true; vm.applySettings(server, theme, autoFs) { e -> busy = false; error = e } }) { Text(if (busy) "Connecting…" else "Save") }
                if (!first) Button(onClick = { vm.showSettings = false }, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF444444), contentColor = Color.White)) { Text("Cancel") }
            }
        }
    }
}

@Composable
private fun ThemeButton(th: WbtvTheme, on: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = th.cell, contentColor = th.txt), border = if (on) androidx.compose.foundation.BorderStroke(3.dp, th.sel) else null) {
        Text(th.label, fontSize = 13.sp)
    }
}
