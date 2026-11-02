package com.wbtv.tv

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The server's compact guide feed (?slim=1) leaves out empty fields; the app must read it exactly like the full one. */
class SlimEpgTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    @Test
    fun slimEntriesDecodeWithDefaults() {
        val text = """{"now":1.0,"from":0.0,"to":10.0,"programmes":{"3":[
            {"id":214,"item":14,"start":100.0,"end":200.0,"title":"Scary Nights","subtitle":"Ep","season":1,"episode":2,"year":2016,"mpaa":"TV-MA","genres":["Horror"]},
            {"id":-1,"item":0,"start":0.0,"end":7200.0,"title":"BBC News","subtitle":"Live","plot":"Live stream."}]}}"""
        val list = json.decodeFromString<EpgResponse>(text).programmes["3"]!!
        assertEquals("Scary Nights", list[0].title)
        assertEquals(2, list[0].episode)
        assertNull(list[0].plot)
        assertFalse(list[0].movie)
        assertEquals(listOf("Horror"), list[0].genres)
        assertEquals("Live stream.", list[1].plot)
        assertEquals(emptyList<String>(), list[1].genres)
        assertNull(list[1].year)
    }

    @Test
    fun fullEntriesStillDecode() {
        val text = """{"now":1.0,"programmes":{"7":[{"id":1,"item":2,"start":0.0,"end":60.0,"movie":true,"title":"A Film","subtitle":"","season":null,"episode":null,"year":1999,"plot":"Plot","rating":null,"mpaa":"","genres":[]}]}}"""
        val p = json.decodeFromString<EpgResponse>(text).programmes["7"]!![0]
        assertEquals(true, p.movie)
        assertEquals("Plot", p.plot)
        assertNull(p.rating)
    }
}
