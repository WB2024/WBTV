package com.wbtv.tv

/** The filter chips above the guide: which channels are listed. */
enum class ChannelFilter(val id: String, val label: String, val test: (Channel) -> Boolean) {
    ALL("all", "All channels", { true }),
    TV("tv", "TV", { it.kind == "tv" }),
    MOVIES("movie", "Movies", { it.kind == "movie" }),
    NETWORKS("network", "Networks", { it.key.startsWith("tv:studio:") }),
    GENRES("genre", "Genres", { it.key.contains(":genre:") });

    companion object {
        fun byId(id: String) = entries.firstOrNull { it.id == id } ?: ALL
    }
}
