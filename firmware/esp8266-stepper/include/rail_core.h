// Motion core shared by main.cpp (hardware, profile runner) and cloud_client.cpp.
#pragma once

#include <Arduino.h>
#include <AccelStepper.h>

extern AccelStepper stepper;
extern bool calibrated;

long cmToMicrosteps(float distanceCm);      // clamped to the rail's travel limits
float microstepsToCm(long microsteps);
float applySpeedCmPerSec(float requestedCmPerSec);   // clamped to the speed ceiling; <=0 = ceiling

// ---- hybrid approach profile: fast sweep, small slow steps with a dwell, return home ----
struct Profile {
  float fastEndCm;   // fast sweep ends here (40 -> fastEndCm)
  float targetCm;    // slow steps continue until here
  float stepCm;      // slow step size
  float fastCmS;
  float slowCmS;
  uint32_t dwellMs;  // pause at every stop (the tracker reads the eye here)
};

bool profileStart(const Profile &p);        // false if rejected (bad numbers)
void profileAbort();
bool profileActive();
bool profileFinished();                     // true once, after a profile ran to completion
const char *profileStateName();

// Stop moving as soon as possible (decelerates), cancel any profile, remember why.
void railHardStop(const char *reason);
const char *railStopReason();
void railClearStopReason();

// ---- cloud relay client (cloud_client.cpp); no-ops unless RAIL_MODE_CLOUD ----
void cloudBegin();
void cloudTick();
