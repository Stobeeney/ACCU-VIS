package com.accuvis.app.models

/**
 * Accu-Vis Prototype Hardware Features & Feasibility Evaluation Model
 * Based directly on: Accu-Vis-Feasibility-Evaluation (June 22, 2026)
 * "Innovation of an Automated and Compact Clinical Unit for Near Vision Testing"
 */

enum class FeasibilityRating(val label: String, val colorHex: Long) {
    FEASIBLE("Feasible", 0xFF34C759),
    IMPRACTICAL("Impractical", 0xFFFF453A),
    UNSURE("Unsure", 0xFFFF9F0A)
}

enum class LinearGuideMotorType(val label: String) {
    MANUAL("Manual Rail Slide (Lightweight)"),
    STEPPER("Stepper Motor (Precision Steps)"),
    SERVO("Servo Motor (Continuous Travel)")
}

enum class SlidingOccluderPosition(val label: String, val activeEye: EyeSelection) {
    SLIDE_LEFT("Slide Left: Occlude OS -> Test OD (Right)", EyeSelection.OD),
    CENTER_OPEN("Center: Both Eyes Open -> Test OU (Binocular)", EyeSelection.OU),
    SLIDE_RIGHT("Slide Right: Occlude OD -> Test OS (Left)", EyeSelection.OS)
}

/**
 * Feature 1: Linear Guide (Page 3)
 * Allows phone holder to move forward and backward.
 * Possible usage of motor either Stepper or Servo.
 * Note: Motor may cause heavier mass.
 */
data class LinearGuideFeature(
    val feasibility: FeasibilityRating = FeasibilityRating.FEASIBLE,
    val distanceCm: Float = 40.0f, // 40 cm standard near visual acuity
    val motorType: LinearGuideMotorType = LinearGuideMotorType.MANUAL,
    val isMotorized: Boolean = false,
    val minDistanceCm: Float = 20.0f,
    val maxDistanceCm: Float = 100.0f
)

/**
 * Feature 2: Sliding Occluder (Page 4)
 * Changes placement from side to side using linear sliding technique (R - L, L - R).
 * Isolates the eye cover when in-use.
 */
data class SlidingOccluderFeature(
    val feasibility: FeasibilityRating = FeasibilityRating.FEASIBLE,
    val position: SlidingOccluderPosition = SlidingOccluderPosition.CENTER_OPEN,
    val isolationVerified: Boolean = true
)

/**
 * Feature 3: Pivot Connector (Page 5)
 * Evaluation Finding: Impractical and will not work.
 * Replaced by through-and-through linear height pole with loose-and-tight knob method.
 */
data class PivotConnectorFeature(
    val feasibility: FeasibilityRating = FeasibilityRating.IMPRACTICAL,
    val isReplacedByPole: Boolean = true,
    val replacementDescription: String = "Major/Minor pole with loose & tight knob method and table clamp",
    val tableClampLocked: Boolean = true,
    val heightKnobLocked: Boolean = true
)

/**
 * Feature 4: Chin Rest (Page 6)
 * Custom design based on the eye-to-chin distance of each head.
 * Uses loose-and-tight knob method to adjust vertical height.
 */
data class ChinRestFeature(
    val feasibility: FeasibilityRating = FeasibilityRating.FEASIBLE,
    val heightMm: Float = 120.0f,
    val knobAdjustable: Boolean = true,
    val opticalCenterAligned: Boolean = true
)

/**
 * Feature 5: Phone Holder (Page 7)
 * Designed to hold phone to be used in test, attached to linear guide carriage.
 */
data class PhoneHolderFeature(
    val feasibility: FeasibilityRating = FeasibilityRating.UNSURE,
    val attachedToLinearGuide: Boolean = true,
    val cameraLensUnobstructed: Boolean = true,
    val orientation: String = "PORTRAIT"
)

/**
 * Complete Accu-Vis Prototype Fixture State
 */
data class AccuVisFixtureState(
    val linearGuide: LinearGuideFeature = LinearGuideFeature(),
    val occluder: SlidingOccluderFeature = SlidingOccluderFeature(),
    val pivotConnector: PivotConnectorFeature = PivotConnectorFeature(),
    val chinRest: ChinRestFeature = ChinRestFeature(),
    val phoneHolder: PhoneHolderFeature = PhoneHolderFeature(),
    val evaluationDate: String = "June 22, 2026"
)
