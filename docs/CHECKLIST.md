# Accu-Vis: Build and Test Checklist

Living checklist for the NPC/NPA rail, the web app and the backend. Tick items as they are done and verified (not just written).
Owners follow the team roles: **Optimus** hardware/firmware, **Takumi** backend/security, **Bi** front end, **Shinra** tracking/CV, **Verity** QA, **Nexus** decisions.

Last reviewed: 2026-11-08. The calibrated 40–20 cm range is user-confirmed. Firmware is being configured to permit the website's 20, 4 and 2 cm endpoints; 4 cm and 2 cm physical travel remain unmeasured and unverified.

## 0. Design facts everything depends on

- The **camera is stationary** and tracks the eyes. The motor-driven carriage carries the fixation target. The rail UI offers 20, 4 and 2 cm endpoints; the selected endpoint sets the approach target, while firmware permits a software floor of 2 cm. Only 40–20 cm is user-confirmed; physical travel below 20 cm remains unverified. Rail distance must not be used to scale camera geometry.
- The website always runs a continuous sweep to the selected 20, 4 or 2 cm endpoint. Eye samples are binned using the latest rail telemetry and estimated position; continuous position accuracy still needs physical validation.
- NPC offers one run or an automatic three-run sequence to the selected endpoint. The carriage returns to the confirmed 40 cm home position between repeated runs. The operator reviews the three outcomes together; saving writes one clinical log per completed run. STOP or an unconfirmed home position ends the sequence without counting an incomplete run.
- Rail position is **open-loop** (no limit switch yet). 40 cm = parked home. `1 cm = 800 microsteps` (200 steps x 16 microsteps / 4 cm per rev, from the measured ~40 mm per revolution; earlier assumed 8 mm).
- Speed presets in the UI and firmware: 0.50, 0.75, 2.0 and 2.5 cm/s; firmware ceiling is `RAIL_MAX_SPEED_CM_S = 2.5` (about 2000 steps/s at the calibrated ratio). Speeds above 0.75 cm/s are not physically verified under the phone payload; bench-test before patient use.

## 1. SAFETY GATE: nothing touches a person until all of this is ticked

Owner: Optimus (with Verity sign-off)

- [ ] Hard mechanical end-stop at the patient end, preventing the **target carriage** from contacting the patient, with a measured safety margin
- [ ] Before operating at 4 cm or 2 cm, measure and mechanically limit the target carriage's full travel to that endpoint with a safe margin; the firmware limit is software-only
- [ ] Home limit switch wired (pin chosen, debounce, normally-closed so a broken wire reads as triggered)
- [ ] Homing routine on boot/connect replaces manual `/calibrate` (keep `/calibrate` as engineering override only)
- [ ] Physical e-stop that cuts motor power (VMOT), independent of the ESP8266
- [ ] Firmware watchdog: if no request from the app for ~2 s while moving, stop (browser crash / WiFi drop)
- [ ] Speed limit near the face (zone-based cap in firmware, not only in the app)
- [ ] Verify 0.50, 0.75, 2.0 and 2.5 cm/s against a timed ruler test under the mounted phone payload; keep speeds above 0.75 disabled for patient use until confirmed
- [ ] Defined offset between the carriage's distance datum, the red target point and the corneal reference plane
- [ ] Standalone mode only used with the carriage verified at 40 cm before power-up (add a label on the rail)
- [ ] Dry run with a dummy head / foam block, no person, before any volunteer

## 2. Hardware bring-up (power, then motion)

Owner: Optimus

- [ ] Power: motor supply is a separate supply matched to the NEMA17 (commonly 12 V); never from ESP 3V3/USB
- [ ] 100 uF (or larger) electrolytic across VMOT/GND at the A4988
- [ ] RESET and SLEEP jumpered on the A4988
- [ ] A4988 Vref set **before** connecting the motor (`Vref = rated_amps x 0.8` for 0.1 ohm sense resistors); record the value: ______
- [ ] Driver heatsink fitted; touch-test temperature after 10 min hold (idle disable not implemented yet)
- [ ] Wiring matches `include/rail_config.h` pin table (STEP D1, DIR D2, ENABLE D6, MS1 D5, MS2 D7, MS3 D0)
- [ ] `POST /test` (1 cm out and back): smooth, quiet, correct direction. If it buzzes, swap one coil pair
- [x] Drive ratio found from a bench run: real travel was exactly 5x the commanded distance, so about **40 mm per motor revolution** (looks like a GT2 belt, 20T pulley), not an 8 mm lead screw. `LEAD_SCREW_PITCH_MM` is now 40.0; speed/accel are defined in cm/s
- [x] Drive confirmed: belt with 20-tooth pulleys (motor and idler). 20 teeth x 2 mm (GT2 belt assumed, confirm the belt pitch is 2 mm) = 40 mm/rev
- [x] 5 cm bench test passed 2026-10-28 (belt constant 40 mm/rev; fast sweep, 0.5 cm steps, 2 s dwell, return to 40 cm all as commanded)
- [x] 10 cm bench test passed 2026-10-28 (8000 steps = 10.00 cm, returned to 0 steps)
- [ ] Repeat the ruler check at 20 cm: measured ______ mm/rev
- [ ] Belt checks: tension (no slack, no skipped teeth), pulley set screws tight, carriage cannot drift when the motor is idle/unpowered (belts back-drive; matters if the rail is not perfectly level)
- [ ] Distance accuracy: command 40 -> 30 -> 20 cm, measure the fixation point to the corneal reference with a ruler. Pass: within 1 mm per 10 cm. Record: ______
- [ ] Repeatability: 10 round trips 40 <-> 20 cm, home position drift under 0.5 mm
- [ ] Lost-step test: 20 round trips at the ceiling speed, then re-measure home. Any drift means lower the speed/accel or raise the current
- [ ] Carriage with fixation target fitted: check stiffness, secure mounting and cable strain relief
- [ ] Motor torque margin with the final target carriage load at max acceleration (no stalls)

## 3. Firmware (`firmware/esp8266-stepper`)

Owner: Optimus (Takumi for API auth)

Done:
- [x] Stepper control with acceleration, 1/16 microstepping, ENABLE active-low
- [x] WiFi AP + HTTPS API (`/status /calibrate /home /move /jog /stop /test`) and onboard control page
- [x] Boot-time self-test removed (no surprise motion on power-up)
- [x] `/stop` uses `stepper.stop()` (decelerates to a halt)
- [x] `/test` refused with 409 while the rail is moving
- [x] `/move` and `/jog` accept `speed_cm_s`, clamped to the ceiling, echoed back
- [x] Standalone hybrid sequence (5 s delay, fast sweep, slow steps with dwell, return). Builds clean (RAM ~36%, flash ~37%)

Pending:
- [ ] Flash and run the standalone sequence on the real rail (not yet run on hardware)
- [ ] Auth token on all rail endpoints; restrict CORS to the app origin (currently `*`)
- [ ] Change the default AP password (`secrets.h.example` ships a known one); `secrets.h` stays gitignored
- [ ] Idle motor disable after N seconds stopped (heat), re-enable before moves
- [ ] Investigate TLS handshake stalls: `handleClient()` blocks the loop, so the stepper can stutter while a request is served. Measure at 0.5 and 0.75 cm/s. If it stutters, move step generation to a hardware timer/ISR
- [ ] Persist nothing across reboot except config: after any reboot the position is **unknown** until homed (set `calibrated = false`, which is already the default)
- [ ] `/status` should report limit-switch state, e-stop state, last stop reason
- [ ] Decide STA (clinic WiFi) vs AP mode (see section 6)

## 4. Web app: rail integration (`ui/app.js`)

Owner: Bi (Takumi for the module split)

Done:
- [x] Rail enable toggle, URL field, connection/calibration status pill
- [x] Approach, jog, home, stop wired to the real rail
- [x] Speed pill value is sent to the firmware; the status pill shows the speed actually applied (and "capped from X")
- [x] Continuous sweep applies to every selectable endpoint and samples against telemetry-estimated rail position
- [x] Rail connection lost mid-sequence stops the measurement

Pending:
- [ ] Run the continuous flow against the real board; verify position estimates and auto-stop distance against physical measurements
- [ ] Extract rail code into its own module (`rail-client.js`) so it can be unit-tested with a mock
- [ ] Heartbeat to the firmware while moving (pairs with the firmware watchdog)
- [ ] Clear UI states: not connected / not homed / moving / stopped by limit / e-stop
- [ ] Results saved when the tablet is on the rail's WiFi with no internet: offline queue and sync

## 5. Eye tracking and the moving camera

Owner: Shinra (Optimus for the optics/mount)

- [ ] **Feasibility run:** with the camera fixed, record a real face while the target is at each intended endpoint (20, 4 and 2 cm), only after mechanical validation. For each position, check target fixation, face detection, stable iris landmarks, focus and both eyes in frame. Result: ______
- [ ] Phone model and lens chosen (main / ultrawide / macro); minimum focus distance known: ______ cm
- [ ] Compare continuous tracking quality at 0.5 cm/s and 0.75 cm/s against stationary samples
- [ ] Confirm the clinically usable minimum for each selected rail range; do not infer a break below the tested endpoint
- [ ] Verify in the deployed website that camera crop/geometry stays fixed as the target moves; rail position is used only as target-to-eye distance for break sampling and result reporting
- [ ] Iris-size distance estimate as a cross-check against the step count (iris about 11.7 mm). Measure its error against the ruler first; use only as a warning, not as truth
- [ ] Autofocus/exposure behaviour while moving (lock focus at each stop?)
- [ ] Stepper vibration effect on image sharpness during moves
- [ ] Measure and record the offset from the carriage's calibrated datum to the red fixation point and the eye's corneal reference plane
- [ ] Validate eye-driven break detection against an operator-observed break position; do not treat reaching the 20 cm rail limit as a detected break
- [ ] Validate break detection against an optometrist's marked break points on a small group; record agreement

## 6. Network and topology (decision needed)

Owner: Nexus decides, Takumi/Optimus implement

Problem: the rail's WiFi AP has no internet, but the phone camera uses internet WebRTC signaling (`/api/webrtc/*` on Vercel) and results sync to the hosted backend.

- [ ] Decide: (a) ESP8266 joins clinic WiFi (station mode, AP fallback), (b) keep AP mode and run a local server, (c) other. Recommendation: (a)
- [ ] Fixed IP / mDNS name for the board
- [ ] Self-signed certificate warning handled (or replaced by a proper approach); document the one-time step
- [ ] Verify tablet, phone camera and board work together on one network end to end

## 7. Backend and security (`ui/api`, `ui/server.py`, `ui/database`)

Owner: Takumi. **Do before any real patient data is stored.**

- [ ] Confirm whether the deployed database holds real data (answer needed: ______)
- [ ] Delete the seeded default accounts (`dr_bea`, `dr_rizal`, password `password123`) from production; stop seeding them there
- [ ] Server-side authentication (sessions or short-lived tokens); today login is browser-only (`localStorage`)
- [ ] Protect `GET /api/patients`, `/api/logs`, `/api/auth/users`; restrict CORS (currently `*`)
- [ ] Password reset must verify the user (today `reset_password` takes email + new password only)
- [ ] `update-profile` and `register` authorization
- [ ] Replace SHA-256 + hardcoded salt with argon2 or bcrypt (per-user salt); migrate on next login
- [ ] Patient MRN: stop the 4-digit auto MRN and the upsert-on-MRN overwrite (collisions silently replace another patient)
- [ ] Audit log of who read/changed patient records
- [ ] Rate limiting on login and reset
- [ ] Compliance review (HIPAA / Philippine Data Privacy Act): consent, retention, encryption at rest, who may access
- [ ] Secrets only in environment, never in the repo; rotate after any exposure
- [ ] Backups configured and a restore actually tested

## 8. QA and release gates

Owner: Verity

- [ ] Mock-rail smoke test: app against a fake `/status /move /jog /stop` server (no hardware)
- [ ] Unit tests for the rail client: clamp, jog sign convention (device + = closer, app + = farther), continuous sweep, connection loss
- [ ] API tests: auth required, no cross-patient access, MRN uniqueness
- [ ] Accessibility pass on the operator screens (touch targets >= 48 dp, contrast)
- [ ] CI that runs the above plus the PlatformIO build (`pio run`)
- [ ] Failure-mode test: kill WiFi mid-approach, close the browser mid-approach, power-cycle mid-approach. Rail must stop or safely hold, never run on
- [ ] Release gate: section 1 complete, sections 2 and 7 critical items complete, one full supervised dry run on record

## 9. Later (not blocking)

- [ ] Android native app (reference Kotlin only, no Gradle project)
- [ ] Split `app.js` (about 2.6k lines, one class) and `app.css` into modules
- [ ] Multi-clinic support, reporting/export, PDF results
- [ ] Higher speed ceiling after bench testing (needs timer-based stepping and current/supply review)
- [ ] Mechanical parts still at design stage: occluder, chin rest, phone holder, pivot (see the feasibility evaluation PDF)

## Open questions

1. Measure the fixation point to corneal-plane offset and confirm the fixed camera can see both eyes while the patient follows the target.
2. Which phone and lens provide reliable focus at the fixed camera position? ______
3. Which selected endpoint (20, 4 or 2 cm) is clinically and physically validated for the intended screening workflow? ______
4. Compare tracker break detections with operator-observed break points before relying on automatic stop.
5. Is the hosted (Vercel) deployment holding real patient data? ______
6. Station-mode clinic WiFi or local server? ______
