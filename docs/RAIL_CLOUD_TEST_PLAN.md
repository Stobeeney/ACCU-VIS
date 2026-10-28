# Rail cloud relay: staged test plan

The hosted website controls the rail through the server. The rail joins the router WiFi and checks in
with `POST /api/rail/sync`; the website posts commands to `/api/rail/command`.

```
Website ──► /api/rail/command ──► server ◄── /api/rail/sync ◄── Rail (ESP8266, router WiFi)
```

## Verdict (2026-10-28)

**OK for supervised bench tests with nobody near the rail. NOT OK for patient testing.**

Verified by automated tests (no hardware involved):
- Server logic: 19 unit tests (arming, latched STOP, expiry, validation, auth), mutation-checked.
- Both server entry points (Flask on Vercel, `server.py` locally): 30 HTTP checks.
- Website client against the real server and a simulated rail: 27 checks.
- The real `app.js` driven through the rail panel (arm, calibrate, approach, stop and lock, clear stop,
  disarm, bad token, switching links): 27 checks, repeated 3 times.
- Firmware compiles in all four modes (cloud+TLS, standalone, legacy local, cloud plain-HTTP bench).
- TLS trust anchor proven: GTS Root R1 signs the intermediate Vercel uses; a TLS 1.2 connection to the
  site validates with only that root, and fails for a wrong hostname.

**Not verified: anything on the real board.** In particular: the HTTP parser's on-board self-test, the
WiFi/NTP/TLS connection from the ESP8266 (free memory is the risk), motion driven by commands, and the
watchdog behaviour. That is what the stages below are for.

Still missing hardware safety (see `CHECKLIST.md` section 1): limit switch + homing, hard end-stop at the
patient end, physical e-stop. Until they exist, **no person near the rail** and a hand on the 12 V switch.

## Before every test
- 12 V switch within reach. Carriage parked at the 40 cm mark with at least 25 cm of free rail ahead.
- No phone, no patient. Firmware travel limit is `RAIL_USABLE_TRAVEL_CM` (currently 20 -> carriage cannot
  be commanded below 20 cm).
- After every reset the rail is **not calibrated** and **not armed**. That is by design.

## Stage 0: register the rail (local database)
```
cd ui
python database/provision_rail.py rail-1 "Bench rail"
```
Copy the printed `RAIL_ID` / `RAIL_SECRET` into `firmware/esp8266-stepper/include/secrets.h`
(gitignored), together with `STA_SSID` / `STA_PASSWORD` (2.4 GHz WiFi).

## Stage 1: firmware only, motor supply OFF, plain HTTP to your laptop
`secrets.h`:
```
#define CLOUD_HOST "192.168.1.50"   // your laptop's IP on the same WiFi
#define CLOUD_PORT 8080
#define CLOUD_TLS  0
```
Run `python server.py`, flash (`pio run -t upload`), open `pio device monitor`.

Expect on the serial monitor:
- `HTTP parser self-test:` followed by PASS lines and `parser OK`. **Any FAIL: stop here and tell me.**
- `WiFi OK, IP ...` then `Server: http://...`.
- Idle check-ins every 20 s (the server sets the pace).

In the app (http://localhost:8080): Dot Measure -> tick "Use Real Hardware" -> Rail ID `rail-1` -> **Arm rail**.
- Serial: `[cloud] ARMED` within ~20 s, then check-ins every second.
- **Calibrate Rail** -> `[cloud] cmd N -> ok`.
- **Start Stepper Approach** -> `Profile: fast sweep ...` and `Step to ...` lines (the motor is unpowered,
  so only the readout moves).
- **Stop & Lock** -> `STOP: operator stop`; the page shows "STOP latched"; **Clear Stop** clears it.
- Stop `server.py` during a profile -> `STOP: link lost` within about 3 s.

## Stage 2: motor supply ON, plain HTTP, nobody near
Same flow as stage 1, now with motion. Check with a ruler that 5 cm / 10 cm commanded is 5 cm / 10 cm real.
Safety checks while the carriage is moving (each must stop it; record the time to stop):
1. Press **Stop & Lock**.
2. Press **Disarm**.
3. Stop `server.py`.
4. Turn the router / hotspot off.
5. Reset the board (it must come back stopped, uncalibrated, disarmed).

## Stage 3: hosted site over TLS
Needs the code deployed and the rail registered in the **production** database
(`vercel env pull`, load `POSTGRES_URL`, then run `provision_rail.py`). Remove the bench overrides from
`secrets.h`. Watch the serial monitor for:
- `Clock synced.` then `[cloud] connected (free heap NNNNN bytes)`. If free heap is below about 8000,
  tell me (the TLS buffers are tight on this chip).
- Check-ins succeed without reconnecting every time. If `STOP: reconnecting` appears while moving, the
  server is not keeping connections alive and TLS mode cannot be used during motion.
- Measure round-trip time (command to acknowledgement) and note it.

## Pass criteria
- Parser self-test all PASS; no crash or reboot loop in 30 minutes of idle and armed check-ins.
- Every stop test in stage 2 halts the carriage within 1 s (watchdog cases within 3.5 s).
- Reset leaves the rail stopped, uncalibrated and disarmed.
- Distances match the ruler within 1 mm per 10 cm.
