// Cloud relay client: lets the hosted website control the rail without reaching it directly.
//
// The rail joins the router WiFi and checks in with POST /api/rail/sync. Each check-in reports
// state and acknowledgements, and returns pending commands plus the flags that matter for safety
// (armed, stop_latched) and how soon to check in again (poll_ms, chosen by the server).
//
// Nothing here may ever stall the stepper, so the request/response exchange is a state machine
// driven from loop(): it reads at most a few hundred bytes per call. The only blocking steps are
// the WiFi/NTP wait at boot and (re)connecting the TLS socket; a reconnect while moving first
// stops the rail (see startRequest).
//
// Safety rules enforced here, in addition to the server's:
//   - motion commands are refused unless the server says "armed" and not "stop_latched"
//   - the rail stops if "disarmed" or "stop latched" arrives while it is moving
//   - the rail stops if no good check-in arrived for CLOUD_WATCHDOG_MS while moving / in a profile
//   - after any of those stops it stays stopped until a fresh command arrives
//   - every numeric parameter is range-checked again, and the travel/speed limits apply
#include <Arduino.h>
#include "secrets.h"
#include "rail_config.h"
#include "rail_core.h"

#if RAIL_MODE_CLOUD

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <time.h>
#include "rail_http.h"
#if CLOUD_TLS
#include "cloud_ca.h"
#endif

#if !defined(STA_SSID) || !defined(STA_PASSWORD) || !defined(RAIL_ID) || !defined(RAIL_SECRET)
#error "Cloud mode needs STA_SSID, STA_PASSWORD, RAIL_ID and RAIL_SECRET in include/secrets.h (see secrets.h.example)"
#endif

namespace {

#if CLOUD_TLS
BearSSL::WiFiClientSecure client;
BearSSL::X509List trustAnchors(CLOUD_CA_PEM);
const unsigned long CLOCK_VALID_AFTER = 1700000000UL;   // any real date after Nov 2023
#else
WiFiClient client;
#endif

enum NetState : uint8_t { NS_IDLE, NS_WAITING };

NetState ns = NS_IDLE;
HttpResponse resp;
bool disabled = false;            // placeholder secrets: refuse to run
unsigned long nextPollAt = 0;
unsigned long reqStartedAt = 0;
unsigned long lastOkSync = 0;
unsigned long failBackoffMs = 1000;
uint32_t pollMs = 2000;

bool armed = false;
bool stopLatched = false;
uint32_t lastSeq = 0;

struct Ack {
  uint32_t seq;
  char result[28];
};
Ack acks[4];
uint8_t nAcks = 0;

uint32_t okCount = 0;
uint32_t failCount = 0;

void logLine(const char *msg) {
  Serial.print("[cloud] ");
  Serial.println(msg);
}

void queueAck(uint32_t seq, const char *result) {
  if (nAcks == 4) {                      // keep the newest
    for (uint8_t i = 1; i < 4; i++) acks[i - 1] = acks[i];
    nAcks = 3;
  }
  acks[nAcks].seq = seq;
  strncpy(acks[nAcks].result, result, sizeof(acks[nAcks].result) - 1);
  acks[nAcks].result[sizeof(acks[nAcks].result) - 1] = '\0';
  nAcks++;
  Serial.printf("[cloud] cmd %lu -> %s\n", (unsigned long)seq, result);
}

bool busy() { return stepper.isRunning() || profileActive(); }

// ---- safety -------------------------------------------------------------------------------

void applyFlags() {
  if (!busy()) return;
  if (stopLatched) railHardStop("stop latched");
  else if (!armed) railHardStop("disarmed");
}

void safetyTick(unsigned long now) {
  if (busy() && (now - lastOkSync) > CLOUD_WATCHDOG_MS) railHardStop("link lost");
}

// ---- commands -----------------------------------------------------------------------------

void execCommand(uint32_t seq, const char *type, JsonObjectConst p) {
  if (seq == 0 || seq <= lastSeq) return;      // already handled (or malformed)
  lastSeq = seq;

  if (strcmp(type, "stop") == 0) {
    railHardStop("operator stop");
    queueAck(seq, "stopped");
    return;
  }
  if (strcmp(type, "calibrate") == 0) {
    if (busy()) { queueAck(seq, "rejected:moving"); return; }
    stepper.setCurrentPosition(0);
    calibrated = true;
    railClearStopReason();
    queueAck(seq, "ok");
    return;
  }

  // everything below moves the carriage
  if (!armed)       { queueAck(seq, "rejected:not armed"); return; }
  if (stopLatched)  { queueAck(seq, "rejected:stop latched"); return; }
  if (!calibrated)  { queueAck(seq, "rejected:not calibrated"); return; }

  if (strcmp(type, "home") == 0) {
    profileAbort();
    applySpeedCmPerSec(0);
    stepper.moveTo(0);
    railClearStopReason();
    queueAck(seq, "ok");
  } else if (strcmp(type, "move") == 0) {
    float d = p["distance_cm"] | NAN;
    if (isnan(d) || d < RAIL_MIN_CM || d > RAIL_MAX_CM) { queueAck(seq, "rejected:range"); return; }
    profileAbort();
    applySpeedCmPerSec(p["speed_cm_s"] | 0.0f);
    stepper.moveTo(cmToMicrosteps(d));
    railClearStopReason();
    queueAck(seq, "ok");
  } else if (strcmp(type, "jog") == 0) {
    float delta = p["delta_cm"] | NAN;               // positive = closer to the patient
    if (isnan(delta) || fabsf(delta) > 5.0f) { queueAck(seq, "rejected:range"); return; }
    float target = constrain(microstepsToCm(stepper.targetPosition()) - delta, (float)RAIL_MIN_CM, (float)RAIL_MAX_CM);
    profileAbort();
    applySpeedCmPerSec(p["speed_cm_s"] | 0.0f);
    stepper.moveTo(cmToMicrosteps(target));
    railClearStopReason();
    queueAck(seq, "ok");
  } else if (strcmp(type, "start_profile") == 0) {
    Profile pr;
    pr.fastEndCm = p["fast_end_cm"] | 30.0f;
    pr.targetCm = p["target_cm"] | 20.0f;
    pr.stepCm = p["step_cm"] | 0.5f;
    pr.fastCmS = p["fast_cm_s"] | 0.75f;
    pr.slowCmS = p["slow_cm_s"] | 0.5f;
    pr.dwellMs = p["dwell_ms"] | 2000;
    if (!profileStart(pr)) { queueAck(seq, "rejected:profile"); return; }
    railClearStopReason();
    queueAck(seq, "ok");
  } else {
    queueAck(seq, "rejected:unknown");
  }
}

// ---- networking ---------------------------------------------------------------------------

void fail(unsigned long now, const char *why) {
  failCount++;
  Serial.printf("[cloud] sync failed: %s (retry in %lu ms)\n", why, failBackoffMs);
  client.stop();
  ns = NS_IDLE;
  nextPollAt = now + failBackoffMs;
  failBackoffMs = min(failBackoffMs * 2, 15000UL);
}

bool clockOk() {
#if CLOUD_TLS
  return time(nullptr) > CLOCK_VALID_AFTER;
#else
  return true;
#endif
}

bool connectServer() {
  client.stop();
#if CLOUD_TLS
  if (!clockOk()) { logLine("waiting for the clock (NTP) before connecting"); return false; }
  client.setTrustAnchors(&trustAnchors);
  client.setX509Time(time(nullptr));
#endif
  client.setTimeout(CLOUD_CONNECT_TIMEOUT_MS);
  if (!client.connect(CLOUD_HOST, CLOUD_PORT)) {
#if CLOUD_TLS
    char err[96];
    client.getLastSSLError(err, sizeof(err));
    Serial.printf("[cloud] connect failed: %s\n", err[0] ? err : "no TLS error (network?)");
#else
    logLine("connect failed");
#endif
    return false;
  }
  client.setNoDelay(true);
  Serial.printf("[cloud] connected (free heap %u bytes)\n", (unsigned)ESP.getFreeHeap());
  return true;
}

size_t buildRequest(char *out, size_t cap) {
  StaticJsonDocument<640> d;
  JsonObject s = d.createNestedObject("state");
  float cm = microstepsToCm(stepper.currentPosition());
  s["distance_cm"] = lroundf(cm * 100.0f) / 100.0f;
  s["moving"] = stepper.isRunning();
  s["calibrated"] = calibrated;
  s["mode"] = profileActive() ? "profile" : (stepper.isRunning() ? "move" : "idle");
  s["profile_state"] = profileStateName();
  s["fw"] = FW_VERSION;
  s["rssi"] = WiFi.RSSI();
  s["uptime_ms"] = millis();
  s["limit_min_cm"] = (float)RAIL_MIN_CM;
  s["limit_max_cm"] = (float)RAIL_MAX_CM;
  if (railStopReason()[0]) s["stop_reason"] = railStopReason();
  JsonArray a = d.createNestedArray("acks");
  for (uint8_t i = 0; i < nAcks; i++) {
    JsonObject o = a.createNestedObject();
    o["seq"] = acks[i].seq;
    o["result"] = acks[i].result;
  }

  char body[560];
  size_t blen = serializeJson(d, body, sizeof(body));
  int n = snprintf(out, cap,
                   "POST /api/rail/sync HTTP/1.1\r\n"
                   "Host: %s\r\n"
                   "X-Rail-Id: %s\r\n"
                   "X-Rail-Secret: %s\r\n"
                   "Content-Type: application/json\r\n"
                   "Content-Length: %u\r\n"
                   "Connection: keep-alive\r\n\r\n%s",
                   CLOUD_HOST, RAIL_ID, RAIL_SECRET, (unsigned)blen, body);
  return (n > 0 && (size_t)n < cap) ? (size_t)n : 0;
}

void startRequest(unsigned long now) {
  if (!client.connected()) {
#if CLOUD_TLS
    // A TLS handshake takes seconds on this chip and would freeze the stepper mid-move, so a
    // dropped connection during motion is treated as a lost link: stop first, then reconnect.
    if (busy()) railHardStop("reconnecting");
#endif
    if (!connectServer()) { fail(now, "could not connect"); return; }
  }
  static char req[1100];
  size_t n = buildRequest(req, sizeof(req));
  if (n == 0) { fail(now, "request too large"); return; }
  if (client.write((const uint8_t *)req, n) != n) { fail(now, "write failed"); return; }
  resp.reset();
  reqStartedAt = now;
  ns = NS_WAITING;
}

void onResponse(unsigned long now) {
  if (resp.status == 401) { fail(now, "unauthorized: check RAIL_ID / RAIL_SECRET"); return; }
  if (resp.status != 200) {
    char why[40];
    snprintf(why, sizeof(why), "HTTP %d", resp.status);
    fail(now, why);
    return;
  }

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, resp.body, resp.bodyLen);
  if (err || !(doc["ok"] | false)) { fail(now, "bad JSON from server"); return; }

  if (!resp.keepAlive) client.stop();

  bool newArmed = doc["armed"] | false;
  bool newLatched = doc["stop_latched"] | false;
  if (newArmed != armed) logLine(newArmed ? "ARMED" : "disarmed");
  if (newLatched != stopLatched) logLine(newLatched ? "STOP LATCHED" : "stop cleared");
  armed = newArmed;
  stopLatched = newLatched;
  pollMs = constrain((uint32_t)(doc["poll_ms"] | 2000), (uint32_t)CLOUD_MIN_POLL_MS, (uint32_t)CLOUD_MAX_POLL_MS);

  nAcks = 0;                       // the server has everything we reported
  lastOkSync = now;
  okCount++;
  failBackoffMs = 1000;
  ns = NS_IDLE;
  nextPollAt = now + pollMs;

  applyFlags();                    // disarm / latch take effect before any new command runs

  JsonArrayConst cmds = doc["commands"];
  for (JsonObjectConst c : cmds) {
    execCommand(c["seq"] | 0, c["type"] | "", c["params"]);
  }
}

void readResponse(unsigned long now) {
  int budget = 256;                // never hog loop(): the stepper needs it
  while (budget-- > 0 && client.available()) {
    int c = client.read();
    if (c < 0) break;
    resp.feed((char)c);
    if (resp.done() || resp.failed()) break;
  }
  if (resp.done()) { onResponse(now); return; }
  if (resp.failed()) { fail(now, "malformed HTTP response"); return; }
  if (!client.connected() && !client.available()) {
    resp.onClose();
    if (resp.done()) { onResponse(now); return; }
    fail(now, "connection closed early");
    return;
  }
  if (now - reqStartedAt > CLOUD_REQUEST_TIMEOUT_MS) fail(now, "timeout waiting for the server");
}

void selfTestReport(const char *line) { Serial.println(line); }

}  // namespace

void cloudBegin() {
  Serial.println("Cloud relay mode.");

#if RAIL_HTTP_SELFTEST
  Serial.println("HTTP parser self-test:");
  int failures = httpParserSelfTest(selfTestReport);
  Serial.println(failures == 0 ? "  parser OK" : "  PARSER FAILED -- do not use the cloud mode");
#endif

  if (strcmp(STA_SSID, "YourRouterName") == 0 || strcmp(RAIL_SECRET, "paste-the-secret-here") == 0) {
    Serial.println("secrets.h still has placeholder values (STA_SSID / RAIL_SECRET). Cloud mode is OFF.");
    disabled = true;
    return;
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.printf("Joining WiFi '%s'", STA_SSID);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi OK, IP ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not joined yet; will keep trying in the background.");
  }

#if CLOUD_TLS
  configTime(0, 0, "pool.ntp.org", "time.google.com");     // needed to check the certificate dates
  t0 = millis();
  while (!clockOk() && millis() - t0 < 15000) {
    delay(250);
    Serial.print("~");
  }
  Serial.println(clockOk() ? "\nClock synced." : "\nClock not synced yet; HTTPS waits for it.");
#endif

  Serial.printf("Server: %s://%s:%d  rail id: %s\n", CLOUD_TLS ? "https" : "http", CLOUD_HOST, CLOUD_PORT, RAIL_ID);
  Serial.println("Not calibrated: place the carriage at the 40cm mark, arm it on the website, then calibrate.");
  nextPollAt = millis() + 500;
}

void cloudTick() {
  if (disabled) return;
  unsigned long now = millis();

  safetyTick(now);

  // status LED (active-low): lit while the last check-in is recent
  bool linkOk = lastOkSync != 0 && (now - lastOkSync) < (pollMs * 3 + 5000);
  digitalWrite(LED_BUILTIN, linkOk ? LOW : HIGH);

  if (WiFi.status() != WL_CONNECTED) return;

  if (ns == NS_WAITING) { readResponse(now); return; }
  if ((long)(now - nextPollAt) >= 0) startRequest(now);
}

#else  // !RAIL_MODE_CLOUD

void cloudBegin() {}
void cloudTick() {}

#endif
