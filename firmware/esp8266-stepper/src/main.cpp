/**
 * Accu-Vis NPC/NPA Stepper Rail Controller (ESP8266 + A4988 + NEMA17)
 *
 * Wiring and hardware constants: see include/rail_config.h
 *
 * Position convention: RAIL_HOME_CM (40.0) is the parked position farthest
 * from the patient; the carriage moves IN as the reported distance goes
 * DOWN, matching dotState.railDistanceCm in the web app (ui/app.js). There
 * is no limit switch yet, so this is open-loop: call /calibrate once after
 * manually placing the carriage at the true 40cm mark, before trusting any
 * distance reading or absolute move.
 *
 * Endpoints (all JSON, CORS-open, local network only):
 *   GET  /status              -> board + rail state
 *   POST /calibrate           -> mark the CURRENT physical position as 40.0cm home
 *   POST /home                -> move back to 40.0cm
 *   POST /move?distance_cm=N  -> move to an absolute distance (4-40cm)
 *   POST /jog?delta_cm=N      -> move N cm closer (+) or farther (-) from current position
 *   POST /stop                -> stop immediately, hold position
 *   POST /test                -> jog 1cm out and back; use this first to confirm
 *                                 wiring/direction before anything else
 */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <AccelStepper.h>
#include "secrets.h"
#include "rail_config.h"

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

ESP8266WebServer server(80);
AccelStepper stepper(AccelStepper::DRIVER, STEP_PIN, DIR_PIN);

bool calibrated = false;

// ---------------------------------------------------------------------
// Position <-> distance conversion
// ---------------------------------------------------------------------

long cmToMicrosteps(float distanceCm) {
  float travelledCm = RAIL_HOME_CM - distanceCm; // 0 at home, grows as it nears the patient
  return (long)lroundf(travelledCm * MICROSTEPS_PER_CM);
}

float microstepsToCm(long microsteps) {
  return RAIL_HOME_CM - ((float)microsteps / MICROSTEPS_PER_CM);
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

void sendJson(int code, const String &body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(code, "application/json", body);
}

void sendOk(const String &extraFields = "") {
  sendJson(200, "{\"ok\":true" + (extraFields.length() ? "," + extraFields : "") + "}");
}

void sendError(int code, const String &message) {
  sendJson(code, "{\"ok\":false,\"error\":\"" + message + "\"}");
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

void handleStatus() {
  float distanceCm = microstepsToCm(stepper.currentPosition());
  String json = "{";
  json += "\"ok\":true,";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"connected_devices\":" + String(WiFi.softAPgetStationNum()) + ",";
  json += "\"calibrated\":" + String(calibrated ? "true" : "false") + ",";
  json += "\"distance_cm\":" + String(distanceCm, 2) + ",";
  json += "\"moving\":" + String(stepper.isRunning() ? "true" : "false");
  json += "}";
  sendJson(200, json);
}

void handleCalibrate() {
  stepper.setCurrentPosition(0);
  calibrated = true;
  sendOk("\"message\":\"Current position marked as " + String(RAIL_HOME_CM, 1) + "cm home\"");
}

void handleHome() {
  if (!calibrated) { sendError(409, "Not calibrated yet -- call /calibrate first"); return; }
  stepper.moveTo(0);
  sendOk("\"target_cm\":" + String(RAIL_HOME_CM, 2));
}

void handleMove() {
  if (!calibrated) { sendError(409, "Not calibrated yet -- call /calibrate first"); return; }
  if (!server.hasArg("distance_cm")) { sendError(400, "distance_cm query parameter is required"); return; }
  float target = constrain(server.arg("distance_cm").toFloat(), RAIL_MIN_CM, RAIL_MAX_CM);
  stepper.moveTo(cmToMicrosteps(target));
  sendOk("\"target_cm\":" + String(target, 2));
}

void handleJog() {
  if (!calibrated) { sendError(409, "Not calibrated yet -- call /calibrate first"); return; }
  if (!server.hasArg("delta_cm")) { sendError(400, "delta_cm query parameter is required"); return; }
  float delta = server.arg("delta_cm").toFloat();
  float current = microstepsToCm(stepper.targetPosition());
  float target = constrain(current - delta, RAIL_MIN_CM, RAIL_MAX_CM);
  stepper.moveTo(cmToMicrosteps(target));
  sendOk("\"target_cm\":" + String(target, 2));
}

void handleStop() {
  stepper.moveTo(stepper.currentPosition());
  stepper.setSpeed(0);
  sendOk();
}

void handleTest() {
  // Small blocking back-and-forth so you can watch/listen to the motor
  // without needing calibration or the web app -- just confirms wiring.
  long start = stepper.currentPosition();
  long testDelta = (long)lroundf(1.0 * MICROSTEPS_PER_CM); // 1cm out and back
  stepper.moveTo(start + testDelta);
  stepper.runToPosition();
  delay(250);
  stepper.moveTo(start);
  stepper.runToPosition();
  sendOk("\"message\":\"Moved 1cm out and back. Should be smooth and quiet in both directions -- if it just buzzes/vibrates without turning, swap the two wires of one motor coil pair.\"");
}

void handleNotFound() {
  sendError(404, "not found");
}

// ---------------------------------------------------------------------
// WiFi (Access Point mode -- the ESP8266 broadcasts its OWN network;
// phones/tablets connect directly to it, no router needed)
// ---------------------------------------------------------------------

void startAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  digitalWrite(LED_BUILTIN, HIGH); // off (NodeMCU LED is active-low)
  Serial.println("Access Point started.");
  Serial.print("SSID: ");
  Serial.println(AP_SSID);
  Serial.print("Password: ");
  Serial.println(AP_PASSWORD);
  Serial.print("Connect your phone to that WiFi, then open: http://");
  Serial.println(WiFi.softAPIP());
}

// ---------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // off

  Serial.begin(115200);
  delay(200);
  Serial.println("\nAccu-Vis Stepper Rail Controller booting...");

  // Microstep select: MS1=MS2=MS3=HIGH -> 1/16 microstepping
  pinMode(MS1_PIN, OUTPUT);
  pinMode(MS2_PIN, OUTPUT);
  pinMode(MS3_PIN, OUTPUT);
  digitalWrite(MS1_PIN, HIGH);
  digitalWrite(MS2_PIN, HIGH);
  digitalWrite(MS3_PIN, HIGH);

  stepper.setEnablePin(ENABLE_PIN);
  stepper.setPinsInverted(false, false, true); // ENABLE is active-LOW
  stepper.enableOutputs();
  stepper.setMaxSpeed(STEPPER_MAX_SPEED);
  stepper.setAcceleration(STEPPER_ACCEL);

  // TEMPORARY boot-time wiring test: moves 1cm out and back on every power-up,
  // before WiFi, so the motor can be verified without configuring WiFi first.
  // Remove this block once the rail is confirmed working (use POST /test
  // over HTTP after that instead).
  Serial.println("Boot self-test: moving stepper 1cm out and back...");
  Serial.println("Watch/listen now -- should be smooth and quiet both ways.");
  Serial.println("If it just buzzes/vibrates without turning, power off and");
  Serial.println("swap the two wires of ONE motor coil pair, then try again.");
  delay(1500);
  {
    long testDelta = (long)lroundf(1.0 * MICROSTEPS_PER_CM);
    stepper.moveTo(testDelta);
    stepper.runToPosition();
    delay(250);
    stepper.moveTo(0);
    stepper.runToPosition();
  }
  Serial.println("Boot self-test done.");

  startAccessPoint();

  server.on("/status", HTTP_GET, handleStatus);
  server.on("/calibrate", HTTP_POST, handleCalibrate);
  server.on("/home", HTTP_POST, handleHome);
  server.on("/move", HTTP_POST, handleMove);
  server.on("/jog", HTTP_POST, handleJog);
  server.on("/stop", HTTP_POST, handleStop);
  server.on("/test", HTTP_POST, handleTest);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started on port 80.");
  Serial.println("Not calibrated yet -- POST /calibrate once the carriage is at its physical 40cm home mark.");
}

void loop() {
  server.handleClient();
  stepper.run(); // must be called as often as possible for smooth, non-blocking motion
}
