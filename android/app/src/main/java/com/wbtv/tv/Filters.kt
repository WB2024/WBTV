package com.wbtv.tv

/** A filter chip above the guide: which channels are listed. Equal when the ids are equal. */
class ChannelFilter(val id: String, val label: String, val test: (Channel) -> Boolean) {
    override fun equals(other: Any?) = other is ChannelFilter && other.id == id
    override fun hashCode() = id.hashCode()

    companion object {
        val ALL = ChannelFilter("all", "All channels") { true }
        val TV = ChannelFilter("tv", "TV") { it.kind == "tv" || it.kind == "clips" } // clips and interviews sit with TV
        val MOVIES = ChannelFilter("movie", "Movies") { it.kind == "movie" }
        val MUSIC = ChannelFilter("music", "Music") { it.kind == "music" }
        val RADIO = ChannelFilter("radio", "Radio") { it.kind == "radio" }
        val LIVE = ChannelFilter("live", "Live") { it.kind == "live" }
        val NETWORKS = ChannelFilter("network", "Networks") { it.key.startsWith("tv:studio:") }
        val GENRES = ChannelFilter("genre", "Genres") { it.key.contains(":genre:") }

        /** The fixed chips; the server's channel groups are added after them (see [group]). */
        val entries = listOf(ALL, TV, MOVIES, MUSIC, RADIO, LIVE, NETWORKS, GENRES)

        /** A chip for one channel group (a library setting on the server). */
        fun group(name: String) = ChannelFilter("g:$name", name) { it.grp == name }

        fun byId(id: String) = if (id.startsWith("g:")) group(id.removePrefix("g:")) else entries.firstOrNull { it.id == id } ?: ALL
    }
}
