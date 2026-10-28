// Accu-Vis NPC/NPA Stepper Rail: hardware configuration
//
// Wiring (NodeMCU 1.0 <-> A4988 driver board):
//
//   Signal    NodeMCU pin   GPIO     A4988 pin
//   ------    -----------   ----     ---------
//   STEP      D1            GPIO5    STEP
//   DIR       D2            GPIO4    DIR
//   ENABLE    D6            GPIO12   ENABLE   (active LOW; LOW = driver on)
//   MS1       D5            GPIO14   MS1
//   MS2       D7            GPIO13   MS2
//   MS3       D0            GPIO16   MS3
//   3V3       3V3           --       VDD (logic power)
//   GND       GND           --       GND (logic ground)
//
//   On the A4988 board itself (no ESP8266 pin needed):
//     - Jumper RESET to SLEEP with a short wire (both are active-LOW;
//       tying them together keeps the driver out of reset/sleep).
//     - VMOT / motor-GND go to a SEPARATE power supply matched to your
//       NEMA17's rated voltage (commonly 12V) -- never power the motor
//       coils from the ESP8266's 3V3 or USB 5V line.
//     - Put a >=100uF electrolytic capacitor across VMOT/GND right at the
//       board if it doesn't already have one; A4988s are notorious for
//       dying to power-supply voltage spikes without it.
//     - Set the current-limit trimpot for your motor's rated current
//       BEFORE connecting the motor (Vref = rated_amps * 8 * Rsense;
//       Rsense is usually 0.1 ohm on common breakout boards, so
//       Vref = rated_amps * 0.8). Start conservative and raise it if the
//       motor stalls under load.
//
//   Motor coil wiring (bipolar NEMA17, black/green/blue/red):
//     Coil A -> A4988 "1A"/"1B"  <- Black, Green
//     Coil B -> A4988 "2A"/"2B"  <- Red, Blue
//   If the motor buzzes/vibrates in place instead of turning smoothly,
//   swap the two wires of ONE coil pair (e.g. swap Black and Green) --
//   that's the standard fix and it cannot damage anything.

#pragma once

#define STEP_PIN   5   // D1
#define DIR_PIN    4   // D2
#define ENABLE_PIN 12  // D6 (active LOW)
#define MS1_PIN    14  // D5
#define MS2_PIN    13  // D7
#define MS3_PIN    16  // D0

// NEMA17 bipolar, standard 1.8 deg/step motor
#define STEPS_PER_REV 200

// MS1=MS2=MS3=HIGH on the A4988 selects 1/16 microstepping -- smooth,
// quiet motion, appropriate for a rail that moves close to a patient's face.
#define MICROSTEPS 16

// TODO: confirm this against your actual hardware. This is how far the
// carriage physically travels (in mm) for ONE full revolution of the motor
// -- i.e. your lead screw pitch (or belt pulley circumference if
// belt-driven). 8mm is a common T8 lead-screw pitch; change it if yours
// is different, then re-upload.
// MEASURED 2026-10-28: bench run commanded 2cm / 0.5cm and the carriage really
// moved 10cm / 2.5cm (exactly 5x) -> 8mm x 5 = 40mm per motor revolution. That
// matches a belt drive (20-tooth GT2 pulley = 20 x 2mm), not an 8mm lead screw.
// Re-verify with a ruler over a longer move and adjust if it is not exact.
#define LEAD_SCREW_PITCH_MM 40.0

#define MICROSTEPS_PER_CM ((STEPS_PER_REV * MICROSTEPS) / (LEAD_SCREW_PITCH_MM / 10.0))

// Matches the web app's dotState.railDistanceCm convention: 40.0cm is the
// parked "home" position (farthest from the patient), the carriage moves
// IN as this number goes DOWN toward the ~4cm clinical break/limit.
#define RAIL_HOME_CM 40.0
#define RAIL_MAX_CM  40.0

// How far the carriage can safely travel IN from the 40cm home mark before
// it would hit the end of the rail / the motor. The rail is 44cm end to end,
// but the carriage body and end margins take part of that. MEASURE IT: park
// at home, push the carriage by hand to the near end, subtract ~1cm of
// margin. Until measured, 30cm is deliberately conservative (min = 10cm).
// Every move is clamped to this in firmware, so it can never be driven
// past it by the web app or the standalone sequence.
#define RAIL_USABLE_TRAVEL_CM 20.0  // TEMP: verified 20cm travel (min 20cm) until the full usable travel is measured
#define RAIL_MIN_CM (RAIL_HOME_CM - RAIL_USABLE_TRAVEL_CM)

// Motor direction. If "closer" moves the carriage AWAY from the patient,
// flip this (true <-> false) and re-upload.
#define DIR_INVERT false

// Hard speed ceiling (RAIL_MAX_SPEED_CM_S below; 600 microsteps/s at 40mm/rev).
// The web app's speed pills (0.8 / 1.5 / 2.5 cm/s) are CLAMPED to this, and
// /move and /jog report the speed actually applied. Raise it only after
// bench-testing: stepping is done in software on the ESP8266, and above a
// few kHz (or with the motor current/supply too low) steps get lost, which
// breaks the open-loop position.
// Expressed in cm/s so they stay correct if the pitch changes again.
// 0.75 cm/s ceiling (was 3000 st/s, which is 3.75 cm/s real at 40mm/rev!).
#define RAIL_MAX_SPEED_CM_S 0.75
#define RAIL_ACCEL_CM_S2    2.0   // ~1600 st/s^2 here, same motor load as the tested 1500
#define STEPPER_MAX_SPEED (RAIL_MAX_SPEED_CM_S * MICROSTEPS_PER_CM)  // microsteps/sec
#define STEPPER_ACCEL     (RAIL_ACCEL_CM_S2 * MICROSTEPS_PER_CM)     // microsteps/sec^2

// Live motion readout on the serial monitor (115200 baud) while the carriage
// moves: position, target, speed, direction. 0 disables it. Lines are only
// printed when the serial buffer has room, so printing never delays steps.
#define SERIAL_TELEMETRY_MS 250

// ---------------------------------------------------------------------
// Standalone mode (no WiFi, no web app)
// ---------------------------------------------------------------------
// 1 = on power-up, wait STANDALONE_START_DELAY_MS, then run a hybrid NPC
//     approach on its own:
//       fast zone: 40cm -> STANDALONE_SLOW_ZONE_START_CM, continuous
//       slow zone: step STANDALONE_SLOW_STEP_CM at a time (slow speed),
//                  dwelling at each stop -> STANDALONE_TARGET_CM
//       then back to 40cm.
//     WiFi, the HTTPS server and the web app are NOT started.
// 0 = normal mode: WiFi AP + HTTPS API driven by the web app.
//
// SAFETY: standalone mode assumes the carriage is parked at the 40cm home
// mark at power-up (that position becomes 0). Never power-cycle it with the
// carriage near the patient.
#define STANDALONE_MODE               0
#define STANDALONE_START_DELAY_MS     5000
#define STANDALONE_TARGET_CM          20.0   // typical NPC break is ~10-15cm
#define STANDALONE_SLOW_ZONE_START_CM 30.0   // fast sweep ends here
#define STANDALONE_FAST_CM_S          0.75   // clamped to the speed ceiling
#define STANDALONE_SLOW_CM_S          0.5
#define STANDALONE_SLOW_STEP_CM       0.5    // advance this far per step
#define STANDALONE_DWELL_MS           2000   // pause at each stop (tracking window)

// ---------------------------------------------------------------------
// Cloud relay mode (the hosted website controls the rail through the server)
// ---------------------------------------------------------------------
// 1 = join the router WiFi (STA_SSID / STA_PASSWORD in secrets.h) and check in
//     with the server every poll_ms (the SERVER chooses: 20 s idle, 1 s armed,
//     0.5 s moving). No local web server and no access point in this mode.
// 0 = local mode (access point + HTTPS API on 192.168.4.1), kept for bench use.
//
// Safety, enforced HERE in the firmware (the server enforces it too):
//   * motion only while the server says "armed", never while "stop latched";
//   * if the server goes quiet for CLOUD_WATCHDOG_MS during motion or a profile,
//     the rail stops and stays stopped until a fresh command arrives;
//   * every command is range-checked again, and travel/speed limits above apply.
#define RAIL_MODE_CLOUD 1

// Where to check in. CLOUD_HOST/PORT/TLS can be overridden in secrets.h
// (e.g. plain HTTP to your laptop for a bench test).
#ifndef CLOUD_HOST
#define CLOUD_HOST "ui-self-iota.vercel.app"
#endif
#ifndef CLOUD_PORT
#define CLOUD_PORT 443
#endif
#ifndef CLOUD_TLS
#define CLOUD_TLS 1            // 1 = HTTPS with certificate checking (production); 0 = plain HTTP (bench only)
#endif

#define CLOUD_WATCHDOG_MS        3000   // no good check-in this long while moving -> stop
#define CLOUD_REQUEST_TIMEOUT_MS 4000
#define CLOUD_CONNECT_TIMEOUT_MS 6000
#define CLOUD_MIN_POLL_MS         250
#define CLOUD_MAX_POLL_MS       60000

#define FW_VERSION "cloud-0.1"

// 1 = at boot, run the HTTP parser's built-in checks and print PASS/FAIL on the serial monitor.
#define RAIL_HTTP_SELFTEST 1
