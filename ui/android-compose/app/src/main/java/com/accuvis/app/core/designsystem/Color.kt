package com.accuvis.app.core.designsystem

import androidx.compose.ui.graphics.Color

/**
 * Accu-Vis Clinical Operator Design Tokens
 * 
 * Strict Black and Yellow Theme:
 * - High contrast dark surface for clinical operator environment
 * - High-visibility yellow accents (#FFD400) for primary interactions & status
 * - Strict isolated neutral white (#FFFFFF) optotype canvas with #000000 black
 *   acuity stimuli for clinical validity.
 */

// Backgrounds & Surfaces (OLED Dark)
val DarkBackground = Color(0xFF090909)
val SurfaceDark = Color(0xFF171717)
val SurfaceElevated = Color(0xFF222222)
val SurfaceBorder = Color(0xFF303030)
val SurfaceBorderFocus = Color(0xFF505050)

// Accents (Safety / Clinical High-Visibility Yellow)
val PrimaryYellow = Color(0xFFFFD400)
val PrimaryYellowPressed = Color(0xFFE7B900)
val PrimaryYellowDim = Color(0x33FFD400)

// Text Hierarchy
val TextPrimary = Color(0xFFF7F7F7)
val TextSecondary = Color(0xFFA3A3A3)
val TextMuted = Color(0xFF6E6E6E)
val TextOnYellow = Color(0xFF090909)

// Status Colors
val StatusSuccess = Color(0xFF34C759)
val StatusWarning = Color(0xFFFF9500)
val StatusError = Color(0xFFFF453A)
val StatusInfo = Color(0xFF0A84FF)

// Clinical Optotype Neutral Field (MUST NOT BE STYLED WITH YELLOW)
val OptotypeFieldBackground = Color(0xFFFFFFFF)
val OptotypeStimulusColor = Color(0xFF000000)
val OptotypeGridGuide = Color(0xFFE5E5EA)
