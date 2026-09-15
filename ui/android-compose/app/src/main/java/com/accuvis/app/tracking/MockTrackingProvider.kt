package com.accuvis.app.tracking

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.sin
import kotlin.random.Random

/**
 * MockTrackingProvider generates realistic ocular telemetry, micro-saccades,
 * periodic blinks, and fixation jitter for testing the Accu-Vis UI without
 * requiring a live camera feed or MediaPipe runtime.
 */
class MockTrackingProvider(
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default)
) : TrackingProvider {

    override val providerName: String = "MockTrackingProvider (Simulated Engine)"

    private val _telemetryFlow = MutableStateFlow(TrackingTelemetry())
    override val telemetryFlow: StateFlow<TrackingTelemetry> = _telemetryFlow.asStateFlow()

    private var simulationJob: Job? = null
    private var isRunning = false
    private var currentQuality = CalibrationQuality.NOT_CALIBRATED

    // Injectable simulation states for operator UI testing
    var forcedState: TrackingState? = null
    var simulatedDistanceCm: Float = 40f

    override suspend fun initialize(): Result<Unit> {
        _telemetryFlow.value = TrackingTelemetry(
            state = TrackingState.INITIALIZING,
            fps = 30f
        )
        delay(400) // Simulate fast warm-up
        _telemetryFlow.value = TrackingTelemetry(
            state = TrackingState.SEARCHING,
            fps = 30f
        )
        return Result.success(Unit)
    }

    override suspend fun start(): Result<Unit> {
        if (isRunning) return Result.success(Unit)
        isRunning = true

        simulationJob = scope.launch {
            var tick = 0L
            while (isActive && isRunning) {
                tick++
                val t = tick * 0.033f // ~30 fps interval

                // Natural physiological micro-tremor & micro-saccades
                val jitterX = (sin(t * 1.7) * 0.015f + (Random.nextFloat() - 0.5f) * 0.01f).toFloat()
                val jitterY = (sin(t * 2.3) * 0.012f + (Random.nextFloat() - 0.5f) * 0.008f).toFloat()

                // Periodic spontaneous blink (every ~4 seconds)
                val isBlink = (tick % 120L) in 0L..5L
                val openRatio = if (isBlink) 0.05f else 0.95f + (Random.nextFloat() * 0.05f)

                // Natural pupil hippus oscillation (3.2mm - 3.8mm)
                val pupilDia = (3.5f + sin(t * 0.8f) * 0.3f + Random.nextFloat() * 0.05f).toFloat()

                val activeState = forcedState ?: TrackingState.TRACKING

                _telemetryFlow.value = TrackingTelemetry(
                    state = activeState,
                    headPose = HeadPose(
                        pitch = (sin(t * 0.5f) * 1.2f).toFloat(),
                        yaw = (sin(t * 0.4f) * 1.5f).toFloat(),
                        roll = (sin(t * 0.2f) * 0.6f).toFloat(),
                        distanceCm = simulatedDistanceCm
                    ),
                    leftEye = EyeLandmarks(
                        irisCenter = Point3D(-32f + jitterX * 20f, 0f + jitterY * 20f, -400f),
                        pupilDiameterMm = pupilDia,
                        isBlinking = isBlink,
                        openRatio = openRatio
                    ),
                    rightEye = EyeLandmarks(
                        irisCenter = Point3D(32f + jitterX * 20f, 0f + jitterY * 20f, -400f),
                        pupilDiameterMm = pupilDia,
                        isBlinking = isBlink,
                        openRatio = openRatio
                    ),
                    gaze = GazeVector(
                        screenIntersectionNormX = (0.5f + jitterX).coerceIn(0f, 1f),
                        screenIntersectionNormY = (0.5f + jitterY).coerceIn(0f, 1f),
                        confidence = if (activeState == TrackingState.TRACKING) 0.96f else 0.2f
                    ),
                    fixationStabilityScore = 0.94f,
                    calibrationQuality = currentQuality,
                    fps = 30.0f,
                    timestampMs = System.currentTimeMillis()
                )

                delay(33) // ~30 fps
            }
        }

        return Result.success(Unit)
    }

    override suspend fun pause() {
        isRunning = false
        simulationJob?.cancel()
        simulationJob = null
    }

    override suspend fun stop() {
        pause()
        _telemetryFlow.value = TrackingTelemetry(state = TrackingState.UNINITIALIZED)
    }

    override suspend fun calibrateCenter(): CalibrationQuality {
        delay(800) // Simulate calibration processing
        currentQuality = CalibrationQuality.EXCELLENT
        _telemetryFlow.value = _telemetryFlow.value.copy(calibrationQuality = currentQuality)
        return currentQuality
    }

    override fun isSimulated(): Boolean = true
}
