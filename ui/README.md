# Accu-Vis Clinical Operator Station UI

This directory contains the user interface implementation for the **Accu-Vis** operator-assisted vision testing and manual fixture alignment system.

## Directory Overview

- `index.html` — Zero-dependency Single Page Application shell containing all 9 clinical screens.
- `app.css` — Complete design system adhering to the Black & Yellow theme (`#090909`, `#171717`, `#FFD400`) and the isolated neutral white clinical optotype canvas (`#FFFFFF`).
- `app.js` — Client state machine with `MockTrackingProvider`, live WebRTC camera preview toggle, 6-step fixture checklist wizard, Tumbling E / Landolt C / Snellen acuity test engine, and local records persistence.
- `server.py` — Zero-dependency Python development server with automatic port detection and CORS support.
- `android-compose/` — Reference native Android Jetpack Compose architecture implementing the identical specifications, data models, tracking interfaces, and clinical screens.

---

## Quick Start: Launching the Web UI

To launch the UI locally in any web browser:

```bash
# Option 1: Using Python directly
python3 server.py --open

# Option 2: Using npm
npm start
```

The server will automatically start on `http://localhost:8080`.

---

## Implemented Screens (9 Screens)

1. **Screen 1: Dashboard / Home**
   - Active tracking mode indicator (`Simulation Mode` vs `MediaPipe Live`)
   - Active eye status pill (OD, OS, OU) and linear guide distance pill (40cm, 1m, 2m)
   - Quick navigation cards to Start Exam, Patient Records, and Device Calibration

2. **Screen 2: Patient Intake**
   - Medical Record Number (MRN) auto-generation
   - Full Name, Age, Gender, and Clinical Notes
   - Eye selection: **OD (Right Eye)**, **OS (Left Eye)**, **OU (Both Eyes)**

3. **Screen 3: Physical Setup Wizard (Manual Fixture)**
   - 6-step manual checklist for the physical hardware fixture:
     - Step 1: Linear guide rail positioning (confirming 40cm / 1m / 2m)
     - Step 2: Chin rest & forehead bar height alignment
     - Step 3: Occluder paddle placement matching intake selection
     - Step 4: Phone mount & vertical clamp tension
     - Step 5: Ambient clinical illumination check
     - Step 6: Final physical lock confirmation

4. **Screen 4: Test Configuration**
   - Chart System selection: Tumbling E, Landolt C, Snellen Letters
   - Starting Snellen acuity level: 20/200, 20/100, 20/50, 20/20
   - Test mode: Standard Clinical Staircase (3-down / 1-up) or Screening Rapid

5. **Screen 5: Alignment & Calibration**
   - Live camera preview toggle (Integrated laptop camera / phone camera via WebRTC) or simulated video feed
   - Face alignment guide oval and target crosshair
   - Real-time fixation stability score & center calibration button

6. **Screen 6: Vision Test (Acuity Presentation)**
   - **Clinical Optotype Canvas**: Strictly isolated neutral white field (`#FFFFFF`) with pure black optotypes (`#000000`)
   - Real-time fixation status badge (Green = Fixated, Red = Loss of Fixation)
   - **Operator Keypad Controls**: High-visibility D-pad (Up, Down, Left, Right) with `>= 48dp` touch targets
   - Dedicated "Cannot See / Unsure" and "Repeat Stimulus" buttons
   - Keyboard shortcuts: Arrow keys (Up, Down, Left, Right), Space (Cannot See), R (Repeat), Esc (Abort)

7. **Screen 7: Results & Clinical Report**
   - Summary card with Final Snellen Acuity (e.g. 20/20), LogMAR (+0.00), and Decimal Acuity
   - Fixation stability index percentage and loss count
   - Detailed per-trial log table with target direction, response, response time, and correctness
   - JSON export and print/save triggers

8. **Screen 8: Patient Records / History**
   - Searchable and filterable database of past exam sessions
   - Visual acuity comparison view across OD, OS, and OU trials
   - Data stored reliably in local browser storage

9. **Screen 9: Settings & Hardware Configuration**
   - Clinical default settings (Distance, Chart System, Brightness)
   - Tracking provider switch (`MockTrackingProvider` vs `MediaPipeTrackingProvider`)
   - Disabled automated motor control banner (reserved for Phase 4)
   - Data privacy and tokenization controls

---

## Native Android Compose Reference Architecture

Located in `android-compose/app/src/main/java/com/accuvis/app/`:
- `core/designsystem/Color.kt`: Strict design tokens and clinical white canvas.
- `core/designsystem/Theme.kt`: Material 3 theme and touch target constraints.
- `tracking/TrackingProvider.kt`: Clean interface for tracking abstraction.
- `tracking/MockTrackingProvider.kt`: Realistic micro-saccades and blink simulation engine.
- `tracking/MediaPipeTrackingProvider.kt`: MediaPipe Face Mesh & iris landmark integration hooks.
- `models/Patient.kt` & `models/TestResult.kt`: Domain models.
- `feature/visiontest/VisionTestScreen.kt`: Jetpack Compose composable for the vision test.
