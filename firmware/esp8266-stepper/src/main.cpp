/**
 * Accu-Vis NPC/NPA Stepper Rail Controller (ESP8266)
 *
 * PHASE 1 of this firmware: connectivity only. It joins your WiFi and
 * exposes a tiny HTTP API so we can confirm the board, WiFi credentials,
 * and network setup all work end-to-end -- before wiring up the actual
 * stepper driver. This matches the "local network only" design used by
 * the web app's camera relay: the ESP8266 is reached directly by IP from
 * whatever device is running the Accu-Vis controller, on the same WiFi.
 *
 * Endpoints (JSON over plain HTTP, port 80):
 *   GET  /status   -> { "ok": true, "uptime_ms": <n>, "ip": "..." }
 *
 * Once you tell me the exact driver board (A4988 / DRV8825 / ULN2003 / etc.),
 * GPIO wiring, motor steps/rev + microstepping, and the lead screw pitch
 * (mm per revolution), Phase 2 adds real motion: AccelStepper-driven
 * /move, /home, and /stop endpoints matching the web app's rail protocol
 * (0-40cm, matching dotState.railDistanceCm in ui/app.js).
 */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include "secrets.h"

ESP8266WebServer server(80);

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void handleStatus() {
  String json = "{";
  json += "\"ok\":true,";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"rssi_dbm\":" + String(WiFi.RSSI());
  json += "}";
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(404, "application/json", "{\"ok\":false,\"error\":\"not found\"}");
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.hostname(DEVICE_HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  uint32_t startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); // blink while connecting
    delay(300);
    Serial.print(".");
    if (millis() - startAttempt > 20000) {
      Serial.println("\nWiFi connect timed out, retrying...");
      WiFi.disconnect();
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      startAttempt = millis();
    }
  }

  digitalWrite(LED_BUILTIN, HIGH); // off (NodeMCU LED is active-low)
  Serial.println("\nWiFi connected.");
  Serial.print("IP address: http://");
  Serial.println(WiFi.localIP());
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // off

  Serial.begin(115200);
  delay(200);
  Serial.println("\nAccu-Vis Stepper Rail Controller booting...");

  connectWiFi();

  server.on("/status", HTTP_GET, handleStatus);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started on port 80.");
}

void loop() {
  server.handleClient();

  // Reconnect automatically if WiFi drops (clinic WiFi can be flaky)
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting...");
    connectWiFi();
  }

  // TODO (Phase 2): stepper.run() here once the driver is wired up.
}
