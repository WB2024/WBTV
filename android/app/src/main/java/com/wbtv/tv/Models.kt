package com.wbtv.tv

import kotlinx.serialization.Serializable

@Serializable
data class Channel(
    val id: Int,
    val name: String,
    val number: Int? = null,
    val kind: String = "tv",
    val key: String = "",
)

@Serializable
data class Programme(
    val id: Int,
    val item: Int,
    val start: Double,
    val end: Double,
    val movie: Boolean = false,
    val title: String = "",
    val subtitle: String = "",
    val season: Int? = null,
    val episode: Int? = null,
    val year: Int? = null,
    val plot: String? = null,
    val rating: Double? = null,
    val mpaa: String? = null,
    val genres: List<String> = emptyList(),
) {
    fun airsAt(t: Double) = start <= t && end > t
}

@Serializable
data class EpgResponse(
    val now: Double = 0.0,
    val from: Double = 0.0,
    val to: Double = 0.0,
    val programmes: Map<String, List<Programme>> = emptyMap(),
)

@Serializable
data class Actor(val name: String = "", val role: String = "")

@Serializable
data class ItemDetail(
    val id: Int,
    val title: String = "",
    val showTitle: String? = null,
    val plot: String = "",
    val year: Int? = null,
    val actors: List<Actor> = emptyList(),
    val genres: List<String> = emptyList(),
    val studios: List<String> = emptyList(),
)
