package com.accuvis.app.tracking

import kotlinx.coroutines.flow.StateFlow

enum class TrackingState {
    UNINITIALIZED,
    INITIALIZING,
    SEARCHING,
    TRACKING,
    POOR_LIGHTING,
    OCCLUSION,
    LOST
}

enum class CalibrationQuality {
    NOT_CALIBRATED,
    POOR,
    FAIR,
    EXCELLENT
}

data class Point3D(
    val x: Float,
    val y: Float,
    val z: Float
)

data class HeadPose(
    val pitch: Float = 0f, // degrees
    val yaw: Float = 0f,   // degrees
    val roll: Float = 0f,  // degrees
    val distanceCm: Float = 40f
)

data class EyeLandmarks(
    val irisCenter: Point3D = Point3D(0f, 0f, 0f),
    val pupilDiameterMm: Float = 3.5f,
    val isBlinking: Boolean = false,
    val openRatio: Float = 1.0f // 0.0 (closed) to 1.0 (open)
)

data class GazeVector(
    val origin: Point3D = Point3D(0f, 0f, 0f),
    val direction: Point3D = Point3D(0f, 0f, -1f),
    val screenIntersectionNormX: Float = 0.5f, // 0.0 (left) to 1.0 (right)
    val screenIntersectionNormY: Float = 0.5f, // 0.0 (top) to 1.0 (bottom)
    val confidence: Float = 1.0f
)

data class TrackingTelemetry(
    val state: TrackingState = TrackingState.UNINITIALIZED,
    val headPose: HeadPose = HeadPose(),
    val leftEye: EyeLandmarks = EyeLandmarks(),
    val rightEye: EyeLandmarks = EyeLandmarks(),
    val gaze: GazeVector = GazeVector(),
    val fixationStabilityScore: Float = 1.0f, // 0.0 to 1.0
    val calibrationQuality: CalibrationQuality = CalibrationQuality.NOT_CALIBRATED,
    val fps: Float = 0f,
    val timestampMs: Long = System.currentTimeMillis()
)

/**
 * Universal interface for Accu-Vis eye tracking providers.
 * Decouples the UI layer from hardware and vision backends,
 * allowing MockTrackingProvider and MediaPipeTrackingProvider interchangeability.
 */
interface TrackingProvider {
    /**
     * Observable stream of real-time tracking data for UI binding
     */
    val telemetryFlow: StateFlow<TrackingTelemetry>

    /**
     * Human-readable provider name (e.g. "Mock Simulation", "MediaPipe FaceMesh")
     */
    val providerName: String

    suspend fun initialize(): Result<Unit>
    suspend fun start(): Result<Unit>
    suspend fun pause()
    suspend fun stop()
    suspend fun calibrateCenter(): CalibrationQuality
    fun isSimulated(): Boolean
}
