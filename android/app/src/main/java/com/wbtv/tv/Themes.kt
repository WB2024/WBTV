package com.wbtv.tv

import androidx.compose.ui.graphics.Color

/** Same palettes as the web UI's themes, so the TV app matches whatever you picked there. */
data class WbtvTheme(
    val id: String, val label: String,
    val bg: Color, val top1: Color, val top2: Color, val frame: Color,
    val cell: Color, val cell2: Color, val past: Color,
    val sel: Color, val selTxt: Color, val selLine: Color,
    val txt: Color, val dim: Color, val accent: Color, val head: Color,
    val chan1: Color, val chan2: Color, val play1: Color, val play2: Color,
    val now: Color, val panel: Color,
    val rulerTxt: Color = Color.Unspecified, // text colour on the time ruler (defaults to dim)
    val flat: Boolean = false,               // square boxes with gaps, highlighted channel row
    val previewRight: Boolean = false,       // preview on the right, with a title strip on top
)

private fun c(hex: Long) = Color(0xFF000000 or hex)

val Themes = listOf(
    WbtvTheme("classic", "Classic", c(0x050B2A), c(0x10248A), c(0x050B2A), c(0x5F7BDC), c(0x1A3A9C), c(0x0F2778), c(0x0B1A52),
        c(0xFFD400), c(0x101A50), c(0xFFFFFF), c(0xEAF1FF), c(0x8FA4E0), c(0x3FD0FF), c(0x08155E),
        c(0x14308F), c(0x0D2070), c(0x1D7A3C), c(0x135A2C), c(0xFF4D4D), c(0x0A1856)),
    WbtvTheme("vintage", "Vintage", c(0x1B110A), c(0x4A2C14), c(0x1B110A), c(0xB98A4A), c(0x8A5226), c(0x64391A), c(0x3A2412),
        c(0xF3D9A0), c(0x3A1F08), c(0xFFF3D0), c(0xF6E7C8), c(0xCFAE7C), c(0xE9A64F), c(0x2E1C0E),
        c(0x6B3F1C), c(0x4E2B12), c(0x7D8F3A), c(0x5C6B28), c(0xFF6A3D), c(0x2F1D0E)),
    WbtvTheme("90s", "90s", c(0x12082B), c(0x3A0CA3), c(0x12082B), c(0xFF4FD8), c(0x0AA3B5), c(0x07707F), c(0x1B1A4A),
        c(0xFFF200), c(0x2B0A5E), c(0xFF4FD8), c(0xFFFFFF), c(0xC7B5FF), c(0x00F0FF), c(0x230A5A),
        c(0xD4249F), c(0x8A1A87), c(0x00B36B), c(0x008A52), c(0xFFF200), c(0x220B57)),
    WbtvTheme("modern", "Modern", c(0x0E0F13), c(0x14151B), c(0x14151B), c(0x2F3340), c(0x22252F), c(0x1D2029), c(0x13141A),
        c(0x4C8DFF), c(0xFFFFFF), c(0xA8C6FF), c(0xE8EAF0), c(0x8B90A0), c(0x4C8DFF), c(0x14151B),
        c(0x1A1C24), c(0x1A1C24), c(0x1D3B2B), c(0x1D3B2B), c(0xFF5A5A), c(0x171920)),
    WbtvTheme("aero", "Aero", c(0x0B3A5E), c(0x8FD3F7), c(0x0E4A78), c(0xD4EEFC), c(0x63B9EC), c(0x2A86C1), c(0x195079),
        c(0xFFF0A0), c(0x12354F), c(0xFFFFFF), c(0xFFFFFF), c(0xD3EBFA), c(0xB6F3FF), c(0x1F70AC),
        c(0x4AA6DD), c(0x1F73AB), c(0x62C462), c(0x3B8D3B), c(0xFF7043), c(0x12527F)),
    WbtvTheme("teletext", "Teletext", c(0x000000), c(0x000000), c(0x000000), c(0xFFFFFF), c(0x0000C8), c(0x0000C8), c(0x000000),
        c(0xFFFF00), c(0x000000), c(0x00FFFF), c(0xFFFFFF), c(0x00FFFF), c(0x00FF00), c(0x000000),
        c(0x000000), c(0x000000), c(0x008000), c(0x008000), c(0xFF0000), c(0x000000)),
    WbtvTheme("satellite", "Satellite (classic)", c(0xC4D8F2), c(0x202A85), c(0x141C66), c(0xFFFFFF), c(0x1C3DB3), c(0x1C3DB3), c(0x14267A),
        c(0xFFD90F), c(0x000000), c(0xFFFFFF), c(0xFFFFFF), c(0xC9D7FB), c(0xFFD90F), c(0xD9E6F9),
        c(0x1C3DB3), c(0x1C3DB3), c(0x12A150), c(0x12A150), c(0xE8262A), c(0x141C66),
        rulerTxt = c(0x1B2478), flat = true, previewRight = true),
    WbtvTheme("satellite-hd", "Satellite HD", c(0x0C2C70), c(0x143F96), c(0x0C2C70), c(0xCFE2FF), c(0x3D84D8), c(0x2A63B6), c(0x17428C),
        c(0xFFD84A), c(0x101A40), c(0xFFFFFF), c(0xFFFFFF), c(0xB8D0F5), c(0xFFD84A), c(0x0A2158),
        c(0x1F5FBD), c(0x1A4FA0), c(0x2AA05A), c(0x1D7A43), c(0xFF5A4D), c(0x0F326F),
        flat = true, previewRight = true),
    WbtvTheme("synthwave", "Synthwave", c(0x0B021D), c(0x34095F), c(0x0B021D), c(0xFF2A6D), c(0x3A1A7A), c(0x24104F), c(0x150A33),
        c(0xFF2A6D), c(0xFFFFFF), c(0x05D9E8), c(0xF3E9FF), c(0xA98FE0), c(0x05D9E8), c(0x1A0B42),
        c(0x4B1A99), c(0x2D0F66), c(0x0A8F6A), c(0x07684E), c(0x05D9E8), c(0x1A0B42)),
)

fun themeById(id: String) = Themes.firstOrNull { it.id == id } ?: Themes.first()
