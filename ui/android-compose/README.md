# Accu-Vis Android Jetpack Compose Architecture

This directory contains the production-grade **Android Jetpack Compose** architecture for the Accu-Vis Operator-Assisted Clinical Visual Acuity and Eye Tracking Application.

## Project Structure

```
android-compose/
└── app/
    └── src/
        └── main/
            └── java/
                └── com/
                    └── accuvis/
                        └── app/
                            ├── core/
                            │   └── designsystem/
                            │       ├── Color.kt       # Strict Black & Yellow tokens (#090909, #171717, #FFD400) & #FFFFFF canvas
                            │       └── Theme.kt       # Material 3 dark theme with 48dp touch targets
                            ├── models/
                            │   ├── Patient.kt         # Patient demographic & eye occluder selection (OD, OS, OU)
                            │   └── TestResult.kt      # Exam records, LogMAR / Snellen metrics, trial histories
                            ├── tracking/
                            │   ├── TrackingProvider.kt          # Clean abstraction for eye tracking backends
                            │   ├── MockTrackingProvider.kt       # Deterministic simulation engine (micro-saccades, blinks)
                            │   └── MediaPipeTrackingProvider.kt # Live CameraX & FaceLandmarker / Iris hooks
                            └── feature/
                                └── visiontest/
                                    └── VisionTestScreen.kt      # Strict neutral white stimulus canvas + keypad
```

## Key Architectural Principles

1. **Unidirectional Data Flow (UDF)**:
   - UI states are hoisted in ViewModels and exposed as read-only `StateFlow`.
   - User/operator actions are dispatched down via typed callbacks.

2. **Decoupled Eye Tracking Layer**:
   - `TrackingProvider` interface abstracts away vision dependencies.
   - `MockTrackingProvider` allows testing and clinical protocol validation without needing a physical camera or MediaPipe binaries.
   - `MediaPipeTrackingProvider` connects to CameraX and Google MediaPipe Face Mesh (landmarks 468–477 for iris center and gaze vector).

3. **Strict Clinical Isolation**:
   - The operator theme is OLED Black (`#090909`, `#171717`) with High-Visibility Yellow (`#FFD400`).
   - The **Optotype Canvas** is isolated as a strictly neutral white field (`#FFFFFF`) with pure black (`#000000`) optotypes to satisfy clinical visual acuity standards.
   - All touch targets strictly conform to `>= 48dp`.

## Dependencies (for `build.gradle.kts`)

```kotlin
dependencies {
    // Jetpack Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material:material-icons-extended")

    // Coroutines & Lifecycle
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // MediaPipe Vision (when connecting live tracking)
    implementation("com.google.mediapipe:tasks-vision:0.10.14")
    
    // CameraX
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
}
```
