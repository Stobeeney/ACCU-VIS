/**
 * Accu-Vis NPC/NPA Stepper Rail Controller (ESP8266 + A4988 + NEMA17)
 *
 * Wiring and hardware constants: see include/rail_config.h
 *
 * Modes (include/rail_config.h): STANDALONE_MODE (no network), RAIL_MODE_CLOUD (the hosted
 * website controls the rail through the server; see cloud_client.cpp), or neither (legacy
 * local access point + HTTPS API on 192.168.4.1). The comment below describes the legacy API.
 *
 * Position convention: RAIL_HOME_CM (40.0) is the parked position farthest
 * from the patient; the carriage moves IN as the reported distance goes
 * DOWN, matching dotState.railDistanceCm in the web app (ui/app.js). There
 * is no limit switch yet, so this is open-loop: call /calibrate once after
 * manually placing the carriage at the true 40cm mark, before trusting any
 * distance reading or absolute move.
 *
 * Served over HTTPS (self-signed cert, see include/ssl_cert.h) on port 443
 * so that browser pages loaded over HTTPS -- like the deployed Vercel web
 * app -- can call this device's API without being blocked by "mixed
 * content" rules. Connect to the AccuVis-Rail WiFi network first, then
 * visit https://192.168.4.1/ once to accept the one-time certificate
 * warning before the Vercel app's calls will work.
 *
 * Endpoints (all JSON, CORS-open, local network only):
 *   GET  /status              -> board + rail state
 *   POST /calibrate           -> mark the CURRENT physical position as 40.0cm home
 *   POST /home                -> move back to 40.0cm
 *   POST /move?distance_cm=N[&speed_cm_s=S] -> move to an absolute distance (4-40cm);
 *                                 speed is clamped to the ceiling and echoed back
 *   POST /jog?delta_cm=N[&speed_cm_s=S] -> move N cm closer (+) or farther (-) from current position
 *   POST /stop                -> stop immediately, hold position
 *   POST /test                -> jog 1cm out and back; use this first to confirm
 *                                 wiring/direction before anything else
 */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <AccelStepper.h>
#include "secrets.h"
#include "rail_config.h"
#include "rail_core.h"
#if !RAIL_MODE_CLOUD
#include <ESP8266mDNS.h>
#include <ESP8266WebServerSecure.h>
#include "ssl_cert.h"
#endif

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

#if !RAIL_MODE_CLOUD
BearSSL::ESP8266WebServerSecure server(443);
#endif
AccelStepper stepper(AccelStepper::DRIVER, STEP_PIN, DIR_PIN);

bool calibrated = false;

// ---------------------------------------------------------------------
// Position <-> distance conversion
// ---------------------------------------------------------------------

long cmToMicrosteps(float distanceCm) {
  distanceCm = constrain(distanceCm, (float)RAIL_MIN_CM, (float)RAIL_MAX_CM); // never past the rail ends
  float travelledCm = RAIL_HOME_CM - distanceCm; // 0 at home, grows as it nears the patient
  return (long)lroundf(travelledCm * MICROSTEPS_PER_CM);
}

float microstepsToCm(long microsteps) {
  return RAIL_HOME_CM - ((float)microsteps / MICROSTEPS_PER_CM);
}

// Apply a requested approach speed (cm/s), clamped to the hardware ceiling.
// Returns the speed actually applied. <=0 or missing -> the ceiling.
float applySpeedCmPerSec(float requestedCmPerSec) {
  float maxCmPerSec = STEPPER_MAX_SPEED / MICROSTEPS_PER_CM;
  float cmPerSec = (requestedCmPerSec > 0.0f) ? min(requestedCmPerSec, maxCmPerSec) : maxCmPerSec;
  stepper.setMaxSpeed(cmPerSec * MICROSTEPS_PER_CM);
  return cmPerSec;
}

#if !RAIL_MODE_CLOUD   // legacy local mode: access point + HTTPS API on 192.168.4.1

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
  json += "\"sta_connected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  json += "\"sta_ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"connected_devices\":" + String(WiFi.softAPgetStationNum()) + ",";
  json += "\"min_cm\":" + String(RAIL_MIN_CM, 2) + ",\"max_cm\":" + String(RAIL_MAX_CM, 2) + ",";
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
  applySpeedCmPerSec(0);
  stepper.moveTo(0);
  sendOk("\"target_cm\":" + String(RAIL_HOME_CM, 2));
}

void handleMove() {
  if (!calibrated) { sendError(409, "Not calibrated yet -- call /calibrate first"); return; }
  if (!server.hasArg("distance_cm")) { sendError(400, "distance_cm query parameter is required"); return; }
  float target = constrain(server.arg("distance_cm").toFloat(), RAIL_MIN_CM, RAIL_MAX_CM);
  float speed = applySpeedCmPerSec(server.hasArg("speed_cm_s") ? server.arg("speed_cm_s").toFloat() : 0);
  stepper.moveTo(cmToMicrosteps(target));
  sendOk("\"target_cm\":" + String(target, 2) + ",\"speed_cm_s\":" + String(speed, 2));
}

void handleJog() {
  if (!calibrated) { sendError(409, "Not calibrated yet -- call /calibrate first"); return; }
  if (!server.hasArg("delta_cm")) { sendError(400, "delta_cm query parameter is required"); return; }
  float delta = server.arg("delta_cm").toFloat();
  float current = microstepsToCm(stepper.targetPosition());
  float target = constrain(current - delta, RAIL_MIN_CM, RAIL_MAX_CM);
  float speed = applySpeedCmPerSec(server.hasArg("speed_cm_s") ? server.arg("speed_cm_s").toFloat() : 0);
  stepper.moveTo(cmToMicrosteps(target));
  sendOk("\"target_cm\":" + String(target, 2) + ",\"speed_cm_s\":" + String(speed, 2));
}

void handleStop() {
  stepper.stop(); // decelerates to a halt and holds there
  sendOk();
}

void handleTest() {
  // Small blocking back-and-forth so you can watch/listen to the motor
  // without needing calibration or the web app -- just confirms wiring.
  if (stepper.isRunning()) { sendError(409, "Rail is moving -- /stop first"); return; }
  long start = stepper.currentPosition();
  long testDelta = (long)lroundf(1.0 * MICROSTEPS_PER_CM); // 1cm out and back
  stepper.moveTo(start + testDelta);
  stepper.runToPosition();
  delay(250);
  stepper.moveTo(start);
  stepper.runToPosition();
  sendOk("\"message\":\"Moved 1cm out and back. Should be smooth and quiet in both directions -- if it just buzzes/vibrates without turning, swap the two wires of one motor coil pair.\"");
}

void handleRoot() {
  String html = R"HTML(<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accu-Vis Rail Control</title>
<style>
body{font-family:sans-serif;max-width:420px;margin:0 auto;padding:16px;background:#111;color:#eee}
h1{font-size:1.2em}
button{display:block;width:100%;padding:14px;margin:8px 0;font-size:1em;border:none;border-radius:8px;background:#2d6cdf;color:#fff}
button:active{background:#1d4fa8}
button.danger{background:#c0392b}
#status{background:#222;padding:12px;border-radius:8px;font-size:0.9em;white-space:pre-wrap;margin-bottom:12px}
input{width:80px;padding:8px;font-size:1em}
.row{display:flex;gap:8px;align-items:center}
.row button{flex:1}
</style></head>
<body>
<h1>Accu-Vis NPC/NPA Rail</h1>
<div id="status">loading...</div>
<button onclick="post('/test')">Test Motor (1cm out/back)</button>
<button onclick="post('/calibrate')">Calibrate: Mark Here as 40cm Home</button>
<button onclick="post('/home')">Go Home (40cm)</button>
<div class="row">
<button onclick="post('/jog?delta_cm=1')">Closer 1cm</button>
<button onclick="post('/jog?delta_cm=-1')">Farther 1cm</button>
</div>
<div class="row">
<input type="number" id="dist" placeholder="cm" value="20">
<button onclick="moveTo()">Move To</button>
</div>
<button class="danger" onclick="post('/stop')">STOP</button>
<script>
async function refresh(){
  try{
    const r=await fetch('/status');
    const j=await r.json();
    document.getElementById('status').textContent=JSON.stringify(j,null,1);
  }catch(e){document.getElementById('status').textContent='(status unavailable)';}
}
async function post(path){
  try{
    const r=await fetch(path,{method:'POST'});
    await r.json();
  }catch(e){}
  refresh();
}
function moveTo(){
  const v=document.getElementById('dist').value;
  post('/move?distance_cm='+encodeURIComponent(v));
}
refresh();
setInterval(refresh,2000);
</script>
</body></html>)HTML";
  server.send(200, "text/html", html);
}

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) {
    // CORS preflight. Chrome also asks permission for a public site (the
    // hosted web app) to reach a private IP (this board): Private Network Access.
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    server.sendHeader("Access-Control-Allow-Private-Network", "true");
    server.send(204);
    return;
  }
  sendError(404, "not found");
}

// ---------------------------------------------------------------------
// WiFi (Access Point mode -- the ESP8266 broadcasts its OWN network;
// phones/tablets connect directly to it, no router needed)
// ---------------------------------------------------------------------

void startAccessPoint() {
#ifdef STA_SSID
  // Router mode: join the clinic/home WiFi (so the laptop keeps internet and
  // the hosted web app can reach this board) AND keep our own AP as a fallback.
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.print("Joining WiFi '");
  Serial.print(STA_SSID);
  Serial.print("'");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Joined. Rail address on that network: https://");
    Serial.println(WiFi.localIP());
    if (MDNS.begin("accuvis-rail")) Serial.println("Also reachable as https://accuvis-rail.local");
  } else {
    Serial.println("Could not join that WiFi; fallback AP only.");
  }
#else
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
#endif
  digitalWrite(LED_BUILTIN, HIGH); // off (NodeMCU LED is active-low)
  Serial.println("Access Point started.");
  Serial.print("SSID: ");
  Serial.println(AP_SSID);
  Serial.print("Password: ");
  Serial.println(AP_PASSWORD);
  Serial.print("Or connect your phone to that WiFi, then open: https://");
  Serial.println(WiFi.softAPIP());
  Serial.println("(accept the one-time self-signed certificate warning)");
}

#endif  // !RAIL_MODE_CLOUD

// ---------------------------------------------------------------------
// Hybrid approach profile (shared by standalone mode and the cloud relay)
// ---------------------------------------------------------------------
// Fast continuous sweep from home to fastEnd, then small slow steps with a dwell at
// each stop (the phone tracks the eye while the carriage stands still), then back
// home. Non-blocking: profileTick() runs from loop().

enum ProfileState : uint8_t { PS_IDLE, PS_FAST, PS_STEP, PS_DWELL, PS_RETURN };

static Profile prof;
static ProfileState profState = PS_IDLE;
static unsigned long profSince = 0;
static float profCm = RAIL_HOME_CM;
static bool profDone = false;
static char stopReasonBuf[28] = "";
static bool stopping = false;

const char *profileStateName() {
  switch (profState) {
    case PS_FAST:   return "FAST";
    case PS_STEP:   return "STEP";
    case PS_DWELL:  return "DWELL";
    case PS_RETURN: return "RETURN";
    default:        return "IDLE";
  }
}

bool profileActive() { return profState != PS_IDLE; }

bool profileFinished() {
  bool d = profDone;
  profDone = false;
  return d;
}

bool profileStart(const Profile &p) {
  // Last line of defence: the server and the website validate too. NaN fails every comparison.
  if (!(p.targetCm >= RAIL_MIN_CM && p.targetCm <= p.fastEndCm && p.fastEndCm <= RAIL_MAX_CM)) return false;
  if (!(p.stepCm >= 0.1f && p.stepCm <= 5.0f)) return false;
  if (!(p.fastCmS > 0.0f && p.slowCmS > 0.0f)) return false;
  if (p.dwellMs < 200 || p.dwellMs > 10000) return false;

  prof = p;
  profCm = p.fastEndCm;
  profDone = false;
  float speed = applySpeedCmPerSec(p.fastCmS);
  stepper.moveTo(cmToMicrosteps(p.fastEndCm));
  profState = PS_FAST;
  profSince = millis();
  Serial.printf("Profile: fast sweep to %.1f cm at %.2f cm/s, then %.1f cm steps to %.1f cm, %lu ms dwell\n",
                p.fastEndCm, speed, p.stepCm, p.targetCm, (unsigned long)p.dwellMs);
  return true;
}

void profileAbort() { profState = PS_IDLE; }

void railHardStop(const char *reason) {
  profileAbort();
  if (stopping && stepper.isRunning()) return;     // already decelerating: don't repeat
  stepper.stop();                                  // decelerates to a halt and holds there
  stopping = true;
  strncpy(stopReasonBuf, reason, sizeof(stopReasonBuf) - 1);
  stopReasonBuf[sizeof(stopReasonBuf) - 1] = '\0';
  Serial.printf("STOP: %s\n", reason);
}

const char *railStopReason() { return stopReasonBuf; }
void railClearStopReason() { stopReasonBuf[0] = '\0'; }

void profileTick() {
  if (stopping && !stepper.isRunning()) stopping = false;

  switch (profState) {
    case PS_IDLE:
      return;
    case PS_FAST:
    case PS_STEP:
      if (!stepper.isRunning()) {
        profState = PS_DWELL;
        profSince = millis();
      }
      break;
    case PS_DWELL:
      if (millis() - profSince >= prof.dwellMs) {
        if (profCm > prof.targetCm + 0.01f) {
          applySpeedCmPerSec(prof.slowCmS);
          profCm = max(profCm - prof.stepCm, prof.targetCm);
          stepper.moveTo(cmToMicrosteps(profCm));
          profState = PS_STEP;
          Serial.printf("Step to %.1f cm\n", profCm);
        } else {
          applySpeedCmPerSec(0);
          stepper.moveTo(0);
          profState = PS_RETURN;
          Serial.println("Target reached, returning home...");
        }
        profSince = millis();
      }
      break;
    case PS_RETURN:
      if (!stepper.isRunning()) {
        profState = PS_IDLE;
        profDone = true;
        Serial.println("Profile done.");
      }
      break;
  }
}

#if STANDALONE_MODE
// Standalone: no network at all. After a start delay, run one profile from the config.
static bool saStarted = false;
static unsigned long saBootMs = 0;

void standaloneTick() {
  if (!saStarted && millis() - saBootMs >= STANDALONE_START_DELAY_MS) {
    Profile p = {(float)STANDALONE_SLOW_ZONE_START_CM, (float)STANDALONE_TARGET_CM, (float)STANDALONE_SLOW_STEP_CM,
                 (float)STANDALONE_FAST_CM_S, (float)STANDALONE_SLOW_CM_S, (uint32_t)STANDALONE_DWELL_MS};
    if (!profileStart(p)) Serial.println("Standalone profile rejected: check the values in rail_config.h");
    saStarted = true;
  }
}

const char *standaloneTag() { return profileActive() ? profileStateName() : (saStarted ? "DONE" : "WAIT"); }
#endif

// ---------------------------------------------------------------------
// Serial telemetry: one line every SERIAL_TELEMETRY_MS while moving, plus a
// line when the carriage stops. Skipped if the TX buffer lacks room so it
// can never block (a blocked loop() would stall the stepper).
// ---------------------------------------------------------------------

#if SERIAL_TELEMETRY_MS > 0
void printTelemetry(const char *tag) {
  char line[120];
  long pos = stepper.currentPosition();
  long tgt = stepper.targetPosition();
  int n = snprintf(line, sizeof(line),
                   "[%7.1fs] %-7s pos=%6.2fcm (%ld st)  tgt=%6.2fcm  v=%+5.0f st/s (%4.2f cm/s)  %s\n",
                   millis() / 1000.0, tag,
                   microstepsToCm(pos), pos, microstepsToCm(tgt),
                   stepper.speed(), fabsf(stepper.speed()) / MICROSTEPS_PER_CM,
                   tgt > pos ? "IN " : (tgt < pos ? "OUT" : "---"));
  if (n > 0 && Serial.availableForWrite() >= n) Serial.write((const uint8_t *)line, n);
}

void telemetryTick(const char *tag) {
  static unsigned long lastMs = 0;
  static unsigned long lastIdleMs = 0;
  static bool wasMoving = false;
  bool moving = stepper.isRunning();
  unsigned long now = millis();
  if (moving && now - lastMs >= SERIAL_TELEMETRY_MS) {
    lastMs = now;
    printTelemetry(tag);
  } else if (!moving && wasMoving) {
    printTelemetry("STOPPED");
    lastIdleMs = now;
  } else if (!moving && now - lastIdleMs >= 2000) {
    // Idle heartbeat: a monitor attached late still sees the current state.
    lastIdleMs = now;
    printTelemetry(tag);
  }
  wasMoving = moving;
}
#else
void telemetryTick(const char *) {}
#endif

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
  stepper.setPinsInverted(DIR_INVERT, false, true); // ENABLE is active-LOW
  stepper.enableOutputs();
  stepper.setMaxSpeed(STEPPER_MAX_SPEED);
  stepper.setAcceleration(STEPPER_ACCEL);

#if STANDALONE_MODE
  // Treat the power-up position as the 40cm home; no WiFi / server at all.
  stepper.setCurrentPosition(0);
  calibrated = true;
  saBootMs = millis();
  Serial.print("STANDALONE mode: assuming carriage is at ");
  Serial.print(RAIL_HOME_CM, 1);
  Serial.println("cm home. Starting in 5 seconds...");
#elif RAIL_MODE_CLOUD
  cloudBegin();
#else
  startAccessPoint();

  server.getServer().setRSACert(new BearSSL::X509List(SSL_CERT), new BearSSL::PrivateKey(SSL_KEY));
  // Smaller TLS buffers to conserve the ESP8266's limited RAM -- our
  // requests/responses are tiny JSON (or the one small HTML page), so we
  // don't need BearSSL's default ~16KB record buffers in each direction.
  server.getServer().setBufferSizes(2048, 2048);

  server.on("/", HTTP_GET, handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/calibrate", HTTP_POST, handleCalibrate);
  server.on("/home", HTTP_POST, handleHome);
  server.on("/move", HTTP_POST, handleMove);
  server.on("/jog", HTTP_POST, handleJog);
  server.on("/stop", HTTP_POST, handleStop);
  server.on("/test", HTTP_POST, handleTest);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTPS server started on port 443.");
  Serial.println("Not calibrated yet -- POST /calibrate once the carriage is at its physical 40cm home mark.");
#endif
}

void loop() {
#if STANDALONE_MODE
  standaloneTick();
#elif RAIL_MODE_CLOUD
  cloudTick();
#else
  server.handleClient();
#ifdef STA_SSID
  MDNS.update();
#endif
#endif
  profileTick();
  stepper.run(); // must be called as often as possible for smooth, non-blocking motion
#if STANDALONE_MODE
  telemetryTick(standaloneTag());
#else
  telemetryTick(profileActive() ? profileStateName() : "MOVE");
#endif
}
