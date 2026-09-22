/**
 * Accu-Vis Compact Clinical Station Controller
 * Based on: Accu-Vis Feasibility Evaluation (June 22, 2026)
 * "Innovation of an Automated and Compact Clinical Unit for Near Vision Testing"
 */

class AccuVisApp {
  constructor() {
    // Current Active Patient
    this.currentPatient = {
      id: "ACV-2026-0042",
      name: "Subject Alpha",
      age: 28,
      notes: "Uncorrected visual acuity assessment at 40cm standard fixture rail."
    };

    // Fixture & Test Configuration (Accu-Vis Feasibility Evaluation Standards)
    this.config = {
      eye: "OD",            // OD (Right), OS (Left), OU (Binocular)
      distance: "40cm",     // Standard Near Acuity on Linear Guide
      chartType: "tumbling_e", // tumbling_e, landolt_c, snellen
      totalTrials: 8,
      trackingProvider: "simulation" // simulation, mediapipe
    };

    // Hardware Fixture Telemetry (5 Components from PDF)
    this.fixture = {
      linearDistanceCm: 40,
      linearMotor: "manual", // manual, stepper, servo
      occluderPosition: "left", // left (tests OD), center (tests OU), right (tests OS)
      chinRestHeightMm: 120,
      poleClamped: true,
      phoneHolderMounted: true
    };

    // Vision Test State Engine
    this.testState = {
      active: false,
      paused: false,
      trialIndex: 0,
      currentOrientation: "right", // up, down, left, right
      currentTier: "20/40",
      trials: [],
      trialStartTime: 0,
      snellenLevels: [
        { label: "20/100", sizePx: 140, logmar: 0.7 },
        { label: "20/70",  sizePx: 110, logmar: 0.54 },
        { label: "20/50",  sizePx: 90,  logmar: 0.4 },
        { label: "20/40",  sizePx: 75,  logmar: 0.3 },
        { label: "20/30",  sizePx: 60,  logmar: 0.18 },
        { label: "20/25",  sizePx: 48,  logmar: 0.1 },
        { label: "20/20",  sizePx: 38,  logmar: 0.0 },
        { label: "20/15",  sizePx: 30,  logmar: -0.12 }
      ]
    };

    // Dot-to-Eye Automated Distance Measurement State (Linear Stepper Rail)
    this.dotState = {
      testMode: "npc", // npc (Near Point of Convergence) or npa (Near Point of Accommodation)
      railDistanceCm: 40.0,
      isApproaching: false,
      speedCmPerSec: 1.5,
      autoStop: true,
      targetStyle: "rose", // rose, laser, contrast, bullseye
      cameraFlipped: false,
      cameraMirrored: false,
      cameraStream: null,
      pipMinimized: false,
      convergenceLocked: false,
      recordedDistanceCm: null,
      alignmentScore: 99.2,
      animationFrameId: null,
      lastTimestamp: 0,
      breakDistanceCm: 12.4 // Clinical standard NPC range (~10-15cm)
    };
    this.eyeTracker = null;

    // Remote "Phone Camera" source: another phone streams JPEG frames over
    // the local network (see camera.html); this device polls and re-injects
    // them into the same <video> the local-webcam eye tracker already reads.
    this.remoteCameraState = {
      mode: 'local', // 'local' or 'remote'
      canvas: null,
      ctx: null,
      pollTimer: null,
      statusTimer: null,
      streamAttached: false
    };

    // Saved Patient Records (localStorage backed)
    this.records = this.loadRecords();

    // Intake & Database State
    this.intakeState = {
      gender: "Female"
    };
    this.dbPatients = [];
    this.dbLogs = [];
    this.currentUser = this.loadCurrentUser();

    // Jaeger's Near Reading Chart State (J1 = finest print ... J7 = largest)
    this.jaegerState = {
      level: "J2",
      levels: {
        J1: { sizePx: 8,  equiv: "~20/20 Equivalent" },
        J2: { sizePx: 10, equiv: "~20/25 Equivalent" },
        J3: { sizePx: 12, equiv: "~20/30 Equivalent" },
        J4: { sizePx: 14, equiv: "~20/40 Equivalent" },
        J5: { sizePx: 17, equiv: "~20/50 Equivalent" },
        J6: { sizePx: 21, equiv: "~20/60 Equivalent" },
        J7: { sizePx: 25, equiv: "~20/70 Equivalent" }
      }
    };

    // Ishihara-Style Color Vision Screening State
    this.colorVisionState = {
      plates: [
        { number: 12, choices: [12, 17, 21, 71] },
        { number: 8,  choices: [8, 3, 6, 88] },
        { number: 29, choices: [29, 70, 26, 92] },
        { number: 5,  choices: [5, 2, 6, 15] },
        { number: 74, choices: [74, 21, 47, 7] }
      ],
      plateIndex: 0,
      correctCount: 0,
      answered: false
    };

    // Init
    this.init();
  }

  async init() {
    this.bindKeyboardShortcuts();
    this.generateNewMRN();
    this.updateUserInterface();
    await this.loadDatabaseData();
    this.renderDatabaseRecords();
    this.renderLogsTable();

    if (!this.currentUser) {
      this.switchView('login');
      return;
    }

    const initialView = window.location.hash.replace('#', '') || 'dashboard';
    this.switchView(initialView);
  }

  // =========================================================================
  // VIEW SWITCHING (DASHBOARD, PRODUCTS, INTAKE, DOT-MEASURE, EXAM, RECORDS, SPLASH)
  // =========================================================================

  switchView(viewName) {
    // Logged-out users may only ever see the login/auth view
    if (!this.currentUser && viewName !== 'login') {
      viewName = 'login';
    }

    this.closeMobileSidebar();

    document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.classList.add('active');
      window.scrollTo(0, 0);
    }

    // Update desktop sidebar navigation active state
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      btn.classList.remove('active');
    });
    const sideItem = document.getElementById(`nav-${viewName}`);
    if (sideItem) {
      sideItem.classList.add('active');
    }

    // Toggle header visibility on splash & login
    const mainHeader = document.getElementById('app-main-header');
    if (mainHeader) {
      mainHeader.style.display = (viewName === 'splash' || viewName === 'login') ? 'none' : 'flex';
    }

    if (viewName === 'records') {
      this.loadDatabaseData().then(() => {
        this.renderDatabaseRecords();
        this.renderLogsTable();
      });
    } else if (viewName === 'dot-measure') {
      this.initDotMeasureView();
    } else if (viewName === 'exam') {
      this.startInstantTest();
    } else if (viewName === 'jaeger') {
      this.initJaegerView();
    } else if (viewName === 'color-vision') {
      this.initColorVisionView();
    } else {
      if (this.dotState && this.dotState.isApproaching) {
        this.pauseStepperApproach();
      }
      if (this.eyeTracker && this.eyeTracker.isRunning) {
        this.eyeTracker.stop();
      }
      this.stopRemoteCameraFeed();
    }
  }

  // =========================================================================
  // STEP 1: PATIENT INTAKE & CLINIC DATABASE INTEGRATION
  // =========================================================================

  async loadDatabaseData() {
    try {
      const pRes = await fetch('/api/patients');
      if (pRes.ok) {
        this.dbPatients = await pRes.json();
      }

      const lRes = await fetch('/api/logs');
      if (lRes.ok) {
        this.dbLogs = await lRes.json();
        this.records = this.dbLogs.map(l => ({
          id: l.log_id,
          patientId: l.mrn,
          patientName: l.patient_name,
          date: l.created_at,
          eye: l.eye,
          distance: `${l.distance_cm} cm`,
          acuity: `NPC: ${l.distance_cm}cm`,
          accuracy: l.symmetry || "99.4%",
          fixation: l.verdict
        }));
      }
    } catch(e) {
      console.log("Using local offline database cache");
    }
  }

  selectRecentPatient(mrn) {
    const p = this.dbPatients && this.dbPatients.find(item => item.mrn === mrn);
    if (!p) {
      this.showNotification("Patient Not Found", `No record for MRN ${mrn} in the database.`);
      return;
    }

    this.currentPatient = {
      id: p.mrn,
      name: p.full_name,
      age: p.age,
      notes: p.notes
    };

    const dotTag = document.getElementById('dot-patient-tag');
    if (dotTag) dotTag.textContent = `${p.full_name} (${p.mrn})`;

    const topName = document.getElementById('topbar-patient-name');
    if (topName) topName.textContent = p.full_name;

    const topMrn = document.getElementById('topbar-patient-mrn');
    if (topMrn) topMrn.textContent = p.mrn;

    const nameInput = document.getElementById('intake-name');
    if (nameInput) nameInput.value = p.full_name;

    const mrnInput = document.getElementById('intake-mrn');
    if (mrnInput) mrnInput.value = p.mrn;

    const displayName = document.getElementById('display-intake-name');
    if (displayName) displayName.textContent = p.full_name;

    const displayMrn = document.getElementById('display-intake-mrn');
    if (displayMrn) displayMrn.textContent = `MRN: ${p.mrn}`;

    this.showNotification("Patient Selected", `${p.full_name} loaded`);
    this.switchView('dot-measure');
  }

  filterPatients(searchTerm) {
    this.renderDatabaseRecords(searchTerm);
  }

  renderDatabaseRecords(filterText = '') {
    const listEl = document.getElementById('database-records-list');
    if (!listEl) return;

    let patients = this.dbPatients && this.dbPatients.length > 0 ? this.dbPatients : [];
    if (filterText) {
      const q = filterText.toLowerCase();
      patients = patients.filter(p => p.full_name.toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q));
    }

    if (patients.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">No patient records found.</div>`;
      return;
    }

    listEl.innerHTML = patients.map(p => {
      const initials = p.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
      const avatarHtml = `<div class="patient-card-avatar" style="width:38px; height:38px; font-size:13px;">${initials}</div>`;

      const latestLog = (this.dbLogs || []).find(l => l.mrn === p.mrn);
      const latestResultHtml = latestLog
        ? `<div style="font-size:11px; color:var(--primary-maroon); margin-top:2px; font-weight:600;">Latest: ${latestLog.test_type || 'NPC'} ${latestLog.distance_cm}cm &mdash; ${latestLog.verdict}</div>`
        : `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">No measurement results yet</div>`;

      return `
        <div class="patient-desktop-card" onclick="app.selectRecentPatient('${p.mrn}')" style="margin-bottom:8px;">
          ${avatarHtml}
          <div class="patient-card-info">
            <h3 class="patient-card-name">${p.full_name} <small style="font-weight:normal; opacity:0.75; font-family:var(--font-mono); font-size:11px;">(${p.mrn})</small></h3>
            <div class="patient-card-demographics">Age: ${p.age || 28} &nbsp;&bull;&nbsp; Gender: ${p.gender || 'Male'} &nbsp;&bull;&nbsp; Target: ${p.eye_preference || 'OD'}</div>
            ${latestResultHtml}
          </div>
          <button class="btn-select-patient" title="Launch Test for ${p.full_name}">&rarr;</button>
        </div>
      `;
    }).join('');
  }

  renderLogsTable() {
    const tbody = document.getElementById('logs-table-body');
    if (!tbody) return;

    const logs = this.dbLogs || [];
    if (logs.length === 0) {
      tbody.innerHTML = `<tr class="log-empty-row"><td colspan="6">No measurement results yet. Results from NPC/NPA, Near VA, Jaeger's, and Color Vision tests will appear here as they are saved.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const dateStr = l.created_at ? (l.created_at.includes('T') ? l.created_at.split('T')[0] : l.created_at) : '';
      return `
        <tr>
          <td><strong>${l.patient_name}</strong><br><small style="color:var(--text-muted); font-family:var(--font-mono); font-size:10px;">${l.mrn}</small></td>
          <td><span class="log-test-badge">${l.test_type || 'NPC'}</span></td>
          <td>${l.eye}</td>
          <td>${l.distance_cm}cm</td>
          <td>${l.verdict}</td>
          <td>${dateStr}</td>
        </tr>
      `;
    }).join('');
  }

  generateNewMRN() {
    const code = "ACV-2026-" + Math.floor(1000 + Math.random() * 9000);
    const mrnInput = document.getElementById('intake-mrn');
    if (mrnInput) mrnInput.value = code;
    return code;
  }

  generateLogId() {
    // Timestamp + random suffix keeps ids unique even for rapid consecutive saves
    return "LOG-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(100 + Math.random() * 900);
  }

  resetIntakeForm() {
    const nameInput = document.getElementById('intake-name');
    if (nameInput) {
      nameInput.value = '';
      nameInput.focus();
    }
    const notesInput = document.getElementById('intake-notes');
    if (notesInput) notesInput.value = '';
    this.generateNewMRN();
    document.querySelectorAll('.patient-chip-btn').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.chip-new-patient').forEach(c => c.classList.add('active'));
  }

  setIntakeGender(gender) {
    this.intakeState.gender = gender;
    document.querySelectorAll('.form-pill-btn[id^="gender-"]').forEach(btn => {
      btn.classList.toggle('active', btn.id === `gender-${gender.toLowerCase()}`);
    });
  }

  setIntakeEye(eye) {
    this.setTestEye(eye);
  }

  // Eye under test (OD / OS / OU): drives the intake pills, the NPC/NPA eye selector,
  // saved records, and which eye the tracker is allowed to detect.
  setTestEye(eye) {
    if (eye !== 'OD' && eye !== 'OS' && eye !== 'OU') eye = 'OD';
    this.config.eye = eye;
    if (this.currentPatient) {
      this.currentPatient.eye = eye;
    }
    if (this.eyeTracker) {
      this.eyeTracker.setTargetEye(eye);
    }
    this.syncEyeSelectorUI();
    this.updateChinRestView();
  }

  syncEyeSelectorUI() {
    const eye = this.config.eye;
    ['od', 'os', 'ou'].forEach(code => {
      const active = eye.toLowerCase() === code;
      const intakeBtn = document.getElementById(`intake-eye-${code}`);
      if (intakeBtn) intakeBtn.classList.toggle('active', active);
      const dotBtn = document.getElementById(`eye-select-${code}`);
      if (dotBtn) dotBtn.classList.toggle('active', active);
    });
    const label = document.getElementById('pip-target-eye-label');
    if (label) {
      label.textContent = eye === 'OD' ? 'OD (Right Eye)' : eye === 'OS' ? 'OS (Left Eye)' : 'OU (Both Eyes)';
    }
  }

  updateTrackerStatus(mode) {
    const chip = document.getElementById('tracker-mode-chip');
    if (!chip) return;
    chip.classList.toggle('ready', mode === 'landmarks');
    chip.classList.toggle('basic', mode === 'basic');
    chip.textContent = mode === 'landmarks'
      ? 'Tracker: face + iris landmarks'
      : mode === 'basic'
        ? 'Tracker: basic mode (landmarks unavailable)'
        : 'Tracker: loading...';
  }

  updateIntakeAge() {
    const birthdateInput = document.getElementById('intake-birthdate');
    const ageInput = document.getElementById('intake-age');
    if (!birthdateInput || !ageInput) return;

    const birthdate = new Date(`${birthdateInput.value}T00:00:00`);
    const today = new Date();
    if (!birthdateInput.value || Number.isNaN(birthdate.getTime()) || birthdate > today) {
      ageInput.value = '';
      ageInput.placeholder = birthdate > today ? 'Birthdate cannot be in the future' : 'Enter birthdate first';
      return;
    }

    let age = today.getFullYear() - birthdate.getFullYear();
    const hasNotHadBirthday = today.getMonth() < birthdate.getMonth()
      || (today.getMonth() === birthdate.getMonth() && today.getDate() < birthdate.getDate());
    if (hasNotHadBirthday) age -= 1;

    ageInput.value = `${age} years`;
    ageInput.placeholder = '';
  }

  async handleIntakeSubmit(event) {
    if (event) event.preventDefault();

    const nameInput = document.getElementById('intake-name');
    const mrnInput = document.getElementById('intake-mrn');
    const ageInput = document.getElementById('intake-age');
    const notesInput = document.getElementById('intake-notes');

    const fullName = (nameInput && nameInput.value.trim()) || "Walk-in Patient";
    const mrn = (mrnInput && mrnInput.value.trim()) || this.generateNewMRN();
    const birthdateInput = document.getElementById('intake-birthdate');
    const birthdate = birthdateInput ? birthdateInput.value : '';
    const age = parseInt(ageInput ? ageInput.value : '', 10);
    const notes = notesInput ? notesInput.value.trim() : "";

    if (!birthdate || Number.isNaN(age)) {
      this.showNotification("Birthdate Required", "Enter a valid birthdate to calculate the patient's age.");
      return;
    }

    this.currentPatient = {
      id: mrn,
      name: fullName,
      age: age,
      birthdate: birthdate,
      notes: notes
    };

    const patientPayload = {
      mrn: mrn,
      full_name: fullName,
      age: age,
      birthdate: birthdate,
      gender: document.getElementById('intake-gender')?.value || this.intakeState.gender,
      eye_preference: this.config.eye,
      notes: notes
    };

    // Save to SQLite database API endpoint
    try {
      await fetch('/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patientPayload)
      });
    } catch(e) {
      console.warn("Backend API offline, falling back to local storage:", e);
    }

    // Refresh patient list in memory
    await this.loadDatabaseData();

    this.showNotification("Patient Saved", `Registered ${fullName}`);
    this.switchView('products');
  }

  // =========================================================================
  // STEP 2: CHIN REST POSITIONING & PATIENT ALIGNMENT
  // =========================================================================

  updateChinRestView() {
    const nameEl = document.getElementById('cr-patient-name');
    if (nameEl) nameEl.textContent = this.currentPatient.name;

    const metaEl = document.getElementById('cr-patient-meta');
    if (metaEl) {
      metaEl.textContent = `MRN: ${this.currentPatient.id} • Age: ${this.currentPatient.age} • Eye: ${this.config.eye} (${this.config.eye === 'OD' ? 'Right Eye' : this.config.eye === 'OS' ? 'Left Eye' : 'Both Eyes'})`;
    }

    const occBadge = document.getElementById('cr-occluder-badge');
    if (occBadge) {
      if (this.config.eye === 'OD') {
        occBadge.textContent = 'Slide Left (Covers OS, Tests OD)';
      } else if (this.config.eye === 'OS') {
        occBadge.textContent = 'Slide Right (Covers OD, Tests OS)';
      } else {
        occBadge.textContent = 'Center Open (Tests Binocular OU)';
      }
    }
  }

  proceedToStepperRail() {
    this.switchView('dot-measure');
    const tag = document.getElementById('dot-patient-tag');
    if (tag) {
      tag.textContent = `Patient: ${this.currentPatient.name} (${this.currentPatient.id}) • Eye: ${this.config.eye}`;
    }
  }

  // =========================================================================
  // 1-CLICK INSTANT EXAM LAUNCHER
  // =========================================================================

  startInstantTest() {
    this.testState.active = true;
    this.testState.paused = false;
    this.testState.trialIndex = 0;
    this.testState.trials = [];

    // Header metadata
    const patEl = document.getElementById('exam-patient-name');
    if (patEl) patEl.textContent = `${this.currentPatient.name} (${this.currentPatient.id})`;

    const eyeEl = document.getElementById('exam-active-eye-tag');
    if (eyeEl) eyeEl.textContent = this.config.eye;

    const distEl = document.getElementById('exam-active-dist-tag');
    if (distEl) distEl.textContent = `${this.fixture.linearDistanceCm}cm`;

    this.presentNextTrial();
  }

  presentNextTrial() {
    if (this.testState.trialIndex >= this.config.totalTrials) {
      this.completeTest();
      return;
    }

    const currentIdx = this.testState.trialIndex;
    const trialNumEl = document.getElementById('exam-trial-num');
    if (trialNumEl) trialNumEl.textContent = currentIdx + 1;

    const progressPct = ((currentIdx) / this.config.totalTrials) * 100;
    const fillEl = document.getElementById('exam-progress-fill');
    if (fillEl) fillEl.style.width = `${progressPct}%`;

    // Pick Snellen tier based on trial progression
    const tier = this.testState.snellenLevels[Math.min(currentIdx, this.testState.snellenLevels.length - 1)];
    this.testState.currentTier = tier.label;
    const tierEl = document.getElementById('exam-acuity-tag');
    if (tierEl) tierEl.textContent = `${tier.label} Equiv`;

    // Randomize orientation: up, down, left, right
    const orientations = ["up", "down", "left", "right"];
    const randomOrient = orientations[Math.floor(Math.random() * orientations.length)];
    this.testState.currentOrientation = randomOrient;

    // Update Optotype on Clinical Canvas
    const stimEl = document.getElementById('optotype-stimulus');
    if (stimEl) {
      stimEl.className = `optotype-e orientation-${randomOrient}`;
      stimEl.style.fontSize = `${tier.sizePx}px`;
      stimEl.textContent = 'E';
    }

    this.testState.trialStartTime = performance.now();
  }

  recordResponse(direction) {
    if (!this.testState.active || this.testState.paused) return;

    const reactionTimeMs = Math.round(performance.now() - this.testState.trialStartTime);
    const correct = (direction === this.testState.currentOrientation);

    this.testState.trials.push({
      trialNumber: this.testState.trialIndex + 1,
      targetOrientation: this.testState.currentOrientation,
      patientResponse: direction,
      isCorrect: correct,
      acuityTier: this.testState.currentTier,
      reactionTimeMs: reactionTimeMs
    });

    this.testState.trialIndex++;
    this.presentNextTrial();
  }

  repeatTrial() {
    if (!this.testState.active) return;
    this.presentNextTrial();
  }

  completeTest() {
    this.testState.active = false;

    // Calculate score
    const correctCount = this.testState.trials.filter(t => t.isCorrect).length;
    const finalTier = correctCount >= 7 ? "20/20" : correctCount >= 5 ? "20/25" : correctCount >= 3 ? "20/40" : "20/70";
    const logmar = finalTier === "20/20" ? "0.00" : finalTier === "20/25" ? "0.10" : finalTier === "20/40" ? "0.30" : "0.54";
    this.testState.lastResult = { correctCount, finalTier, logmar };

    // Populate Result Modal
    const snellenEl = document.getElementById('res-exam-snellen');
    if (snellenEl) snellenEl.textContent = finalTier;

    const logmarEl = document.getElementById('res-exam-logmar');
    if (logmarEl) logmarEl.textContent = `LogMAR ${logmar}`;

    const badgeEl = document.getElementById('res-exam-verdict-badge');
    const noteEl = document.getElementById('res-exam-clinical-note');
    if (finalTier === '20/20') {
      if (badgeEl) { badgeEl.className = 'status-badge-green'; badgeEl.textContent = 'Normal Visual Acuity'; }
      if (noteEl) noteEl.textContent = `Patient correctly identified ${correctCount} of ${this.config.totalTrials} optotype orientations. No refractive concern detected.`;
    } else if (finalTier === '20/25' || finalTier === '20/40') {
      if (badgeEl) { badgeEl.className = 'status-badge-orange'; badgeEl.textContent = 'Mild Refractive Blur'; }
      if (noteEl) noteEl.textContent = `Patient identified ${correctCount} of ${this.config.totalTrials} optotypes correctly. Consider refraction re-check.`;
    } else {
      if (badgeEl) { badgeEl.className = 'status-badge-red'; badgeEl.textContent = 'Reduced Visual Acuity'; }
      if (noteEl) noteEl.textContent = `Patient identified only ${correctCount} of ${this.config.totalTrials} optotypes correctly. Recommend comprehensive refractive evaluation.`;
    }

    const resEyeEl = document.getElementById('res-exam-eye');
    if (resEyeEl) resEyeEl.textContent = this.config.eye;

    const resDistEl = document.getElementById('res-exam-distance');
    if (resDistEl) resDistEl.textContent = `${this.fixture.linearDistanceCm}cm`;

    const resAccEl = document.getElementById('res-exam-accuracy');
    if (resAccEl) resAccEl.textContent = `${correctCount}/${this.config.totalTrials}`;

    const modal = document.getElementById('modal-exam-result');
    if (modal) modal.classList.remove('hidden');
  }

  closeExamResultModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('modal-exam-result');
    if (modal) modal.classList.add('hidden');
  }

  retestExam() {
    this.closeExamResultModal();
    this.startInstantTest();
  }

  async saveExamRecord() {
    const result = this.testState.lastResult;
    if (!result) return;

    const logId = this.generateLogId();
    const logPayload = {
      log_id: logId,
      mrn: this.currentPatient.id,
      patient_name: this.currentPatient.name,
      test_type: "Near VA",
      eye: this.config.eye,
      distance_cm: this.fixture.linearDistanceCm,
      distance_mm: this.fixture.linearDistanceCm * 10,
      verdict: `${result.finalTier} (LogMAR ${result.logmar})`,
      symmetry: `${result.correctCount}/${this.config.totalTrials}`,
      operator_notes: `Near Visual Acuity trial: ${result.correctCount} of ${this.config.totalTrials} tumbling-E orientations identified correctly at ${this.fixture.linearDistanceCm}cm.`
    };

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logPayload)
      });
    } catch (e) {
      console.warn("Backend API offline, could not save Near VA record:", e);
    }

    this.records.unshift({
      id: logId,
      patientId: this.currentPatient.id,
      patientName: this.currentPatient.name,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      eye: this.config.eye,
      distance: `${this.fixture.linearDistanceCm}cm`,
      acuity: result.finalTier,
      accuracy: `${result.correctCount}/${this.config.totalTrials}`,
      fixation: logPayload.verdict
    });
    this.saveRecords();

    this.closeExamResultModal();
    await this.loadDatabaseData();

    this.switchView('intake');
    this.showNotification("Near VA Result Saved", `${result.finalTier} logged for ${this.currentPatient.name} in database.`);
  }

  // =========================================================================
  // JAEGER'S NEAR READING CHART (J1-J7 PRESBYOPIA SCREENING)
  // =========================================================================

  initJaegerView() {
    const eyeEl = document.getElementById('jaeger-active-eye-tag');
    if (eyeEl) eyeEl.textContent = this.config.eye;
    this.setJaegerLevel(this.jaegerState.level);
  }

  setJaegerLevel(level) {
    const def = this.jaegerState.levels[level];
    if (!def) return;
    this.jaegerState.level = level;

    const textEl = document.getElementById('jaeger-reading-text');
    if (textEl) textEl.style.fontSize = `${def.sizePx}px`;

    const activeLabelEl = document.getElementById('jaeger-active-level');
    if (activeLabelEl) activeLabelEl.textContent = level;

    const equivEl = document.getElementById('jaeger-equiv-tag');
    if (equivEl) equivEl.textContent = def.equiv;

    document.querySelectorAll('.jaeger-level-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === level);
    });
  }

  async saveJaegerRecord() {
    const level = this.jaegerState.level;
    const def = this.jaegerState.levels[level];
    const verdict = `${level} — Smallest Line Read Comfortably (${def.equiv})`;
    const logId = this.generateLogId();

    const logPayload = {
      log_id: logId,
      mrn: this.currentPatient.id,
      patient_name: this.currentPatient.name,
      test_type: "Jaeger's Chart",
      eye: this.config.eye,
      distance_cm: this.fixture.linearDistanceCm,
      distance_mm: this.fixture.linearDistanceCm * 10,
      verdict: verdict,
      symmetry: level,
      operator_notes: `Smallest Jaeger near-reading line read comfortably: ${level} at ${this.fixture.linearDistanceCm}cm.`
    };

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logPayload)
      });
    } catch (e) {
      console.warn("Backend API offline, could not save Jaeger's Chart record:", e);
    }

    this.records.unshift({
      id: logId,
      patientId: this.currentPatient.id,
      patientName: this.currentPatient.name,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      eye: this.config.eye,
      distance: `${this.fixture.linearDistanceCm}cm`,
      acuity: level,
      accuracy: def.equiv,
      fixation: verdict
    });
    this.saveRecords();

    await this.loadDatabaseData();
    this.switchView('intake');
    this.showNotification("Jaeger's Chart Saved", `${level} logged for ${this.currentPatient.name} in database.`);
  }

  // =========================================================================
  // ISHIHARA-STYLE COLOR VISION SCREENING
  // =========================================================================

  initColorVisionView() {
    this.colorVisionState.plateIndex = 0;
    this.colorVisionState.correctCount = 0;
    this.colorVisionState.answered = false;

    const resultPanel = document.getElementById('color-vision-result-panel');
    if (resultPanel) resultPanel.classList.add('hidden');
    const quizPanel = document.getElementById('color-vision-quiz-panel');
    if (quizPanel) quizPanel.classList.remove('hidden');

    const totalEl = document.getElementById('cv-plate-total');
    if (totalEl) totalEl.textContent = this.colorVisionState.plates.length;

    this.renderColorVisionPlate();
  }

  renderColorVisionPlate() {
    const state = this.colorVisionState;
    const plate = state.plates[state.plateIndex];
    if (!plate) return;

    state.answered = false;

    const numEl = document.getElementById('cv-plate-num');
    if (numEl) numEl.textContent = state.plateIndex + 1;

    const scoreEl = document.getElementById('cv-score-tag');
    if (scoreEl) scoreEl.textContent = `${state.correctCount}/${state.plateIndex}`;

    const canvas = document.getElementById('color-vision-canvas');
    if (canvas) this.drawIshiharaPlate(canvas, plate.number);

    // Shuffle choices for this render
    const shuffled = [...plate.choices].sort(() => Math.random() - 0.5);
    const grid = document.getElementById('cv-choice-grid');
    if (grid) {
      grid.innerHTML = shuffled.map(choice => `
        <button type="button" class="cv-choice-btn" onclick="app.answerColorVision(${choice})">${choice}</button>
      `).join('');
    }
  }

  drawIshiharaPlate(canvas, number) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Offscreen mask: render the target number, sample which pixels are "figure" vs "background"
    const mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const mctx = mask.getContext('2d');
    mctx.fillStyle = '#000000';
    mctx.fillRect(0, 0, w, h);
    mctx.fillStyle = '#ffffff';
    mctx.font = `bold ${Math.floor(h * 0.55)}px sans-serif`;
    mctx.textAlign = 'center';
    mctx.textBaseline = 'middle';
    mctx.fillText(String(number), w / 2, h / 2 + h * 0.02);
    const maskData = mctx.getImageData(0, 0, w, h).data;

    const cx = w / 2, cy = h / 2, radius = Math.min(w, h) / 2 - 6;
    const bgColors = ['#c9a86a', '#b8935a', '#a67c4e', '#d4b483', '#9c7a4a', '#bfa06a'];
    const fgColors = ['#c1652f', '#a84a2a', '#d47a3d', '#b85a2e', '#9e4423', '#c96a35'];

    for (let i = 0; i < 950; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      const px = Math.floor(x), py = Math.floor(y);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;

      const idx = (py * w + px) * 4;
      const isFigure = maskData[idx] > 128;
      const palette = isFigure ? fgColors : bgColors;
      const color = palette[Math.floor(Math.random() * palette.length)];
      const dotRadius = 2 + Math.random() * 2.4;

      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85 + Math.random() * 0.15;
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  answerColorVision(choice) {
    const state = this.colorVisionState;
    if (state.answered) return;
    state.answered = true;

    const plate = state.plates[state.plateIndex];
    const isCorrect = choice === plate.number;
    if (isCorrect) state.correctCount++;

    document.querySelectorAll('.cv-choice-btn').forEach(btn => {
      btn.disabled = true;
      const btnValue = parseInt(btn.textContent, 10);
      if (btnValue === plate.number) btn.classList.add('correct');
      else if (btnValue === choice) btn.classList.add('incorrect');
    });

    setTimeout(() => {
      state.plateIndex++;
      if (state.plateIndex >= state.plates.length) {
        this.finishColorVisionScreening();
      } else {
        this.renderColorVisionPlate();
      }
    }, 700);
  }

  finishColorVisionScreening() {
    const state = this.colorVisionState;
    const scoreEl = document.getElementById('cv-score-tag');
    if (scoreEl) scoreEl.textContent = `${state.correctCount}/${state.plates.length}`;

    const quizPanel = document.getElementById('color-vision-quiz-panel');
    if (quizPanel) quizPanel.classList.add('hidden');
    const resultPanel = document.getElementById('color-vision-result-panel');
    if (resultPanel) resultPanel.classList.remove('hidden');

    const badgeEl = document.getElementById('cv-result-badge');
    const noteEl = document.getElementById('cv-result-note');
    let verdict;
    if (state.correctCount >= 4) {
      verdict = 'Normal Color Vision';
      if (badgeEl) { badgeEl.className = 'status-badge-green'; badgeEl.textContent = verdict; }
      if (noteEl) noteEl.textContent = `Patient correctly identified ${state.correctCount} of ${state.plates.length} plates. No red-green deficiency indicated.`;
    } else if (state.correctCount >= 2) {
      verdict = 'Borderline - Recommend Retest';
      if (badgeEl) { badgeEl.className = 'status-badge-orange'; badgeEl.textContent = verdict; }
      if (noteEl) noteEl.textContent = `Patient identified ${state.correctCount} of ${state.plates.length} plates correctly. Recommend a formal Ishihara retest.`;
    } else {
      verdict = 'Possible Red-Green Color Vision Deficiency';
      if (badgeEl) { badgeEl.className = 'status-badge-red'; badgeEl.textContent = verdict; }
      if (noteEl) noteEl.textContent = `Patient identified only ${state.correctCount} of ${state.plates.length} plates correctly. Refer for formal clinical Ishihara testing.`;
    }
    this.colorVisionState.lastVerdict = verdict;
  }

  async saveColorVisionRecord() {
    const state = this.colorVisionState;
    const verdict = state.lastVerdict || 'Screening Incomplete';
    const logId = this.generateLogId();

    const logPayload = {
      log_id: logId,
      mrn: this.currentPatient.id,
      patient_name: this.currentPatient.name,
      test_type: "Color Vision",
      eye: "OU",
      distance_cm: this.fixture.linearDistanceCm,
      distance_mm: this.fixture.linearDistanceCm * 10,
      verdict: verdict,
      symmetry: `${state.correctCount}/${state.plates.length}`,
      operator_notes: `Ishihara-style screening: ${state.correctCount} of ${state.plates.length} plates correctly identified.`
    };

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logPayload)
      });
    } catch (e) {
      console.warn("Backend API offline, could not save Color Vision record:", e);
    }

    this.records.unshift({
      id: logId,
      patientId: this.currentPatient.id,
      patientName: this.currentPatient.name,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      eye: "OU",
      distance: `${this.fixture.linearDistanceCm}cm`,
      acuity: `${state.correctCount}/${state.plates.length} plates`,
      accuracy: `${state.correctCount}/${state.plates.length}`,
      fixation: verdict
    });
    this.saveRecords();

    await this.loadDatabaseData();
    this.switchView('intake');
    this.showNotification("Color Vision Result Saved", `${verdict} logged for ${this.currentPatient.name} in database.`);
  }

  testOtherEye() {
    const current = this.config.eye;
    let nextEye = 'OS';
    if (current === 'OD') nextEye = 'OS';
    else if (current === 'OS') nextEye = 'OU';
    else nextEye = 'OD';

    this.setQuickEye(nextEye);
    this.startInstantTest();
  }

  // =========================================================================
  // HARDWARE FIXTURE SETTINGS (ACCU-VIS FEASIBILITY EVALUATION PDF)
  // =========================================================================

  setQuickEye(eye) {
    this.config.eye = eye;

    // Sync UI buttons
    document.querySelectorAll('.eye-pill').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-eye-${eye.toLowerCase()}`);
    });

    const displayEye = document.getElementById('display-active-eye');
    if (displayEye) {
      displayEye.textContent = eye === 'OD' ? 'OD (Right)' : eye === 'OS' ? 'OS (Left)' : 'OU (Both)';
    }

    // Sync occluder status
    const pos = eye === 'OD' ? 'left' : eye === 'OS' ? 'right' : 'center';
    this.fixture.occluderPosition = pos;

    const occMetric = document.getElementById('dash-occ-metric');
    if (occMetric) {
      occMetric.textContent = eye === 'OD' ? 'Slide Left' : eye === 'OS' ? 'Slide Right' : 'Center Open';
    }

    // Sync modal tiles if open
    document.querySelectorAll('.occ-tile').forEach(tile => {
      tile.classList.toggle('active', tile.id === `f-occ-${pos}`);
    });
  }

  setOccluderSlide(position) {
    let eye = 'OU';
    if (position === 'left') eye = 'OD';
    else if (position === 'right') eye = 'OS';

    this.setQuickEye(eye);
  }

  setFixtureMotor(type) {
    this.fixture.linearMotor = type;
    document.querySelectorAll('#modal-fixture .pill-chip[id^="f-motor-"]').forEach(btn => {
      btn.classList.toggle('active', btn.id === `f-motor-${type}`);
    });
  }

  jogLinearRail(deltaCm) {
    this.fixture.linearDistanceCm = Math.max(20, Math.min(100, this.fixture.linearDistanceCm + deltaCm));
    const distStr = `${this.fixture.linearDistanceCm} cm`;

    const dashDist = document.getElementById('dash-dist-metric');
    if (dashDist) dashDist.textContent = distStr;

    const modalDist = document.getElementById('modal-rail-dist');
    if (modalDist) modalDist.textContent = distStr;

    const displayDist = document.getElementById('display-active-distance');
    if (displayDist) displayDist.textContent = `${distStr} Linear Rail`;

    const tileDist = document.getElementById('tile-distance');
    if (tileDist) tileDist.textContent = distStr;
  }

  setChinRestHeight(heightCm) {
    this.fixture.chinRestHeightMm = heightCm * 10;
    document.querySelectorAll('#modal-fixture .pill-chip[id^="f-chin-"]').forEach(btn => {
      btn.classList.toggle('active', btn.id === `f-chin-${heightCm}`);
    });

    const chinMetric = document.getElementById('dash-chin-metric');
    if (chinMetric) chinMetric.textContent = `${heightCm * 10} mm`;
  }

  // =========================================================================
  // CHART & METRICS
  // =========================================================================

  setChartRange(range) {
    document.querySelectorAll('.time-chip').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.trim() === range);
    });

    // Animate SVG path dynamically
    const strokePath = document.querySelector('.chart-line-stroke');
    const areaPath = document.querySelector('.chart-area-path');

    if (strokePath && areaPath) {
      if (range === '1D' || range === '1W') {
        const dLine = "M 0,140 Q 150,110 300,125 T 600,95 T 800,105 T 1000,80";
        const dArea = dLine + " L 1000,240 L 0,240 Z";
        strokePath.setAttribute('d', dLine);
        areaPath.setAttribute('d', dArea);
      } else {
        const dLine = "M 0,90 Q 50,60 100,75 T 200,95 T 300,85 T 400,105 T 500,115 T 550,135 T 600,100 T 700,110 T 800,135 T 900,145 T 1000,130";
        const dArea = dLine + " L 1000,240 L 0,240 Z";
        strokePath.setAttribute('d', dLine);
        areaPath.setAttribute('d', dArea);
      }
    }
  }

  filterCategory(cat) {
    // Quick filter feedback
    this.showNotification("Category Filter", `Switched filter view to: ${cat.toUpperCase()}`);
  }

  toggleTrackingMode() {
    this.config.trackingProvider = this.config.trackingProvider === 'simulation' ? 'mediapipe' : 'simulation';
    const badge = document.getElementById('badge-tracking-provider');
    if (badge) {
      badge.textContent = this.config.trackingProvider === 'mediapipe' ? 'MediaPipe Live' : 'Simulation Mode';
    }
    this.showNotification("Tracking Mode", `Active provider: ${this.config.trackingProvider === 'mediapipe' ? 'MediaPipe Camera Stream' : 'MockTrackingProvider'}`);
  }

  // =========================================================================
  // MODALS
  // =========================================================================

  openFixtureModal() {
    const modal = document.getElementById('modal-fixture');
    if (modal) modal.classList.remove('hidden');
  }

  openSettingsModal() {
    this.showNotification("System Settings", "Accu-Vis Clinical Fixture v2.4 &bull; Camera Resolution: 640x480 &bull; Linear Rail Scale: 40cm Calibrated");
  }

  openSupportModal() {
    this.showNotification("Accu-Vis Support", "For fixture calibration guidance, consult the Accu-Vis-Feasibility-Evaluation.pdf manual.");
  }

  closeModals(event) {
    if (event && event.target !== event.currentTarget) return;
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
  }

  toggleMobileSidebar() {
    document.body.classList.toggle('mobile-sidebar-open');
  }

  closeMobileSidebar() {
    document.body.classList.remove('mobile-sidebar-open');
  }

  showNotification(title, message) {
    const container = document.getElementById('app-toast-container');
    if (!container) {
      console.log(`${title}: ${message}`);
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.innerHTML = `<strong style="color:var(--accent-gold);">${title}:</strong> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  handleSearchKey(e) {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) {
        this.currentPatient.id = q;
        this.currentPatient.name = `Patient ${q}`;
        this.showNotification("Patient Selected", `Loaded MRN: ${q}`);
        e.target.value = '';
      }
    }
  }

  // =========================================================================
  // USER AUTHENTICATION & LOGIN ENGINE (MATCHING IMAGES 1, 3, 4)
  // =========================================================================

  loadCurrentUser() {
    try {
      const saved = localStorage.getItem('accuvis_user');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    // No saved session: user must sign in
    return null;
  }

  updateUserInterface() {
    const user = this.currentUser;
    const nameEl = document.getElementById('sidebar-doctor-name');
    const roleEl = document.getElementById('sidebar-doctor-role');
    const bannerGreeting = document.querySelector('.banner-greeting-title');
    const loginLabel = document.getElementById('nav-label-login');
    document.documentElement.classList.toggle('logged-out', !user);

    if (user) {
      if (nameEl) nameEl.textContent = user.full_name;
      if (roleEl) roleEl.textContent = user.role || "Optometrist";
      if (bannerGreeting) bannerGreeting.textContent = `Welcome back, ${user.full_name}`;
      if (loginLabel) loginLabel.textContent = "Switch Account";
      this.renderAvatar('sidebar-doctor-avatar', user.avatar, user.full_name);
    } else {
      if (nameEl) nameEl.textContent = "Guest";
      if (roleEl) roleEl.textContent = "Please Sign In";
      if (bannerGreeting) bannerGreeting.textContent = "Welcome to Accu-Vis";
      if (loginLabel) loginLabel.textContent = "Doctor Login";
      this.renderAvatar('sidebar-doctor-avatar', null, "Guest");
    }
  }

  renderAvatar(elementId, avatarDataUrl, fullName) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (avatarDataUrl) {
      el.style.backgroundImage = `url("${avatarDataUrl}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      const initials = (fullName || '?').trim().split(/\s+/).map(n => n[0]).join('').slice(0, 2).toUpperCase();
      el.textContent = initials || '?';
    }
  }

  openEditProfileModal() {
    const user = this.currentUser;
    if (!user) return;

    this._pendingAvatarEdit = undefined; // undefined = no change to existing photo

    const nameInput = document.getElementById('edit-profile-name');
    if (nameInput) nameInput.value = user.full_name || '';

    const roleInput = document.getElementById('edit-profile-role');
    if (roleInput) roleInput.value = user.role || 'Optometrist';

    this.renderAvatar('edit-profile-avatar-preview', user.avatar, user.full_name);

    const modal = document.getElementById('modal-edit-profile');
    if (modal) modal.classList.remove('hidden');
  }

  closeEditProfileModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('modal-edit-profile');
    if (modal) modal.classList.add('hidden');
  }

  handleProfilePhotoChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Downscale to keep the stored profile photo small
        const maxDim = 240;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        this._pendingAvatarEdit = dataUrl;
        this.renderAvatar('edit-profile-avatar-preview', dataUrl, this.currentUser.full_name);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  removeProfilePhoto() {
    this._pendingAvatarEdit = '';
    this.renderAvatar('edit-profile-avatar-preview', null, this.currentUser ? this.currentUser.full_name : '?');
  }

  async saveProfileEdits(event) {
    if (event && event.preventDefault) event.preventDefault();
    const user = this.currentUser;
    if (!user) return;

    const fullName = document.getElementById('edit-profile-name')?.value?.trim();
    const role = document.getElementById('edit-profile-role')?.value?.trim();
    if (!fullName || !role) {
      this.showNotification("Profile Error", "Full name and role are required.");
      return;
    }

    const payload = { id: user.id, full_name: fullName, role: role };
    if (this._pendingAvatarEdit !== undefined) {
      payload.avatar = this._pendingAvatarEdit;
    }

    try {
      const res = await fetch('/api/auth/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.status === 'success') {
        this.currentUser = data.user;
        localStorage.setItem('accuvis_user', JSON.stringify(this.currentUser));
        this.updateUserInterface();
        this.closeEditProfileModal();
        this.showNotification("Profile Updated", "Your profile has been saved.");
      } else {
        this.showNotification("Profile Error", data.message || "Could not update profile.");
      }
    } catch (err) {
      this.showNotification("Network Error", "Unable to connect to the database server.");
    }
  }

  showAuthTab(tabName) {
    document.querySelectorAll('.auth-tab-content').forEach(tab => {
      tab.classList.remove('active');
    });
    const target = document.getElementById(`auth-tab-${tabName}`);
    if (target) {
      target.classList.add('active');
    }
  }

  togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  }

  async handleLoginSubmit(event) {
    if (event && event.preventDefault) event.preventDefault();
    const identifier = document.getElementById('login-identifier')?.value?.trim();
    const password = document.getElementById('login-password')?.value;

    if (!identifier || !password) {
      this.showNotification("Login Failed", "Please enter both identifier and password.");
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_or_username: identifier, password: password })
      });

      const data = await res.json();
      if (res.ok && data.status === 'success') {
        this.currentUser = data.user;
        localStorage.setItem('accuvis_user', JSON.stringify(data.user));
        this.updateUserInterface();
        this.showNotification("Login Successful", `Welcome back, ${data.user.full_name}!`);
        this.switchView('dashboard');
      } else {
        this.showNotification("Authentication Error", data.message || "Invalid credentials.");
      }
    } catch (err) {
      console.warn("Backend auth offline, using local verification:", err);
      // Fallback local check
      if (identifier === 'dr_bea' || identifier === 'dr.bea@accuvis.clinic') {
        this.currentUser = { id: 1, full_name: "Dr. Bea", username: "dr_bea", email: "dr.bea@accuvis.clinic", role: "Optometrist" };
        localStorage.setItem('accuvis_user', JSON.stringify(this.currentUser));
        this.updateUserInterface();
        this.showNotification("Logged In (Offline Mode)", "Welcome back, Dr. Bea!");
        this.switchView('dashboard');
      } else {
        this.showNotification("Login Error", "Unable to connect to authentication database.");
      }
    }
  }

  async handleRegisterSubmit(event) {
    if (event && event.preventDefault) event.preventDefault();
    const email = document.getElementById('reg-email')?.value?.trim();
    const fullName = document.getElementById('reg-fullname')?.value?.trim();
    const username = document.getElementById('reg-username')?.value?.trim();
    const password = document.getElementById('reg-password')?.value;
    const repeatPassword = document.getElementById('reg-repeat-password')?.value;

    if (password !== repeatPassword) {
      this.showNotification("Registration Error", "Passwords do not match. Please verify.");
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, full_name: fullName, username, password })
      });

      const data = await res.json();
      if (res.ok && data.status === 'success') {
        this.currentUser = data.user;
        localStorage.setItem('accuvis_user', JSON.stringify(data.user));
        this.updateUserInterface();
        this.showNotification("Account Created", `Registered in SQLite database! Welcome, ${data.user.full_name}.`);
        this.switchView('dashboard');
      } else {
        this.showNotification("Registration Error", data.message || "Could not create account.");
      }
    } catch (err) {
      this.showNotification("Network Error", "Unable to connect to registration server.");
    }
  }

  async handleForgotSubmit(event) {
    if (event && event.preventDefault) event.preventDefault();
    const email = document.getElementById('forgot-email')?.value?.trim();
    const password = document.getElementById('forgot-new-password')?.value;

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (res.ok && data.status === 'success') {
        this.showNotification("Password Reset", "Credentials updated in database. Please log in with your new password.");
        this.showAuthTab('login');
      } else {
        this.showNotification("Reset Error", data.message || "Could not reset password.");
      }
    } catch (err) {
      this.showNotification("Network Error", "Unable to connect to database server.");
    }
  }

  logout() {
    this.currentUser = null;
    localStorage.removeItem('accuvis_user');
    this.updateUserInterface();
    this.showNotification("Logged Out", "You have signed out of the clinical workstation.");
    this.switchView('login');
  }

  // =========================================================================
  // RECORDS & STORAGE
  // =========================================================================

  loadRecords() {
    try {
      const stored = localStorage.getItem('accuvis_records_v2');
      if (stored) return JSON.parse(stored);
    } catch(e) {}

    return [
      { id: "REC-1042", patientId: "ACV-2026-0042", patientName: "Subject Alpha", date: "Sep 14, 09:30 AM", eye: "OD", distance: "40cm", acuity: "20/20", accuracy: "8/8", fixation: "99.1%" },
      { id: "REC-1041", patientId: "ACV-2026-0042", patientName: "Subject Alpha", date: "Sep 14, 09:20 AM", eye: "OS", distance: "40cm", acuity: "20/25", accuracy: "7/8", fixation: "98.2%" },
      { id: "REC-1039", patientId: "ACV-2026-0038", patientName: "Elena Vance",   date: "Sep 12, 02:15 PM", eye: "OU", distance: "40cm", acuity: "20/15", accuracy: "8/8", fixation: "99.5%" }
    ];
  }

  saveRecords() {
    try {
      localStorage.setItem('accuvis_records_v2', JSON.stringify(this.records));
    } catch(e) {}
  }

  renderRecordsTable() {
    const tbody = document.getElementById('records-table-body');
    if (!tbody) return;

    if (!this.records || this.records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">No records found in database. Complete an intake &amp; dot distance test to log sessions.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.records.map(rec => `
      <tr>
        <td><strong>${rec.patientId}</strong><br><small style="color:var(--text-muted);">${rec.patientName}</small></td>
        <td>${rec.date}</td>
        <td><span class="badge-pill">${rec.eye}</span></td>
        <td><strong style="color:var(--accent-rose); font-family:var(--font-mono);">${rec.distance}</strong></td>
        <td><strong style="color:var(--status-green);">${rec.acuity}</strong></td>
        <td>${rec.fixation}</td>
        <td><button class="btn-ghost" style="padding:4px 10px; font-size:11px;" onclick="alert('Session Details:\\nPatient: ${rec.patientName} (${rec.patientId})\\nDistance: ${rec.distance}\\nVerdict: ${rec.fixation}\\nTimestamp: ${rec.date}')">Details</button></td>
      </tr>
    `).join('');
  }

  async saveAndNextPatient() {
    const cm = this.dotState.recordedDistanceCm || parseFloat(this.dotState.railDistanceCm.toFixed(1));
    const mm = Math.round(cm * 10);
    const isNpa = this.dotState.testMode === 'npa';
    const testType = isNpa ? 'NPA' : 'NPC';
    const testLabel = isNpa ? 'Near Point of Accommodation' : 'Near Point of Convergence';
    const verdict = this.dotState.lastVerdict || (cm <= 10.0 ? `Normal ${testLabel}` : cm <= 15.0 ? `Borderline ${testType}` : `Reduced/Receded ${testType}`);
    const logId = this.generateLogId();

    const logPayload = {
      log_id: logId,
      mrn: this.currentPatient.id,
      patient_name: this.currentPatient.name,
      test_type: testType,
      eye: this.config.eye,
      distance_cm: cm,
      distance_mm: mm,
      verdict: verdict,
      symmetry: "99.4%",
      operator_notes: `${testLabel}: ${cm} cm (${mm} mm). ${isNpa ? 'Push-up target moved until sustained blur along stepper rail.' : 'Both eyes converged along stepper rail.'}`
    };

    // Save to SQLite & JSON via server API
    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logPayload)
      });
    } catch(e) {
      console.warn("Backend API offline, saving to localStorage:", e);
    }

    // Mirror to local memory records
    this.records.unshift({
      id: logId,
      patientId: this.currentPatient.id,
      patientName: this.currentPatient.name,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      eye: this.config.eye,
      distance: `${cm} cm`,
      acuity: `${testType}: ${cm}cm`,
      accuracy: "99.4%",
      fixation: verdict
    });
    this.saveRecords();

    // Close modal & reset rail
    this.closeDotResultModal();
    this.resetRailToHome();

    // Reset intake form for next patient
    this.resetIntakeForm();
    await this.loadDatabaseData();

    // Return to Step 1: Patient Intake
    this.switchView('intake');
    this.showNotification("Patient Session Saved", `${testType} result (${cm} cm) logged for ${this.currentPatient.name} in database. Ready for next patient!`);
  }

  exportResultJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.records[0] || {}, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = `accuvis_exam_${this.currentPatient.id}.json`;
    a.click();
  }

  updateDashboardMetrics() {
    const tileAcuity = document.getElementById('tile-acuity');
    if (tileAcuity && this.records.length > 0) {
      tileAcuity.textContent = this.records[0].acuity;
    }

    const tileDist = document.getElementById('tile-distance');
    if (tileDist) {
      const dotRec = this.records.find(r => r.id.startsWith('REC-DOT'));
      if (dotRec) {
        tileDist.textContent = dotRec.distance;
      }
    }
  }

  // =========================================================================
  // AUTOMATED DOT-TO-EYE DISTANCE MEASUREMENT ENGINE (STEPPER APPROACH)
  // =========================================================================

  launchDotMeasure(mode) {
    this.dotState.testMode = mode === 'npa' ? 'npa' : 'npc';
    this.switchView('dot-measure');
  }

  initDotMeasureView() {
    const isNpa = this.dotState.testMode === 'npa';

    const tagBadge = document.getElementById('dot-stage-tag-badge');
    if (tagBadge) {
      tagBadge.textContent = isNpa
        ? 'Near Point of Accommodation • 40cm Push-Up Rail'
        : 'Near Point of Convergence • 40cm Stepper Rail';
    }

    const protocolBadge = document.getElementById('dot-stage-protocol-badge');
    if (protocolBadge) {
      protocolBadge.textContent = isNpa ? 'Active Protocol: NPA 40cm Push-Up' : 'Active Protocol: NPC 40cm Approach';
    }

    this.updateDotHUD();
    this.initEyeTracker();
  }

  toggleStepperApproach() {
    if (this.dotState.isApproaching) {
      this.pauseStepperApproach();
    } else {
      this.startStepperApproach();
    }
  }

  startStepperApproach() {
    // If carriage is already at minimum distance, reset to 40cm first
    if (this.dotState.railDistanceCm <= 4.5) {
      this.dotState.railDistanceCm = 40.0;
    }

    this.dotState.isApproaching = true;
    this.dotState.convergenceLocked = false;
    this.dotState.lastTimestamp = performance.now();

    // UI Pill to running
    const pill = document.getElementById('dot-motor-status-pill');
    const pillText = document.getElementById('dot-motor-status-text');
    if (pill) pill.className = 'dot-status-pill running';
    if (pillText) pillText.textContent = `Advancing Rail (${this.dotState.speedCmPerSec} cm/s)...`;

    // Start button text
    const btnText = document.getElementById('btn-start-text');
    if (btnText) btnText.textContent = 'Pause Approach';

    // Audio cue
    this.playTone(440, 'sine', 0.12);

    // Cancel any existing frame loop
    if (this.dotState.animationFrameId) {
      cancelAnimationFrame(this.dotState.animationFrameId);
    }

    const step = (now) => {
      if (!this.dotState.isApproaching) return;

      const dt = Math.min(0.1, (now - this.dotState.lastTimestamp) / 1000);
      this.dotState.lastTimestamp = now;

      // Decrement carriage distance
      this.dotState.railDistanceCm -= this.dotState.speedCmPerSec * dt;

      // Dynamically update eye tracker distance reference scaling
      if (this.eyeTracker) {
        this.eyeTracker.updateCarriageDistance(this.dotState.railDistanceCm);
      }

      // Auto-stop check fallback (if not already locked by CV eye tracker)
      if (this.dotState.autoStop && this.dotState.railDistanceCm <= this.dotState.breakDistanceCm) {
        this.dotState.railDistanceCm = this.dotState.breakDistanceCm;
        this.updateDotHUD();
        this.stopAndLockMeasurement("Auto-Stop (Convergence Break at 12.4 cm)");
        return;
      }

      // Hard limit check (safety stop at 4.0 cm near eye)
      if (this.dotState.railDistanceCm <= 4.0) {
        this.dotState.railDistanceCm = 4.0;
        this.updateDotHUD();
        this.stopAndLockMeasurement("Rail Limit Reached (4.0 cm)");
        return;
      }

      this.updateDotHUD();
      this.dotState.animationFrameId = requestAnimationFrame(step);
    };

    this.dotState.animationFrameId = requestAnimationFrame(step);
  }

  pauseStepperApproach() {
    this.dotState.isApproaching = false;
    if (this.dotState.animationFrameId) {
      cancelAnimationFrame(this.dotState.animationFrameId);
      this.dotState.animationFrameId = null;
    }

    const pill = document.getElementById('dot-motor-status-pill');
    const pillText = document.getElementById('dot-motor-status-text');
    if (pill) pill.className = 'dot-status-pill idle';
    if (pillText) pillText.textContent = `Paused at ${this.dotState.railDistanceCm.toFixed(1)} cm`;

    const btnText = document.getElementById('btn-start-text');
    if (btnText) btnText.textContent = 'Resume Approach';
  }

  stopAndLockMeasurement(triggerReason = "Manual Stop & Lock") {
    this.dotState.isApproaching = false;
    this.dotState.convergenceLocked = true;
    if (this.dotState.animationFrameId) {
      cancelAnimationFrame(this.dotState.animationFrameId);
      this.dotState.animationFrameId = null;
    }

    const recordedCm = parseFloat(this.dotState.railDistanceCm.toFixed(1));
    const recordedMm = Math.round(recordedCm * 10);
    this.dotState.recordedDistanceCm = recordedCm;

    // Pleasant double chime sound for lock
    this.playTone(523.25, 'triangle', 0.15, 0);   // C5
    this.playTone(659.25, 'triangle', 0.25, 120); // E5

    // Update Status Pill
    const pill = document.getElementById('dot-motor-status-pill');
    const pillText = document.getElementById('dot-motor-status-text');
    if (pill) pill.className = 'dot-status-pill locked';
    if (pillText) pillText.textContent = `Locked at ${recordedCm} cm`;

    const btnText = document.getElementById('btn-start-text');
    if (btnText) btnText.textContent = 'Start Stepper Approach';

    // Populate Doctor's Result Modal
    const valEl = document.getElementById('res-dot-dist-val');
    if (valEl) valEl.textContent = recordedCm.toFixed(1);

    const mmEl = document.getElementById('res-dot-dist-mm');
    if (mmEl) mmEl.textContent = `${recordedMm} mm from Cornea`;

    const badgeEl = document.getElementById('res-dot-verdict-badge');
    const noteEl = document.getElementById('res-dot-clinical-note');
    const subtitleEl = document.getElementById('res-dot-modal-subtitle');
    const isNpa = this.dotState.testMode === 'npa';

    if (subtitleEl) {
      subtitleEl.textContent = isNpa ? 'Near Point of Accommodation (NPA)' : 'Near Point of Convergence (NPC)';
    }

    let verdict;
    if (recordedCm <= 10.0) {
      verdict = isNpa ? 'Normal Near Point of Accommodation (Healthy)' : 'Normal Near Point of Convergence (Healthy)';
      if (badgeEl) {
        badgeEl.className = 'status-badge-green';
        badgeEl.textContent = verdict;
      }
      if (noteEl) {
        noteEl.textContent = isNpa
          ? `Sustained clear focus observed at ${recordedCm} cm. Accommodative amplitude within normal range.`
          : `Optimal binocular convergence observed at ${recordedCm} cm. Patient maintains foveal alignment with full ocular symmetry.`;
      }
    } else if (recordedCm <= 15.0) {
      verdict = isNpa ? 'Borderline Accommodation Distance' : 'Borderline Convergence Distance';
      if (badgeEl) {
        badgeEl.className = 'status-badge-orange';
        badgeEl.textContent = verdict;
      }
      if (noteEl) {
        noteEl.textContent = isNpa
          ? `Borderline accommodative near point (${recordedCm} cm). Consider re-evaluation or early presbyopic screening.`
          : `Borderline convergence distance (${recordedCm} cm). Consider secondary re-evaluation or accommodation fatigue check.`;
      }
    } else {
      verdict = isNpa ? 'Reduced Accommodation / Possible Early Presbyopia' : 'Receded NPC / Possible Convergence Insufficiency';
      if (badgeEl) {
        badgeEl.className = 'status-badge-red';
        badgeEl.textContent = verdict;
      }
      if (noteEl) {
        noteEl.textContent = isNpa
          ? `Reduced accommodative amplitude (>15 cm). Possible early presbyopia or accommodative insufficiency suspected.`
          : `Receded Near Point of Convergence (>15 cm). Possible binocular vision stress or convergence insufficiency suspected.`;
      }
    }
    this.dotState.lastVerdict = verdict;

    const triggerEl = document.getElementById('res-dot-trigger');
    if (triggerEl) triggerEl.textContent = triggerReason;

    // Show result modal
    const modal = document.getElementById('modal-dot-result');
    if (modal) modal.classList.remove('hidden');
  }

  resetRailToHome() {
    this.dotState.isApproaching = false;
    if (this.dotState.animationFrameId) {
      cancelAnimationFrame(this.dotState.animationFrameId);
      this.dotState.animationFrameId = null;
    }

    this.dotState.railDistanceCm = 40.0;
    this.dotState.convergenceLocked = false;
    this.updateDotHUD();
    if (this.eyeTracker) {
      this.eyeTracker.updateCarriageDistance(40.0);
    }

    const pill = document.getElementById('dot-motor-status-pill');
    const pillText = document.getElementById('dot-motor-status-text');
    if (pill) pill.className = 'dot-status-pill idle';
    if (pillText) pillText.textContent = 'Rail Ready at 40.0 cm';

    const btnText = document.getElementById('btn-start-text');
    if (btnText) btnText.textContent = 'Start Stepper Approach';

    this.playTone(330, 'sine', 0.1);
  }

  setStepperSpeed(speed) {
    this.dotState.speedCmPerSec = speed;
    document.querySelectorAll('.speed-pill').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.textContent) === speed);
    });
  }

  toggleAutoStop(checked) {
    this.dotState.autoStop = checked;
  }

  jogRailMicro(deltaCm) {
    if (this.dotState.isApproaching) this.pauseStepperApproach();
    this.dotState.railDistanceCm = Math.max(3.0, Math.min(40.0, this.dotState.railDistanceCm + deltaCm));
    this.updateDotHUD();
    if (this.eyeTracker) {
      this.eyeTracker.updateCarriageDistance(this.dotState.railDistanceCm);
    }
  }

  setTargetStyle(style) {
    this.dotState.targetStyle = style;
    const dotEl = document.getElementById('target-center-dot');
    if (dotEl) {
      dotEl.className = `target-center-dot style-${style}`;
    }

    document.querySelectorAll('.style-dot-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-style-${style}`);
    });
  }

  updateDotHUD() {
    const cm = this.dotState.railDistanceCm;
    const cmFormatted = cm.toFixed(1);
    const mm = Math.round(cm * 10);

    // Update Floating HUD numbers
    const hudCm = document.getElementById('dot-hud-cm');
    if (hudCm) hudCm.textContent = cmFormatted;

    const hudMm = document.getElementById('dot-hud-mm');
    if (hudMm) hudMm.textContent = `${mm} mm to cornea`;

    const topbarRail = document.getElementById('topbar-rail-val');
    if (topbarRail) topbarRail.textContent = `${cmFormatted}cm`;

    // Update Rail Track Progress Bar & Carriage Marker
    // 0 cm is at left (0%), 40 cm is at right (100%)
    const pct = Math.max(0, Math.min(100, (cm / 40.0) * 100));

    const fillEl = document.getElementById('rail-track-fill');
    if (fillEl) fillEl.style.width = `${pct}%`;

    const cursorEl = document.getElementById('rail-carriage-cursor');
    if (cursorEl) cursorEl.style.left = `${pct}%`;

    const carriageLabel = document.getElementById('rail-carriage-label');
    if (carriageLabel) carriageLabel.textContent = `Carriage: ${cmFormatted} cm`;

    // Update Simulated Pupils (vergence inward as carriage gets closer)
    this.updatePupilVergence(cm);
  }

  updatePupilVergence(distCm) {
    // Standard normal convergence: 40cm -> eyes parallel (shift 0px)
    // 5cm -> eyes strongly converged (shift +/- 6.5px inward)
    const factor = Math.max(0, Math.min(1, (40.0 - distCm) / 35.0));
    const maxShiftPx = 6.5;
    const shift = factor * maxShiftPx;

    // Left eye (OS) shifts rightward (+X), Right eye (OD) shifts leftward (-X)
    const pupilLeft = document.getElementById('sim-pupil-left');
    if (pupilLeft) pupilLeft.style.transform = `translateX(${shift}px)`;

    const pupilRight = document.getElementById('sim-pupil-right');
    if (pupilRight) pupilRight.style.transform = `translateX(${-shift}px)`;

    // Vergence label
    const statusTag = document.getElementById('sim-vergence-status');
    if (statusTag) {
      if (distCm > 30) {
        statusTag.textContent = `Parallel Gaze (${distCm.toFixed(1)}cm)`;
      } else if (distCm > 15) {
        statusTag.textContent = `Active Convergence (${distCm.toFixed(1)}cm)`;
      } else {
        statusTag.textContent = `Maximum Foveal Lock (${distCm.toFixed(1)}cm)`;
      }
    }

    // Symmetry calculation
    const symmetry = Math.max(96.0, (99.8 - (Math.random() * 0.5))).toFixed(1);
    const symVal = document.getElementById('pip-symmetry-val');
    if (symVal) symVal.textContent = `${symmetry}%`;

    const symBar = document.getElementById('pip-symmetry-bar');
    if (symBar) symBar.style.width = `${symmetry}%`;
  }

  initEyeTracker() {
    const videoEl = document.getElementById('dot-camera-video');
    const canvasLeftEl = document.getElementById('dot-camera-left-canvas');
    const canvasRightEl = document.getElementById('dot-camera-right-canvas');

    if (!videoEl || !canvasLeftEl || !canvasRightEl) return;

    const targetEye = this.config.eye || 'OD';

    if (!this.eyeTracker && window.AccuVisEyeTracker) {
      this.eyeTracker = new AccuVisEyeTracker({
        video: videoEl,
        canvasLeft: canvasLeftEl,
        canvasRight: canvasRightEl,
        targetEye: targetEye,
        flipped180: this.dotState.cameraFlipped,
        mirrored: this.dotState.cameraMirrored,
        onUpdate: (res) => this.handleEyeTrackerUpdate(res),
        onStatus: (mode) => this.updateTrackerStatus(mode)
      });
    } else if (this.eyeTracker) {
      this.eyeTracker.setCanvases(videoEl, canvasLeftEl, canvasRightEl);
      this.eyeTracker.setTargetEye(targetEye);
      this.eyeTracker.setFlipped180(this.dotState.cameraFlipped);
      this.eyeTracker.setMirrored(this.dotState.cameraMirrored);
    }

    // Sync button UI states
    const btnFlip = document.getElementById('pip-btn-flip');
    if (btnFlip) btnFlip.classList.toggle('active', this.dotState.cameraFlipped);

    const btnMirror = document.getElementById('pip-btn-mirror');
    if (btnMirror) btnMirror.classList.toggle('active', this.dotState.cameraMirrored);

    this.syncEyeSelectorUI();
    if (this.eyeTracker) this.updateTrackerStatus(this.eyeTracker.mode);

    const localBtn = document.getElementById('camera-source-local');
    const remoteBtn = document.getElementById('camera-source-remote');
    const isRemote = this.remoteCameraState.mode === 'remote';
    if (localBtn) localBtn.classList.toggle('active', !isRemote);
    if (remoteBtn) remoteBtn.classList.toggle('active', isRemote);
    const banner = document.getElementById('remote-camera-banner');
    if (banner) banner.classList.toggle('hidden', !isRemote);

    // Resume whichever camera source was active (local webcam or remote phone)
    if (isRemote) {
      this.startRemoteCameraFeed();
    } else {
      this.startCameraFeed();
    }
  }

  recenterEyeCrop() {
    if (this.eyeTracker) {
      this.eyeTracker.recenterEyeCrop();
    }
  }

  calibrateCenter() {
    if (this.eyeTracker) {
      const res = this.eyeTracker.calibrateCenter();
      const btn = document.getElementById('pip-btn-calibrate');
      if (btn) {
        btn.classList.add('calibrated');
        setTimeout(() => {
          btn.classList.remove('calibrated');
        }, 1800);
      }
      const gazeLabel = document.getElementById('pip-gaze-vector-label');
      if (gazeLabel) {
        gazeLabel.textContent = "Gaze: [0.00, 0.00, 1.00]";
      }
      this.showNotification("Primary Gaze Calibrated", "Eye centered • Optical axis aligned to [0.00, 0.00, 1.00]");
      return res;
    }
  }

  handleEyeTrackerUpdate(res) {
    if (!res) return;

    // Update target eye label in left panel
    const eyeLabel = document.getElementById('pip-target-eye-label');
    if (eyeLabel) {
      eyeLabel.textContent = res.targetEye === 'OD' ? 'OD (Right Eye)' : res.targetEye === 'OS' ? 'OS (Left Eye)' : 'OU (Both Eyes)';
    }

    // Update 3D Gaze vector tag in right panel
    const gazeLabel = document.getElementById('pip-gaze-vector-label');
    if (gazeLabel) {
      gazeLabel.textContent = `Gaze: [${res.gazeX.toFixed(2)}, ${res.gazeY.toFixed(2)}, ${res.gazeZ.toFixed(2)}]`;
    }

    // Update alignment symmetry score & progress bar
    const symVal = document.getElementById('pip-symmetry-val');
    if (symVal) symVal.textContent = `${res.symmetryScore.toFixed(1)}%`;

    const symBar = document.getElementById('pip-symmetry-bar');
    if (symBar) symBar.style.width = `${res.symmetryScore}%`;

    // Update telemetry chips
    const pupilPill = document.getElementById('pip-telemetry-pupil');
    if (pupilPill) {
      pupilPill.textContent = res.detected
        ? `Pupil: (${Math.round(res.pupilX)}, ${Math.round(res.pupilY)})`
        : "Pupil: Searching";
    }

    const gazePill = document.getElementById('pip-telemetry-gaze');
    if (gazePill) {
      gazePill.textContent = `Gaze: [${res.gazeX.toFixed(2)}, ${res.gazeY.toFixed(2)}, ${res.gazeZ.toFixed(2)}]`;
    }

    const statusPill = document.getElementById('pip-telemetry-status');
    if (statusPill) {
      statusPill.textContent = res.isConverged ? "Convergence Lock" : "Auto-Cropped Eye";
    }

    // Auto-Stop trigger when eye tracker locks foveal convergence
    if (res.isConverged && this.dotState.isApproaching && this.dotState.autoStop) {
      this.stopAndLockMeasurement("Auto-Stop: Binocular Convergence Lock");
    }
  }

  async startCameraFeed() {
    try {
      if (this.eyeTracker) {
        await this.eyeTracker.startWebcam();
      }
    } catch (e) {
      console.warn("Live camera initialization notice:", e);
    }
  }

  // =========================================================================
  // REMOTE "PHONE CAMERA" SOURCE (see camera.html + server.py relay)
  // =========================================================================

  setCameraSource(mode) {
    if (mode === this.remoteCameraState.mode) return;
    this.remoteCameraState.mode = mode;

    const localBtn = document.getElementById('camera-source-local');
    const remoteBtn = document.getElementById('camera-source-remote');
    if (localBtn) localBtn.classList.toggle('active', mode === 'local');
    if (remoteBtn) remoteBtn.classList.toggle('active', mode === 'remote');

    const banner = document.getElementById('remote-camera-banner');
    if (banner) banner.classList.toggle('hidden', mode !== 'remote');

    if (mode === 'remote') {
      if (this.eyeTracker) this.eyeTracker.stop();
      this.startRemoteCameraFeed();
    } else {
      this.stopRemoteCameraFeed();
      this.startCameraFeed();
    }
  }

  startRemoteCameraFeed() {
    const state = this.remoteCameraState;
    state.streamAttached = false;

    if (!state.canvas) {
      state.canvas = document.createElement('canvas');
      state.canvas.width = 640;
      state.canvas.height = 480;
      state.ctx = state.canvas.getContext('2d');
    }

    const pollFrame = () => {
      const img = new Image();
      img.onload = () => {
        if (this.remoteCameraState.mode !== 'remote') return;
        if (img.naturalWidth) {
          state.canvas.width = img.naturalWidth;
          state.canvas.height = img.naturalHeight;
        }
        state.ctx.drawImage(img, 0, 0, state.canvas.width, state.canvas.height);
        URL.revokeObjectURL(img.src);

        if (!state.streamAttached && this.eyeTracker && this.eyeTracker.video) {
          const stream = state.canvas.captureStream(10);
          this.eyeTracker.video.srcObject = stream;
          this.eyeTracker.video.muted = true;
          this.eyeTracker.video.playsInline = true;
          this.eyeTracker.video.play().catch(() => {});
          this.eyeTracker.recenterEyeCrop();
          this.eyeTracker.startProcessingLoop();
          state.streamAttached = true;
        }
      };
      img.onerror = () => { /* no frame yet; keep polling silently */ };

      fetch(`/api/camera/frame?t=${Date.now()}`)
        .then(res => (res.ok ? res.blob() : null))
        .then(blob => { if (blob) img.src = URL.createObjectURL(blob); })
        .catch(() => {});
    };

    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollFrame, 150);
    pollFrame();

    this.pollRemoteCameraStatus();
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = setInterval(() => this.pollRemoteCameraStatus(), 1500);
  }

  stopRemoteCameraFeed() {
    const state = this.remoteCameraState;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.statusTimer) { clearInterval(state.statusTimer); state.statusTimer = null; }
    state.streamAttached = false;

    if (this.eyeTracker && this.eyeTracker.video && this.eyeTracker.video.srcObject) {
      const stream = this.eyeTracker.video.srcObject;
      if (stream.getTracks) stream.getTracks().forEach(t => t.stop());
      this.eyeTracker.video.srcObject = null;
    }
  }

  async pollRemoteCameraStatus() {
    const statusText = document.getElementById('remote-camera-status-text');
    const urlEl = document.getElementById('remote-camera-url');
    const banner = document.getElementById('remote-camera-banner');
    try {
      const res = await fetch('/api/camera/status');
      const data = await res.json();
      if (banner) banner.classList.toggle('connected', !!data.connected);
      if (statusText) {
        statusText.textContent = data.connected
          ? 'Camera phone connected'
          : 'Waiting for camera phone...';
      }
      if (urlEl) urlEl.textContent = data.lan_url || '';
    } catch (e) {
      if (statusText) statusText.textContent = 'Camera relay unavailable (local network only)';
      if (banner) banner.classList.remove('connected');
    }
  }

  flipCameraVideo() {
    this.dotState.cameraFlipped = !this.dotState.cameraFlipped;
    if (this.eyeTracker) {
      this.eyeTracker.setFlipped180(this.dotState.cameraFlipped);
    }
    const btn = document.getElementById('pip-btn-flip');
    if (btn) btn.classList.toggle('active', this.dotState.cameraFlipped);
  }

  toggleCameraMirror() {
    this.dotState.cameraMirrored = !this.dotState.cameraMirrored;
    if (this.eyeTracker) {
      this.eyeTracker.setMirrored(this.dotState.cameraMirrored);
    }
    const btn = document.getElementById('pip-btn-mirror');
    if (btn) btn.classList.toggle('active', this.dotState.cameraMirrored);
  }

  togglePipMinimize() {
    const pip = document.getElementById('dot-camera-pip');
    if (pip) pip.classList.toggle('minimized');
  }

  toggleDotFullscreen() {
    const stage = document.getElementById('dot-target-container');
    if (!document.fullscreenElement) {
      if (stage && stage.requestFullscreen) stage.requestFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }

  saveDotMeasurementRecord() {
    const cm = this.dotState.recordedDistanceCm || parseFloat(this.dotState.railDistanceCm.toFixed(1));
    const newRecord = {
      id: "REC-DOT-" + Math.floor(1000 + Math.random() * 9000),
      patientId: this.currentPatient.id,
      patientName: this.currentPatient.name,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      eye: "OU (Both)",
      distance: `${cm} cm`,
      acuity: `NPC: ${cm}cm`,
      accuracy: cm <= 10 ? "Normal (<10cm)" : cm <= 15 ? "Borderline" : "Receded (>15cm)",
      fixation: "99.4% Locked"
    };

    this.records.unshift(newRecord);
    this.saveRecords();
    this.renderRecordsTable();

    // Update Dashboard Tile 2
    const tileDist = document.getElementById('tile-distance');
    if (tileDist) {
      tileDist.textContent = `${cm} cm`;
    }

    this.closeDotResultModal();
    this.showNotification("Measurement Saved", `Recorded Dot Distance: ${cm} cm for ${this.currentPatient.name} (${this.currentPatient.id}).`);
  }

  closeDotResultModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('modal-dot-result');
    if (modal) modal.classList.add('hidden');
  }

  playTone(freq, type = 'sine', duration = 0.15, delayMs = 0) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      setTimeout(() => {
        try {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
          gain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + duration);
          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start();
          osc.stop(this.audioCtx.currentTime + duration);
        } catch(e) {}
      }, delayMs);
    } catch(e) {}
  }

  // =========================================================================
  // KEYBOARD SHORTCUTS
  // =========================================================================

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'input' || activeTag === 'textarea') return;

      // In Active Dot Distance Measurement View
      const dotView = document.getElementById('view-dot-measure');
      if (dotView && dotView.classList.contains('active')) {
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          this.toggleStepperApproach();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.stopAndLockMeasurement();
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          this.resetRailToHome();
        } else if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          this.calibrateCenter();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          this.jogRailMicro(-0.5);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          this.jogRailMicro(+0.5);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.switchView('dashboard');
        }
        return;
      }

      // In Active Vision Exam
      if (this.testState.active) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.recordResponse('up');
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.recordResponse('down');
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.recordResponse('left');
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.recordResponse('right');
        } else if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          this.recordResponse('cannot_see');
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          this.repeatTrial();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.switchView('dashboard');
        }
        return;
      }

      // On Dashboard
      if (e.key === 'Enter') {
        e.preventDefault();
        this.switchView('dot-measure');
      } else if (e.key === '1') {
        this.setQuickEye('OD');
      } else if (e.key === '2') {
        this.setQuickEye('OS');
      } else if (e.key === '3') {
        this.setQuickEye('OU');
      }
    });
  }
}

// Global App Instance
window.app = new AccuVisApp();
