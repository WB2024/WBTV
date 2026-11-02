package com.wbtv.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GuideNavTest {
    private fun p(id: Int, s: Int, e: Int) = Programme(id = id, item = id, start = s.toDouble(), end = e.toDouble(), title = "P$id")
    private val ch = listOf(Channel(1, "One", 1), Channel(2, "Two", 2), Channel(3, "Empty", 3))
    private val epg = mapOf(
        1 to listOf(p(10, 0, 100), p(11, 100, 200), p(12, 200, 300)),
        2 to listOf(p(20, 0, 150), p(21, 150, 400)),
    )
    private val nav = GuideNav(ch, epg)

    @Test fun startsOnWhatIsAiringNow() {
        assertEquals(11, nav.atNow(0, 120.0).prog?.id)
        assertEquals(20, nav.atNow(1, 120.0).prog?.id)
    }

    @Test fun leftRightWalkThroughRowAndStopAtEnds() {
        var s = nav.atNow(0, 120.0)
        s = nav.right(s); assertEquals(12, s.prog?.id)
        assertEquals(12, nav.right(s).prog?.id) // no further
        s = nav.left(nav.left(s)); assertEquals(10, s.prog?.id)
        assertEquals(10, nav.left(s).prog?.id)
    }

    @Test fun downFromLiveProgrammeLandsOnLiveProgrammeBelow() {
        val s = nav.down(nav.atNow(0, 120.0), 120.0)
        assertEquals(1, s.ch); assertEquals(20, s.prog?.id)
    }

    @Test fun downFromFutureProgrammeKeepsTheTimeColumn() {
        val future = Sel(0, epg[1]!![2]) // 200-300
        val s = nav.down(future, 120.0)
        assertEquals(21, s.prog?.id) // 150-400 overlaps t=201
    }

    @Test fun emptyRowsAreSelectableAndEndsClamp() {
        val s = nav.down(nav.down(nav.atNow(0, 120.0), 120.0), 120.0)
        assertEquals(2, s.ch); assertNull(s.prog)
        assertEquals(2, nav.down(s, 120.0).ch)
        assertEquals(0, nav.vertical(s, -10, 120.0).ch)
    }

    @Test fun scrollKeepsSelectionVisible() {
        assertEquals(50.0, GuideNav.scrollTo(100.0, 300.0, p(1, 50, 80)), 0.0)    // off the left
        assertEquals(150.0, GuideNav.scrollTo(100.0, 300.0, p(1, 380, 450)), 0.0) // off the right
        assertEquals(100.0, GuideNav.scrollTo(100.0, 300.0, p(1, 150, 250)), 0.0) // already visible
        assertEquals(380.0, GuideNav.scrollTo(100.0, 300.0, p(1, 380, 900)), 0.0) // longer than window
    }

    // ---- between programmes (adverts / announcement slot): nothing "airs now" but the channel is still on air ----

    // channel 1 has a break between 200 and 230
    private val gapEpg = mapOf(1 to listOf(p(10, 0, 100), p(11, 100, 200), p(12, 230, 330)))
    private val gapNav = GuideNav(ch.take(1), gapEpg)

    @Test fun inAGapTheGuideLandsOnTheNextProgrammeNotTheOldestOne() {
        // regression: it used to select the first (long past) programme in the row
        assertEquals(12, gapNav.atNow(0, 215.0).prog?.id)
    }

    @Test fun aChannelInAGapCanStillBeTuned() {
        // regression: OK did nothing unless the selected programme was airing right now
        val s = gapNav.atNow(0, 215.0)
        assertTrue(gapNav.tunable(0, s.prog, 215.0))
        assertTrue(gapNav.tunable(0, gapEpg[1]!![0], 215.0)) // even a past programme in the row
    }

    @Test fun duringAProgrammeOnlyTheLiveOneIsTunable() {
        val now = 150.0
        assertTrue(gapNav.tunable(0, gapEpg[1]!![1], now))   // live
        assertFalse(gapNav.tunable(0, gapEpg[1]!![2], now))  // a future one just shows its info
        assertFalse(gapNav.tunable(0, gapEpg[1]!![0], now))  // a past one too
    }

    @Test fun afterTheLastProgrammeFallsBackToTheLastOne() {
        assertEquals(12, gapNav.atNow(0, 999.0).prog?.id)
    }
}
