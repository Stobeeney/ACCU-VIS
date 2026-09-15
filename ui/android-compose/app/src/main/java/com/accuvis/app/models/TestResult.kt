package com.accuvis.app.models

import java.time.Instant
import java.util.UUID

enum class ChartType(val label: String) {
    TUMBLING_E("Tumbling E"),
    LANDOLT_C("Landolt C"),
    SNELLEN("Snellen Alphabet")
}

enum class TestDistance(val meters: Float, val label: String) {
    NEAR(0.40f, "40 cm (Near)"),
    INTERMEDIATE(1.0f, "1.0 m (Intermediate)"),
    DISTANCE(2.0f, "2.0 m (Clinical)")
}

data class TrialRecord(
    val trialNumber: Int,
    val snellenLevel: String, // e.g. "20/40"
    val logMAR: Float,
    val targetStimulus: String, // "UP", "DOWN", "LEFT", "RIGHT"
    val patientResponse: String, // "UP", "DOWN", "CANNOT_SEE", etc.
    val isCorrect: Boolean,
    val responseTimeMs: Long,
    val fixationQuality: Float // 0.0 to 1.0
)

data class TestResult(
    val id: String = UUID.randomUUID().toString(),
    val patientId: String,
    val patientName: String,
    val timestamp: Instant = Instant.now(),
    val eyeTested: EyeSelection,
    val distance: TestDistance,
    val chartType: ChartType,
    val finalSnellen: String, // e.g. "20/20"
    val finalLogMAR: Float,
    val decimalAcuity: Float,
    val totalTrials: Int,
    val correctTrials: Int,
    val fixationStabilityScore: Float, // 0 - 100%
    val fixationLossCount: Int,
    val trials: List<TrialRecord> = emptyList()
)
