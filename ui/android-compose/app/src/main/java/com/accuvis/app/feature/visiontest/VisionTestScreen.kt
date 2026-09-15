package com.accuvis.app.feature.visiontest

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.accuvis.app.core.designsystem.*
import com.accuvis.app.models.EyeSelection
import com.accuvis.app.tracking.TrackingState
import com.accuvis.app.tracking.TrackingTelemetry

/**
 * Stimulus orientation for Tumbling E test
 */
enum class StimulusDirection(val angleDegrees: Float) {
    RIGHT(0f),
    DOWN(90f),
    LEFT(180f),
    UP(270f)
}

data class VisionTestUiState(
    val patientName: String = "John Doe",
    val activeEye: EyeSelection = EyeSelection.OD,
    val distanceLabel: String = "40 cm (Near)",
    val currentSnellen: String = "20/40",
    val currentTrial: Int = 3,
    val maxTrials: Int = 12,
    val currentDirection: StimulusDirection = StimulusDirection.RIGHT,
    val optotypeSizePx: Float = 140f,
    val isFixationStable: Boolean = true,
    val telemetry: TrackingTelemetry = TrackingTelemetry(state = TrackingState.TRACKING)
)

/**
 * Screen 6: Vision Test Screen
 * 
 * Features:
 * 1. Strict clinical neutral white optotype canvas (#FFFFFF) with pure black optotype (#000000).
 * 2. Real-time eye-tracking fixation feedback indicator.
 * 3. Clinical operator keypad with minimum 48dp touch targets.
 * 4. Dedicated "Cannot See" and "Repeat" controls for operator-assisted workflow.
 */
@Composable
fun VisionTestScreen(
    uiState: VisionTestUiState,
    onDirectionResponse: (StimulusDirection) -> Unit,
    onCannotSee: () -> Unit,
    onRepeatStimulus: () -> Unit,
    onAbortTest: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(DarkBackground)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // --- 1. Top Clinical Status Header ---
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = uiState.patientName,
                    style = MaterialTheme.typography.titleLarge,
                    color = TextPrimary
                )
                Text(
                    text = "Testing: ${uiState.activeEye.displayName} • ${uiState.distanceLabel}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary
                )
            }

            // Gaze Fixation Live Badge
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = SurfaceElevated,
                border = androidx.compose.foundation.BorderStroke(1.dp, SurfaceBorder)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(if (uiState.isFixationStable) StatusSuccess else StatusError)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = if (uiState.isFixationStable) "Fixation Stable" else "Fixation Lost",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (uiState.isFixationStable) StatusSuccess else StatusError
                    )
                }
            }

            IconButton(
                onClick = onAbortTest,
                modifier = Modifier.size(MinTouchTargetSize)
            ) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "Abort Test",
                    tint = TextSecondary
                )
            }
        }

        // Trial Progress & Snellen Acuity Level
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Trial ${uiState.currentTrial} of ${uiState.maxTrials}",
                color = TextMuted,
                fontSize = 14.sp
            )
            Text(
                text = "Target Acuity: ${uiState.currentSnellen}",
                color = PrimaryYellow,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold
            )
        }

        // --- 2. CLINICAL OPTOTYPE CANVAS (Strict Neutral White Field) ---
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1.0f)
                .clip(RoundedCornerShape(16.dp))
                .background(OptotypeFieldBackground) // Strict Clinical #FFFFFF
                .border(2.dp, OptotypeGridGuide, RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center
        ) {
            // Tumbling 'E' Optotype Stimulus (Strict Clinical #000000)
            TumblingEOptotype(
                direction = uiState.currentDirection,
                modifier = Modifier.size(uiState.optotypeSizePx.dp)
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        // --- 3. OPERATOR RESPONSE PANEL ---
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SurfaceDark, RoundedCornerShape(16.dp))
                .border(1.dp, SurfaceBorder, RoundedCornerShape(16.dp))
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "OPERATOR RESPONSE KEYPAD",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = TextMuted,
                letterSpacing = 1.sp,
                modifier = Modifier.padding(bottom = 8.dp)
            )

            // D-Pad Grid for Directional Acuity
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // UP Button
                KeypadDirectionButton(
                    direction = StimulusDirection.UP,
                    onClick = { onDirectionResponse(StimulusDirection.UP) }
                )

                Row(
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // LEFT Button
                    KeypadDirectionButton(
                        direction = StimulusDirection.LEFT,
                        onClick = { onDirectionResponse(StimulusDirection.LEFT) }
                    )

                    // Neutral Center Indicator
                    Box(
                        modifier = Modifier
                            .size(MinTouchTargetSize)
                            .clip(CircleShape)
                            .background(SurfaceElevated),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "E",
                            color = PrimaryYellow,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 18.sp
                        )
                    }

                    // RIGHT Button
                    KeypadDirectionButton(
                        direction = StimulusDirection.RIGHT,
                        onClick = { onDirectionResponse(StimulusDirection.RIGHT) }
                    )
                }

                // DOWN Button
                KeypadDirectionButton(
                    direction = StimulusDirection.DOWN,
                    onClick = { onDirectionResponse(StimulusDirection.DOWN) }
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Clinical Secondary Actions: "Cannot See" & "Repeat"
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Button(
                    onClick = onCannotSee,
                    modifier = Modifier
                        .weight(1f)
                        .height(MinTouchTargetSize),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SurfaceElevated,
                        contentColor = StatusError
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(Icons.Default.VisibilityOff, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Cannot See", fontWeight = FontWeight.SemiBold)
                }

                Button(
                    onClick = onRepeatStimulus,
                    modifier = Modifier
                        .weight(1f)
                        .height(MinTouchTargetSize),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SurfaceElevated,
                        contentColor = TextPrimary
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Repeat", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/**
 * Tumbling E Stimulus rendered with standard 5:5:1 Snellen grid proportions
 */
@Composable
private fun TumblingEOptotype(
    direction: StimulusDirection,
    modifier: Modifier = Modifier
) {
    Text(
        text = "E",
        modifier = modifier.rotate(direction.angleDegrees),
        fontSize = 110.sp,
        fontWeight = FontWeight.Black,
        fontFamily = androidx.compose.ui.text.font.FontFamily.SansSerif,
        color = OptotypeStimulusColor, // Strict #000000
        textAlign = TextAlign.Center
    )
}

/**
 * Keypad directional touch button with 48dp minimum touch target
 */
@Composable
private fun KeypadDirectionButton(
    direction: StimulusDirection,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    IconButton(
        onClick = onClick,
        modifier = modifier
            .size(56.dp)
            .padding(4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(PrimaryYellow)
    ) {
        val icon = when (direction) {
            StimulusDirection.UP -> Icons.Default.KeyboardArrowUp
            StimulusDirection.DOWN -> Icons.Default.KeyboardArrowDown
            StimulusDirection.LEFT -> Icons.Default.KeyboardArrowLeft
            StimulusDirection.RIGHT -> Icons.Default.KeyboardArrowRight
        }
        Icon(
            imageVector = icon,
            contentDescription = direction.name,
            tint = TextOnYellow,
            modifier = Modifier.size(32.dp)
        )
    }
}
