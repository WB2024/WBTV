package com.wbtv.tv

/** Selection in the guide: a channel row and (if it has any) one of its programmes. */
data class Sel(val ch: Int, val prog: Programme?)

/**
 * Pure D-pad navigation for the guide. The cells have variable widths, so instead of leaning on
 * Compose's focus search we keep our own model (same rules as the web guide):
 *  - Left/Right step through programmes of the row
 *  - Up/Down change row, landing on whatever airs at the same time
 */
class GuideNav(private val channels: List<Channel>, private val programmes: Map<Int, List<Programme>>) {

    private fun list(ch: Int) = programmes[channels.getOrNull(ch)?.id].orEmpty()

    fun current(ch: Int, now: Double): Programme? = list(ch).firstOrNull { it.airsAt(now) }

    /**
     * Row `ch`, highlighting what is on right now. Between programmes (adverts / the "coming up next" slot)
     * nothing "airs now", so we land on the next programme instead of the oldest one in the row.
     */
    fun atNow(ch: Int, now: Double): Sel {
        val c = ch.coerceIn(0, (channels.size - 1).coerceAtLeast(0))
        val l = list(c)
        return Sel(c, current(c, now) ?: l.firstOrNull { it.start > now } ?: l.lastOrNull())
    }

    /**
     * Can OK tune this channel? A channel is always "on air": if the programme is live, yes; and if the channel is
     * currently between programmes (showing adverts or an announcement) then any programme in its row tunes it.
     */
    fun tunable(ch: Int, p: Programme?, now: Double): Boolean = p == null || p.airsAt(now) || current(ch, now) == null

    fun left(s: Sel): Sel = step(s, -1)
    fun right(s: Sel): Sel = step(s, 1)

    private fun step(s: Sel, dir: Int): Sel {
        val l = list(s.ch)
        val i = l.indexOfFirst { it.id == s.prog?.id }
        return l.getOrNull(i + dir)?.let { Sel(s.ch, it) } ?: s
    }

    fun up(s: Sel, now: Double) = vertical(s, -1, now)
    fun down(s: Sel, now: Double) = vertical(s, 1, now)

    fun vertical(s: Sel, delta: Int, now: Double): Sel {
        if (channels.isEmpty()) return s
        val ch = (s.ch + delta).coerceIn(0, channels.size - 1)
        if (ch == s.ch) return s
        val p = s.prog
        // stay on "now" if we are on a live programme, otherwise keep the time column
        val anchor = if (p != null && p.airsAt(now)) now else (p?.start ?: now) + 1
        val l = list(ch)
        val pick = l.firstOrNull { it.start <= anchor && it.end > anchor } ?: l.firstOrNull { it.start > anchor } ?: l.lastOrNull()
        return Sel(ch, pick)
    }

    companion object {
        /**
         * Keeps `[sel.start, sel.end]` inside the visible window [viewStart, viewStart+span].
         * Returns the new viewStart (epoch seconds).
         */
        fun scrollTo(viewStart: Double, spanSec: Double, p: Programme?): Double {
            if (p == null) return viewStart
            return when {
                p.start < viewStart -> p.start
                p.end > viewStart + spanSec -> if (p.end - p.start >= spanSec) p.start else p.end - spanSec
                else -> viewStart
            }
        }
    }
}
