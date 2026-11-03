package com.wbtv.tv

import org.junit.Assert.assertEquals
import org.junit.Test

class ChannelFilterTest {
    private val channels = listOf(
        Channel(1, "BBC One", 1, "tv", "tv:studio:bbc one"),
        Channel(2, "Laugh Track", 11, "tv", "tv:genre:comedy"),
        Channel(3, "Fright Night Cinema", 80, "movie", "movie:genre:horror"),
        Channel(4, "Warner Bros.", 90, "movie", "movie:studio:warner bros"),
        Channel(5, "1990s Cinema", 95, "movie", "movie:decade:1990"),
    )

    private fun ids(f: ChannelFilter) = channels.filter(f.test).map { it.id }

    @Test fun eachChipSelectsTheRightChannels() {
        assertEquals(listOf(1, 2, 3, 4, 5), ids(ChannelFilter.ALL))
        assertEquals(listOf(1, 2), ids(ChannelFilter.TV))
        assertEquals(listOf(3, 4, 5), ids(ChannelFilter.MOVIES))
        assertEquals(listOf(1), ids(ChannelFilter.NETWORKS))
        assertEquals(listOf(2, 3), ids(ChannelFilter.GENRES)) // genre channels of both kinds
    }

    @Test fun savedIdsMapBackAndUnknownFallsBackToAll() {
        for (f in ChannelFilter.entries) assertEquals(f, ChannelFilter.byId(f.id))
        assertEquals(ChannelFilter.group("Stand Up"), ChannelFilter.byId("g:Stand Up"))
        assertEquals(ChannelFilter.ALL, ChannelFilter.byId("nonsense"))
    }
}
