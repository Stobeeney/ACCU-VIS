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
#define LEAD_SCREW_PITCH_MM 8.0

#define MICROSTEPS_PER_CM ((STEPS_PER_REV * MICROSTEPS) / (LEAD_SCREW_PITCH_MM / 10.0))

// Matches the web app's dotState.railDistanceCm convention: 40.0cm is the
// parked "home" position (farthest from the patient), the carriage moves
// IN as this number goes DOWN toward the ~4cm clinical break/limit.
#define RAIL_HOME_CM 40.0
#define RAIL_MIN_CM  4.0
#define RAIL_MAX_CM  40.0

#define STEPPER_MAX_SPEED 3000.0  // microsteps/sec
#define STEPPER_ACCEL     1500.0  // microsteps/sec^2
