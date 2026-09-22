/**
 * Accu-Vis Dual-Panel Real-Time Eye Tracker & 3D Eyeball Engine
 * 
 * Architecture:
 * - LEFT PANEL: Live Camera Auto-Cropped to Patient's Eye ONLY (Face & background removed)
 * - RIGHT PANEL: Real-Time 3D Eyeball Model rotating and pointing in 3D space (gl_sphere replica)
 * - 100% Live Camera Driven (Demo video removed)
 * - Adaptive Eye Localization with Damped EMA Smoothing
 * - High-Performance Canvas Computer Vision (Orlosky Moment Pupil Fitting)
 */

class AccuVisEyeTracker {
  constructor(options = {}) {
    this.video = options.video || null;
    this.canvasLeft = options.canvasLeft || null;   // Left: Live Eye Macro
    this.canvasRight = options.canvasRight || null; // Right: 3D Eyeball Model
    this.ctxLeft = this.canvasLeft ? this.canvasLeft.getContext('2d', { willReadFrequently: true }) : null;
    this.ctxRight = this.canvasRight ? this.canvasRight.getContext('2d') : null;

    // Internal low-res processing canvas for pupil fitting
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = 240;
    this.procCanvas.height = 180;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });

    // Internal full frame canvas for transformed video extraction
    this.frameCanvas = document.createElement('canvas');
    this.frameCanvas.width = 640;
    this.frameCanvas.height = 480;
    this.frameCtx = this.frameCanvas.getContext('2d', { willReadFrequently: true });

    // Tracking state & configuration
    this.isRunning = false;
    this.animationId = null;
    this.flipped180 = options.flipped180 || false;
    this.mirrored = options.mirrored || false;
    this.targetEye = options.targetEye || 'OD'; // 'OD' (Right), 'OS' (Left), 'OU' (Both)
    this.railDistanceCm = 40.0;

    // Dynamic Eye Crop Box (Smoothed with Exponential Moving Average)
    this.cropState = {
      initialized: false,
      x: 220,
      y: 140,
      w: 200,
      h: 150,
      targetX: 220,
      targetY: 140,
      targetW: 200,
      targetH: 150
    };

    // Tracking telemetry
    this.trackingResult = {
      detected: false,
      pupilX: 110,
      pupilY: 75,
      pupilRadius: 18,
      pupilAngle: 0,
      majorAxis: 20,
      minorAxis: 16,
      gazeX: 0.0,
      gazeY: 0.0,
      gazeZ: 1.0,
      symmetryScore: 99.2,
      confidence: 0.95,
      isConverged: false,
      targetEye: this.targetEye,
      fps: 30
    };

    // Center Calibration State (Primary Gaze Alignment & Ocular Centering)
    this.calibration = {
      isCalibrated: false,
      originX: null,
      originY: null,
      timestamp: 0
    };

    // Convergence stability history for auto-stop
    this.convergenceHistory = [];
    this.historyMaxLength = 20;

    // Callback
    this.onUpdate = options.onUpdate || null;
    this.onStatus = options.onStatus || null;

    // Face/iris landmark tracking (MediaPipe). mode: 'loading' | 'landmarks' | 'basic'
    this.mode = 'loading';
    this.landmarker = null;
    this.lastLandmarkTs = 0;
    this.landmarkErrors = 0;
    this.faceMissFrames = 0;
    this.eyes = null; // smoothed geometry per eye: 'A' = image-left eye, 'B' = image-right eye
    this.gazeBaseline = { A: { x: 0, y: 0 }, B: { x: 0, y: 0 } };
    this.smoothGaze = { A: { x: 0, y: 0 }, B: { x: 0, y: 0 } };
    this.hasLandmarkCrop = false;
    this.initLandmarker();

    // Start the render loop immediately so the 3D eye model is active from frame 1
    this.startProcessingLoop();
  }

  setCanvases(videoEl, canvasLeftEl, canvasRightEl) {
    this.video = videoEl;
    this.canvasLeft = canvasLeftEl;
    this.canvasRight = canvasRightEl;
    if (this.canvasLeft) this.ctxLeft = this.canvasLeft.getContext('2d', { willReadFrequently: true });
    if (this.canvasRight) this.ctxRight = this.canvasRight.getContext('2d');
    this.startProcessingLoop();
  }

  setTargetEye(eye) {
    this.targetEye = (eye === 'OS' || eye === 'OU') ? eye : 'OD';
    this.trackingResult.targetEye = this.targetEye;
    this.gazeBaseline = { A: { x: 0, y: 0 }, B: { x: 0, y: 0 } };
    this.smoothGaze = { A: { x: 0, y: 0 }, B: { x: 0, y: 0 } };
    this.calibration.isCalibrated = false;
    this.hasLandmarkCrop = false;
    this.recenterEyeCrop();
  }

  setFlipped180(enabled) {
    this.flipped180 = !!enabled;
    this.recenterEyeCrop();
  }

  setMirrored(enabled) {
    this.mirrored = !!enabled;
    this.recenterEyeCrop();
  }

  updateCarriageDistance(distCm) {
    this.railDistanceCm = Math.max(4.0, Math.min(40.0, distCm));
  }

  recenterEyeCrop() {
    this.cropState.initialized = false;
  }

  // ===========================================================================
  // FACE / IRIS LANDMARK TRACKING (replaces "darkest blob" guessing)
  // ===========================================================================

  setMode(mode) {
    this.mode = mode;
    this.trackingResult.mode = mode;
    if (this.onStatus) this.onStatus(mode);
  }

  async initLandmarker() {
    try {
      const base = new URL('vendor/mediapipe/', document.baseURI).href;
      const vision = await import(base + 'vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks(base + 'wasm');
      const create = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      });
      try {
        this.landmarker = await create('GPU');
      } catch (gpuErr) {
        this.landmarker = await create('CPU');
      }
      this.setMode('landmarks');
    } catch (err) {
      console.warn('Landmark tracker unavailable, using basic detection:', err);
      this.setMode('basic');
    }
  }

  // Which physical eye each landmark group is. Groups follow the IMAGE, not anatomy:
  // 'A' = eye on the image-left, 'B' = eye on the image-right. Unmirrored, the
  // patient's right eye (OD) is image-left; Mirror swaps them.
  keyForEye(eye) {
    const odKey = this.mirrored ? 'B' : 'A';
    const osKey = this.mirrored ? 'A' : 'B';
    return eye === 'OD' ? odKey : osKey;
  }

  selectedEyeKeys() {
    if (this.targetEye === 'OU') return ['A', 'B'];
    return [this.keyForEye(this.targetEye)];
  }

  eyeGeometry(lm, g, W, H) {
    const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
    const o = P(g.outer), n = P(g.inner), up = P(g.upper), lo = P(g.lower), c = P(g.iris[0]);
    const cx = (o.x + n.x) / 2;
    const cy = (o.y + n.y) / 2;
    const width = Math.max(1, Math.hypot(o.x - n.x, o.y - n.y));
    const open = Math.hypot(up.x - lo.x, up.y - lo.y) / width;

    let irisR = 0;
    for (let i = 1; i < g.iris.length; i++) {
      const p = P(g.iris[i]);
      irisR += Math.hypot(p.x - c.x, p.y - c.y);
    }
    irisR /= (g.iris.length - 1);

    // Eye axis (image-left corner -> image-right corner) so head tilt doesn't fake a gaze shift
    const left = o.x < n.x ? o : n;
    const right = o.x < n.x ? n : o;
    const ux = (right.x - left.x) / width;
    const uy = (right.y - left.y) / width;
    const dx = c.x - cx;
    const dy = c.y - cy;
    const half = width / 2;

    return {
      cx, cy, width, open, irisX: c.x, irisY: c.y, irisR,
      h: (dx * ux + dy * uy) / half,     // + = iris toward image-right
      v: (dx * -uy + dy * ux) / half,    // + = iris toward image-down
      blink: open < 0.13
    };
  }

  updateFromLandmarks(result, fullW, fullH, leftW, leftH) {
    const r = this.trackingResult;
    const lm = result && result.faceLandmarks && result.faceLandmarks[0];
    if (!lm || lm.length < 478) {
      this.faceMissFrames++;
      if (this.faceMissFrames > 8) {
        r.detected = false;
        this.recordConvergence(94.0, 0.5);
      }
      return;
    }
    this.faceMissFrames = 0;

    const LM = AccuVisEyeTracker.LANDMARKS;
    const fresh = {
      A: this.eyeGeometry(lm, LM.A, fullW, fullH),
      B: this.eyeGeometry(lm, LM.B, fullW, fullH)
    };

    if (!this.eyes) this.eyes = { A: { ...fresh.A }, B: { ...fresh.B } };
    for (const k of ['A', 'B']) {
      const cur = this.eyes[k];
      const g = fresh[k];
      const socketFields = ['cx', 'cy', 'width'];
      socketFields.forEach(f => { cur[f] += (g[f] - cur[f]) * 0.55; });
      cur.open = g.open;
      cur.blink = g.blink;
      if (!g.blink) {
        ['irisX', 'irisY', 'irisR', 'h', 'v'].forEach(f => { cur[f] += (g[f] - cur[f]) * 0.6; });
      }
    }

    const keys = this.selectedEyeKeys();

    // Gaze per selected eye, corrected by the calibrated centre and smoothed
    const eyeGazes = [];
    for (const k of keys) {
      const e = this.eyes[k];
      const rawX = e.h * 1.9 - this.gazeBaseline[k].x;
      const rawY = e.v * 2.2 - this.gazeBaseline[k].y;
      e.rawX = e.h * 1.9;
      e.rawY = e.v * 2.2;
      if (!e.blink) {
        const sg = this.smoothGaze[k];
        sg.x += (rawX - sg.x) * 0.4;
        sg.y += (rawY - sg.y) * 0.4;
      }
      eyeGazes.push({
        key: k,
        x: Math.max(-0.95, Math.min(0.95, this.smoothGaze[k].x)),
        y: Math.max(-0.95, Math.min(0.95, this.smoothGaze[k].y))
      });
    }

    const gx = eyeGazes.reduce((a, g) => a + g.x, 0) / eyeGazes.length;
    const gy = eyeGazes.reduce((a, g) => a + g.y, 0) / eyeGazes.length;
    const distSq = Math.min(0.99, gx * gx + gy * gy);
    r.gazeX = gx;
    r.gazeY = gy;
    r.gazeZ = Math.sqrt(Math.max(0.01, 1.0 - distSq));
    r.eyeGazes = eyeGazes;

    let dev;
    if (eyeGazes.length === 2) {
      dev = (Math.abs(eyeGazes[0].x + eyeGazes[1].x) / 2 + Math.abs(eyeGazes[0].y - eyeGazes[1].y) / 2) * 2.5;
    } else {
      dev = Math.sqrt(gx * gx + gy * gy);
    }
    r.symmetryScore = parseFloat(Math.max(93.0, 99.8 - dev * 4.8).toFixed(1));
    r.detected = true;
    r.confidence = 0.95;
    r.pupilAngle = 0;
    this.recordConvergence(r.symmetryScore, r.gazeZ);

    // Crop target: frame the chosen eye's socket (head-driven, NOT iris-driven, so it stays steady)
    const aspect = leftH / leftW;
    let cw, centerX, centerY;
    if (keys.length === 1) {
      const e = this.eyes[keys[0]];
      cw = Math.max(70, e.width * 2.5);
      centerX = e.cx;
      centerY = e.cy;
    } else {
      const a = this.eyes.A, b = this.eyes.B;
      const span = Math.abs(b.cx - a.cx) + (a.width + b.width) / 2;
      cw = Math.max(120, span * 1.35);
      centerX = (a.cx + b.cx) / 2;
      centerY = (a.cy + b.cy) / 2;
    }
    cw = Math.min(cw, fullW);
    let ch = cw * aspect;
    if (ch > fullH) { ch = fullH; cw = ch / aspect; }

    const cs = this.cropState;
    cs.targetW = cw;
    cs.targetH = ch;
    cs.targetX = Math.max(0, Math.min(fullW - cw, centerX - cw / 2));
    cs.targetY = Math.max(0, Math.min(fullH - ch, centerY - ch / 2));
    if (!this.hasLandmarkCrop) {
      cs.x = cs.targetX; cs.y = cs.targetY; cs.w = cw; cs.h = ch;
      this.hasLandmarkCrop = true;
      cs.initialized = true;
    }
  }

  renderLandmarkPanels(fullW, fullH, leftW, leftH, rightW, rightH) {
    const r = this.trackingResult;
    const cs = this.cropState;

    if (this.hasLandmarkCrop) {
      const a = 0.35;
      cs.x += (cs.targetX - cs.x) * a;
      cs.y += (cs.targetY - cs.y) * a;
      cs.w += (cs.targetW - cs.w) * a;
      cs.h += (cs.targetH - cs.h) * a;
    }

    this.ctxLeft.clearRect(0, 0, leftW, leftH);
    if (this.hasLandmarkCrop) {
      this.ctxLeft.drawImage(this.frameCanvas, cs.x, cs.y, cs.w, cs.h, 0, 0, leftW, leftH);
    } else {
      // No face seen yet: show the whole frame so the operator can reposition the phone
      this.ctxLeft.fillStyle = '#0a1220';
      this.ctxLeft.fillRect(0, 0, leftW, leftH);
      const sc = Math.min(leftW / fullW, leftH / fullH);
      const dw = fullW * sc, dh = fullH * sc;
      this.ctxLeft.drawImage(this.frameCanvas, (leftW - dw) / 2, (leftH - dh) / 2, dw, dh);
    }

    if (r.detected && this.eyes) {
      const sx = leftW / cs.w;
      const sy = leftH / cs.h;
      const keys = this.selectedEyeKeys();
      r.overlayEyes = keys.map(k => {
        const e = this.eyes[k];
        return {
          x: (e.irisX - cs.x) * sx,
          y: (e.irisY - cs.y) * sy,
          rx: Math.max(4, e.irisR * sx),
          ry: Math.max(4, e.irisR * sy)
        };
      });
      const main = r.overlayEyes[0];
      r.pupilX = main.x;
      r.pupilY = main.y;
      r.majorAxis = main.rx;
      r.minorAxis = main.ry;
      r.pupilRadius = (main.rx + main.ry) / 2;
    } else {
      r.overlayEyes = null;
    }

    this.renderLeftOverlay(leftW, leftH);
    this.renderRight3DEyeModel(rightW, rightH);
    if (this.onUpdate) this.onUpdate(this.trackingResult);
  }

  processLandmarkFrame(fullW, fullH, leftW, leftH, rightW, rightH) {
    const now = performance.now();
    if (now - this.lastLandmarkTs >= 33) {
      this.lastLandmarkTs = now;
      try {
        const result = this.landmarker.detectForVideo(this.frameCanvas, now);
        this.landmarkErrors = 0;
        this.updateFromLandmarks(result, fullW, fullH, leftW, leftH);
      } catch (err) {
        this.landmarkErrors++;
        if (this.landmarkErrors > 5) {
          console.warn('Landmark tracker failing, switching to basic detection:', err);
          this.landmarker = null;
          this.setMode('basic');
          return false;
        }
      }
    }
    this.renderLandmarkPanels(fullW, fullH, leftW, leftH, rightW, rightH);
    return true;
  }

  findEyeCenterWideScan(fullW, fullH) {
    let eyeCenterX = fullW / 2;
    let eyeCenterY = fullH * 0.42;

    const isMirrored = this.mirrored;
    const eyeSeparation = fullW * 0.13;

    if (this.targetEye === 'OD') {
      eyeCenterX = isMirrored ? (fullW / 2 + eyeSeparation) : (fullW / 2 - eyeSeparation);
    } else if (this.targetEye === 'OS') {
      eyeCenterX = isMirrored ? (fullW / 2 - eyeSeparation) : (fullW / 2 + eyeSeparation);
    }

    // Wide ocular search window (+/- 85px X, +/- 70px Y)
    const scanWinX = 85;
    const scanWinY = 70;
    const startX = Math.max(10, Math.floor(eyeCenterX - scanWinX));
    const endX = Math.min(fullW - 10, Math.floor(eyeCenterX + scanWinX));
    const startY = Math.max(10, Math.floor(eyeCenterY - scanWinY));
    const endY = Math.min(fullH - 10, Math.floor(eyeCenterY + scanWinY));

    const pW = endX - startX;
    const pH = endY - startY;
    if (pW <= 0 || pH <= 0) return { x: eyeCenterX, y: eyeCenterY };

    const patchData = this.frameCtx.getImageData(startX, startY, pW, pH).data;

    let minSum = Infinity;
    let fineX = eyeCenterX;
    let fineY = eyeCenterY;
    const step = 4;
    const block = 14;

    for (let py = 0; py < pH - block; py += step) {
      for (let px = 0; px < pW - block; px += step) {
        let sum = 0;
        for (let by = 0; by < block; by += 3) {
          for (let bx = 0; bx < block; bx += 3) {
            const idx = ((py + by) * pW + (px + bx)) * 4;
            sum += patchData[idx] * 0.299 + patchData[idx + 1] * 0.587 + patchData[idx + 2] * 0.114;
          }
        }
        if (sum < minSum) {
          minSum = sum;
          fineX = startX + px + block / 2;
          fineY = startY + py + block / 2;
        }
      }
    }

    return { x: fineX, y: fineY };
  }

  calibrateCenter() {
    if (this.mode === 'landmarks' && this.eyes) {
      // Treat the current iris position as "looking straight ahead" for the selected eye(s)
      this.selectedEyeKeys().forEach(k => {
        this.gazeBaseline[k] = { x: this.eyes[k].rawX || 0, y: this.eyes[k].rawY || 0 };
        this.smoothGaze[k] = { x: 0, y: 0 };
      });
      this.hasLandmarkCrop = false;
      this.calibration.isCalibrated = true;
      this.calibration.timestamp = performance.now();
      this.trackingResult.gazeX = 0.0;
      this.trackingResult.gazeY = 0.0;
      this.trackingResult.gazeZ = 1.0;
      return { success: true };
    }

    const fullW = this.frameCanvas.width;
    const fullH = this.frameCanvas.height;
    const leftW = this.canvasLeft ? this.canvasLeft.width : 220;
    const leftH = this.canvasLeft ? this.canvasLeft.height : 150;

    let targetEyeX = fullW / 2;
    let targetEyeY = fullH * 0.42;

    // 1. If video frames are active and pupil detected, anchor crop directly to the pupil
    if (this.video && this.video.readyState >= 2 && this.trackingResult.detected && this.cropState.initialized) {
      const currentFullPupilX = this.cropState.x + (this.trackingResult.pupilX / leftW) * this.cropState.w;
      const currentFullPupilY = this.cropState.y + (this.trackingResult.pupilY / leftH) * this.cropState.h;
      targetEyeX = currentFullPupilX;
      targetEyeY = currentFullPupilY;
    } else {
      const found = this.findEyeCenterWideScan(fullW, fullH);
      targetEyeX = found.x;
      targetEyeY = found.y;
    }

    // 2. Center crop box directly around the detected eye
    const tDist = (40.0 - this.railDistanceCm) / 36.0;
    const cropW = Math.round(155 + tDist * 45);
    const cropH = Math.round(cropW * 0.72);

    this.cropState.w = cropW;
    this.cropState.h = cropH;
    this.cropState.x = Math.max(0, Math.min(fullW - cropW, targetEyeX - cropW / 2));
    this.cropState.y = Math.max(0, Math.min(fullH - cropH, targetEyeY - cropH / 2));
    this.cropState.targetX = this.cropState.x;
    this.cropState.targetY = this.cropState.y;
    this.cropState.initialized = true;

    // 3. Calibrate optical gaze baseline (centered at viewport midpoint)
    this.calibration.originX = leftW / 2;
    this.calibration.originY = leftH / 2;
    this.calibration.isCalibrated = true;
    this.calibration.timestamp = performance.now();

    // 4. Immediately align gaze and vergence symmetry
    this.trackingResult.pupilX = leftW / 2;
    this.trackingResult.pupilY = leftH / 2;
    this.trackingResult.gazeX = 0.0;
    this.trackingResult.gazeY = 0.0;
    this.trackingResult.gazeZ = 1.0;
    this.trackingResult.symmetryScore = 99.8;

    return {
      success: true,
      x: targetEyeX,
      y: targetEyeY
    };
  }

  async startWebcam(facingMode = 'user') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn("getUserMedia is not supported by your browser environment.");
      return null;
    }

    let stream = null;
    // 1. Try with ideal constraints (never mandatory facingMode to avoid Linux V4L2 OverconstrainedError)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: { ideal: facingMode }
        },
        audio: false
      });
    } catch (err1) {
      console.warn("Primary camera constraint rejected, attempting generic webcam access:", err1);
      // 2. Generic fallback for Linux desktop / USB webcams
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      } catch (err2) {
        console.warn("Generic webcam access failed or unavailable:", err2);
        return null;
      }
    }

    if (this.video && stream) {
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.onloadedmetadata = () => {
        if (this.video) {
          this.video.play().catch(e => console.warn("Video play error on metadata load:", e));
        }
      };
      try {
        await this.video.play();
      } catch (ePlay) {
        console.warn("Video play error:", ePlay);
      }
    }

    this.recenterEyeCrop();
    this.startProcessingLoop();
    return stream;
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.video && this.video.srcObject) {
      const tracks = this.video.srcObject.getTracks();
      tracks.forEach(t => t.stop());
      this.video.srcObject = null;
    }
    if (this.ctxLeft && this.canvasLeft) {
      this.ctxLeft.clearRect(0, 0, this.canvasLeft.width, this.canvasLeft.height);
    }
    if (this.ctxRight && this.canvasRight) {
      this.ctxRight.clearRect(0, 0, this.canvasRight.width, this.canvasRight.height);
    }
  }

  startProcessingLoop() {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = () => {
      if (!this.isRunning) return;
      this.processCurrentFrame();
      this.animationId = requestAnimationFrame(loop);
    };

    this.animationId = requestAnimationFrame(loop);
  }

  renderLeftStandby(w, h) {
    const ctx = this.ctxLeft;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#0a1220';
    ctx.fillRect(0, 0, w, h);

    // Crosshair reticle
    ctx.strokeStyle = 'rgba(85, 149, 177, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 34, 0, 2 * Math.PI);
    ctx.moveTo(w / 2 - 45, h / 2);
    ctx.lineTo(w / 2 + 45, h / 2);
    ctx.moveTo(w / 2, h / 2 - 45);
    ctx.lineTo(w / 2, h / 2 + 45);
    ctx.stroke();

    // Pulse dot
    const pulse = (Math.sin(performance.now() / 250) + 1) / 2;
    ctx.fillStyle = `rgba(85, 149, 177, ${0.4 + pulse * 0.5})`;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 4, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = '#c8c9b7';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.mode === 'loading' ? "LOADING EYE TRACKER..." : "WAITING FOR CAMERA...", w / 2, h / 2 + 46);
    ctx.textAlign = 'left';
  }

  processCurrentFrame() {
    if (!this.canvasLeft || !this.ctxLeft || !this.canvasRight || !this.ctxRight) return;

    const leftW = this.canvasLeft.width || 220;
    const leftH = this.canvasLeft.height || 150;
    const rightW = this.canvasRight.width || 220;
    const rightH = this.canvasRight.height || 150;

    // Always render RIGHT PANEL: Live 3D Eyeball Model
    this.renderRight3DEyeModel(rightW, rightH);

    // Check if video frames are decoded and available
    const isVideoReady = this.video && this.video.srcObject && this.video.readyState >= 2 && this.video.videoWidth > 0;
    if (!isVideoReady) {
      this.renderLeftStandby(leftW, leftH);
      return;
    }

    // Keep the true video aspect ratio (phone cameras are often 4:3 or 16:9, portrait or landscape)
    const wantW = 640;
    const wantH = Math.max(240, Math.min(1138, Math.round(wantW * this.video.videoHeight / this.video.videoWidth)));
    if (this.frameCanvas.width !== wantW || this.frameCanvas.height !== wantH) {
      this.frameCanvas.width = wantW;
      this.frameCanvas.height = wantH;
      this.cropState.initialized = false;
      this.hasLandmarkCrop = false;
    }
    const fullW = this.frameCanvas.width;
    const fullH = this.frameCanvas.height;

    // 1. Draw raw video to full frame canvas with 180° flip / mirror transforms
    this.frameCtx.save();
    this.frameCtx.translate(fullW / 2, fullH / 2);
    if (this.flipped180) {
      this.frameCtx.rotate(Math.PI);
    }
    if (this.mirrored) {
      this.frameCtx.scale(-1, 1);
    }
    this.frameCtx.drawImage(this.video, -fullW / 2, -fullH / 2, fullW, fullH);
    this.frameCtx.restore();

    // Preferred path: real face + iris landmarks (only the selected eye is ever tracked)
    if (this.mode === 'landmarks' && this.landmarker) {
      if (this.processLandmarkFrame(fullW, fullH, leftW, leftH, rightW, rightH)) return;
    }

    // Fallback path (no landmarks available): heuristic eye crop + darkest-blob pupil fit
    // 2. Locate patient's eye in full frame and compute target crop box
    this.updateEyeCropBox(fullW, fullH);

    // 3. Render LEFT PANEL: Draw ONLY the cropped eye (Face & background cropped out)
    const cs = this.cropState;
    this.ctxLeft.clearRect(0, 0, leftW, leftH);
    this.ctxLeft.drawImage(
      this.frameCanvas,
      cs.x, cs.y, cs.w, cs.h,
      0, 0, leftW, leftH
    );

    // 4. Downscale cropped eye into processing canvas for pupil fitting
    const procW = this.procCanvas.width;
    const procH = this.procCanvas.height;
    this.procCtx.drawImage(
      this.frameCanvas,
      cs.x, cs.y, cs.w, cs.h,
      0, 0, procW, procH
    );

    // 5. Orlosky pupil detection on cropped eye
    const procData = this.procCtx.getImageData(0, 0, procW, procH);
    const pupilResult = this.detectPupilOrlosky(procData, procW, procH);

    if (pupilResult.detected) {
      const scaleX = leftW / procW;
      const scaleY = leftH / procH;

      this.trackingResult.detected = true;
      this.trackingResult.pupilX = pupilResult.cx * scaleX;
      this.trackingResult.pupilY = pupilResult.cy * scaleY;
      this.trackingResult.majorAxis = pupilResult.majorAxis * scaleX;
      this.trackingResult.minorAxis = pupilResult.minorAxis * scaleY;
      this.trackingResult.pupilRadius = ((pupilResult.majorAxis + pupilResult.minorAxis) / 2) * scaleX;
      this.trackingResult.pupilAngle = pupilResult.angle;
      this.trackingResult.confidence = pupilResult.confidence;

      // Gaze vector computation relative to calibrated eye center
      const centerX = (this.calibration.isCalibrated && this.calibration.originX != null)
        ? this.calibration.originX
        : (leftW / 2);
      const centerY = (this.calibration.isCalibrated && this.calibration.originY != null)
        ? this.calibration.originY
        : (leftH / 2);
      const eyeSphereRadius = 65;

      const rawGazeX = (this.trackingResult.pupilX - centerX) / eyeSphereRadius;
      const rawGazeY = (this.trackingResult.pupilY - centerY) / eyeSphereRadius;
      const gazeDistSq = rawGazeX * rawGazeX + rawGazeY * rawGazeY;

      this.trackingResult.gazeX = Math.max(-0.95, Math.min(0.95, rawGazeX));
      this.trackingResult.gazeY = Math.max(-0.95, Math.min(0.95, rawGazeY));
      this.trackingResult.gazeZ = Math.sqrt(Math.max(0.01, 1.0 - Math.min(0.99, gazeDistSq)));

      // Vergence symmetry calculation
      const dev = Math.sqrt(rawGazeX * rawGazeX + rawGazeY * rawGazeY);
      this.trackingResult.symmetryScore = parseFloat(Math.max(93.0, (99.8 - dev * 4.8)).toFixed(1));

      this.recordConvergence(this.trackingResult.symmetryScore, this.trackingResult.gazeZ);
    } else {
      this.trackingResult.detected = false;
      this.recordConvergence(94.0, 0.5);
    }

    // 6. Draw Left Panel Tracking Overlay (Pupil Ellipse, Crosshair, Calibration Status)
    this.renderLeftOverlay(leftW, leftH);

    // 7. Update RIGHT PANEL: Live 3D Eyeball Model
    this.renderRight3DEyeModel(rightW, rightH);

    // 8. Trigger Update Callback
    if (this.onUpdate) {
      this.onUpdate(this.trackingResult);
    }
  }

  updateEyeCropBox(fullW, fullH) {
    const leftW = this.canvasLeft ? this.canvasLeft.width : 220;
    const leftH = this.canvasLeft ? this.canvasLeft.height : 150;

    const tDist = (40.0 - this.railDistanceCm) / 36.0;
    const cropW = Math.round(155 + tDist * 45);
    const cropH = Math.round(cropW * 0.72);

    if (!this.cropState.initialized) {
      const found = this.findEyeCenterWideScan(fullW, fullH);
      this.cropState.w = cropW;
      this.cropState.h = cropH;
      this.cropState.x = Math.max(0, Math.min(fullW - cropW, found.x - cropW / 2));
      this.cropState.y = Math.max(0, Math.min(fullH - cropH, found.y - cropH / 2));
      this.cropState.targetX = this.cropState.x;
      this.cropState.targetY = this.cropState.y;
      this.cropState.initialized = true;
      return;
    }

    // Steady Eye Socket Framing: The crop box remains stationary framing the eye socket,
    // allowing the pupil to move across the field during left/right gaze saccades.
    const alpha = 0.12;
    this.cropState.x += (this.cropState.targetX - this.cropState.x) * alpha;
    this.cropState.y += (this.cropState.targetY - this.cropState.y) * alpha;
    this.cropState.w += (cropW - this.cropState.w) * alpha;
    this.cropState.h += (cropH - this.cropState.h) * alpha;
  }

  detectPupilOrlosky(imageData, width, height) {
    const data = imageData.data;
    const ignoreBounds = 10;
    const searchStep = 4;
    const searchArea = 16;
    const innerStep = 3;

    let minSum = Infinity;
    let darkestX = width / 2;
    let darkestY = height / 2;

    // 1. Grid search for darkest area (pupil core)
    for (let y = ignoreBounds; y < height - ignoreBounds - searchArea; y += searchStep) {
      for (let x = ignoreBounds; x < width - ignoreBounds - searchArea; x += searchStep) {
        let sum = 0;
        let count = 0;
        for (let dy = 0; dy < searchArea; dy += innerStep) {
          for (let dx = 0; dx < searchArea; dx += innerStep) {
            const idx = ((y + dy) * width + (x + dx)) * 4;
            const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            sum += lum;
            count++;
          }
        }
        if (count > 0 && sum < minSum) {
          minSum = sum;
          darkestX = x + Math.floor(searchArea / 2);
          darkestY = y + Math.floor(searchArea / 2);
        }
      }
    }

    const darkestIdx = (Math.floor(darkestY) * width + Math.floor(darkestX)) * 4;
    const darkestVal = data[darkestIdx] * 0.299 + data[darkestIdx + 1] * 0.587 + data[darkestIdx + 2] * 0.114;
    const threshold = darkestVal + 28;

    // 2. Collect pupil candidate pixels inside square mask around darkest point
    const maskHalfSize = 35;
    const minX = Math.max(0, darkestX - maskHalfSize);
    const maxX = Math.min(width - 1, darkestX + maskHalfSize);
    const minY = Math.max(0, darkestY - maskHalfSize);
    const maxY = Math.min(height - 1, darkestY + maskHalfSize);

    let m00 = 0;
    let m10 = 0;
    let m01 = 0;

    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const idx = (y * width + x) * 4;
        const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        if (lum <= threshold) {
          m00++;
          m10 += x;
          m01 += y;
        }
      }
    }

    if (m00 < 10 || m00 > (maskHalfSize * maskHalfSize * 0.9)) {
      return {
        detected: false,
        cx: darkestX,
        cy: darkestY,
        majorAxis: 14,
        minorAxis: 14,
        angle: 0,
        confidence: 0.4
      };
    }

    // 3. Central moments for pupil ellipse fit
    const cx = m10 / m00;
    const cy = m01 / m00;

    let mu20 = 0;
    let mu02 = 0;
    let mu11 = 0;

    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const idx = (y * width + x) * 4;
        const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        if (lum <= threshold) {
          const dx = x - cx;
          const dy = y - cy;
          mu20 += dx * dx;
          mu02 += dy * dy;
          mu11 += dx * dy;
        }
      }
    }

    mu20 /= m00;
    mu02 /= m00;
    mu11 /= m00;

    const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    const term = Math.sqrt(Math.max(0, (mu20 - mu02) * (mu20 - mu02) + 4 * mu11 * mu11));
    const major = 2 * Math.sqrt(Math.max(1, mu20 + mu02 + term));
    const minor = 2 * Math.sqrt(Math.max(1, mu20 + mu02 - term));

    return {
      detected: true,
      cx: cx,
      cy: cy,
      majorAxis: Math.max(6, Math.min(55, major)),
      minorAxis: Math.max(4, Math.min(45, minor)),
      angle: angle,
      confidence: Math.min(0.99, Math.max(0.70, 1.0 - Math.abs(major - minor) / (major + 1)))
    };
  }

  recordConvergence(symmetry, gazeZ) {
    this.convergenceHistory.push({ symmetry, gazeZ, timestamp: performance.now() });
    if (this.convergenceHistory.length > this.historyMaxLength) {
      this.convergenceHistory.shift();
    }

    if (this.convergenceHistory.length >= 12) {
      const avgSym = this.convergenceHistory.reduce((acc, h) => acc + h.symmetry, 0) / this.convergenceHistory.length;
      this.trackingResult.isConverged = (avgSym >= 98.2 && gazeZ >= 0.90 && this.railDistanceCm <= 20);
    } else {
      this.trackingResult.isConverged = false;
    }
  }

  renderLeftOverlay(w, h) {
    const r = this.trackingResult;
    const ctx = this.ctxLeft;
    const irisBlue = '#E5A93C';
    const lockGreen = '#2D8A4E';
    const ashGray = '#FAF0CA';

    if (!r.detected) {
      ctx.strokeStyle = 'rgba(175, 153, 129, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(w * 0.25, h * 0.25, w * 0.5, h * 0.5);
      ctx.setLineDash([]);
      if (this.mode === 'landmarks') {
        ctx.fillStyle = 'rgba(10, 18, 32, 0.75)';
        ctx.fillRect(0, h - 22, w, 22);
        ctx.fillStyle = '#FAF0CA';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const which = this.targetEye === 'OU' ? 'BOTH EYES' : (this.targetEye === 'OD' ? 'RIGHT EYE (OD)' : 'LEFT EYE (OS)');
        ctx.fillText('SEARCHING FOR ' + which + '...', w / 2, h - 8);
        ctx.textAlign = 'left';
      }
      return;
    }

    // 1. Draw pupil/iris ring + crosshair for each tracked eye
    const eyesToDraw = r.overlayEyes || [{ x: r.pupilX, y: r.pupilY, rx: r.majorAxis, ry: r.minorAxis }];
    eyesToDraw.forEach(pt => {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(r.overlayEyes ? 0 : r.pupilAngle);
      ctx.strokeStyle = r.isConverged ? lockGreen : irisBlue;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, pt.rx, pt.ry, 0, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = r.isConverged ? lockGreen : '#ffffff';
      ctx.lineWidth = 1.5;
      const arm = 7;
      ctx.beginPath();
      ctx.moveTo(pt.x - arm, pt.y);
      ctx.lineTo(pt.x + arm, pt.y);
      ctx.moveTo(pt.x, pt.y - arm);
      ctx.lineTo(pt.x, pt.y + arm);
      ctx.stroke();

      ctx.fillStyle = r.isConverged ? lockGreen : irisBlue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    });

    // 3. Calibrated Optical Center Reticle
    if (this.calibration.isCalibrated) {
      const cX = w / 2;
      const cY = h / 2;
      ctx.strokeStyle = 'rgba(85, 149, 177, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cX, cY, 12, 0, 2 * Math.PI);
      ctx.moveTo(cX - 16, cY);
      ctx.lineTo(cX - 6, cY);
      ctx.moveTo(cX + 6, cY);
      ctx.lineTo(cX + 16, cY);
      ctx.moveTo(cX, cY - 16);
      ctx.lineTo(cX, cY - 6);
      ctx.moveTo(cX, cY + 6);
      ctx.lineTo(cX, cY + 16);
      ctx.stroke();
    }

    // 4. Calibration Confirmation Toast Overlay
    if (performance.now() - this.calibration.timestamp < 2200) {
      ctx.save();
      ctx.fillStyle = 'rgba(10, 18, 32, 0.90)';
      ctx.strokeStyle = lockGreen;
      ctx.lineWidth = 1;
      const boxW = 126;
      const boxH = 17;
      const boxX = Math.round(w / 2 - boxW / 2);
      const boxY = 24;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);

      ctx.fillStyle = lockGreen;
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText("EYE CENTER CALIBRATED", w / 2, boxY + 12);
      ctx.restore();
    }

    // 5. Telemetry in bottom corner
    ctx.fillStyle = ashGray;
    ctx.font = '8.5px JetBrains Mono, monospace';
    ctx.fillText(`PUPIL: (${Math.round(r.pupilX)}, ${Math.round(r.pupilY)})`, 6, h - 8);

    const statusText = r.isConverged ? "CONVERGED" : (this.calibration.isCalibrated ? "CALIBRATED" : "LOCKED");
    ctx.fillStyle = (r.isConverged || this.calibration.isCalibrated) ? lockGreen : irisBlue;
    ctx.fillText(statusText, w - (statusText.length * 6 + 6), h - 8);
  }

  drawEyeball(ctx, cx, cy, radius, gazeX, gazeY, isLocked, label) {
    const wireColor = isLocked ? 'rgba(52, 211, 153, 0.45)' : 'rgba(85, 149, 177, 0.28)';
    const irisColor = isLocked ? '#34d399' : '#5595b1';
    const corneaColor = isLocked ? 'rgba(52, 211, 153, 0.8)' : '#af9981';

    // 1. Sclera base fill
    const baseGrad = ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, 4, cx, cy, radius);
    baseGrad.addColorStop(0, '#162842');
    baseGrad.addColorStop(1, '#09111c');
    ctx.fillStyle = baseGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fill();

    // 2. Outer boundary
    ctx.strokeStyle = isLocked ? '#34d399' : 'rgba(85, 149, 177, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.stroke();

    // 3. Latitude rings
    ctx.lineWidth = 1;
    ctx.strokeStyle = wireColor;
    const latCount = 6;
    for (let i = 1; i < latCount; i++) {
      const latFraction = (i / latCount) * 2 - 1;
      const ringR = Math.sqrt(Math.max(0, radius * radius - (radius * latFraction) * (radius * latFraction)));
      const ringY = cy + (radius * latFraction) + gazeY * 12;
      const vertFlatten = Math.max(0.1, Math.abs(gazeY) + 0.35);
      ctx.beginPath();
      ctx.ellipse(cx + gazeX * 8, ringY, ringR, ringR * vertFlatten, 0, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // 4. Longitude meridians
    const lonCount = 5;
    for (let j = 0; j < lonCount; j++) {
      const angle = (j / lonCount) * Math.PI;
      const horizFlatten = Math.max(0.12, Math.abs(Math.sin(angle + gazeX * 0.8)));
      ctx.beginPath();
      ctx.ellipse(cx + gazeX * 12, cy + gazeY * 8, radius * horizFlatten, radius, 0, 0, 2 * Math.PI);
      ctx.stroke();
    }

    // 5. Cornea, iris and pupil follow the gaze vector
    const corneaX = cx + gazeX * (radius * 0.58);
    const corneaY = cy + gazeY * (radius * 0.58);
    const corneaR = radius * 0.42;

    ctx.strokeStyle = corneaColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(corneaX, corneaY, corneaR, 0, 2 * Math.PI);
    ctx.stroke();

    const irisGrad = ctx.createRadialGradient(corneaX, corneaY, 2, corneaX, corneaY, corneaR);
    irisGrad.addColorStop(0, '#0a1526');
    irisGrad.addColorStop(0.5, irisColor);
    irisGrad.addColorStop(1, '#0e233d');
    ctx.fillStyle = irisGrad;
    ctx.beginPath();
    ctx.arc(corneaX, corneaY, corneaR * 0.82, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = '#050a12';
    ctx.beginPath();
    ctx.arc(corneaX, corneaY, corneaR * 0.38, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(corneaX - corneaR * 0.16, corneaY - corneaR * 0.16, 2.5, 0, 2 * Math.PI);
    ctx.fill();

    // 6. Gaze ray
    const rayLength = radius * 0.75;
    const rayEndX = corneaX + gazeX * rayLength;
    const rayEndY = corneaY + gazeY * rayLength;
    ctx.strokeStyle = isLocked ? '#2D8A4E' : '#E5A93C';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corneaX, corneaY);
    ctx.lineTo(rayEndX, rayEndY);
    ctx.stroke();
    ctx.fillStyle = isLocked ? '#2D8A4E' : '#E5A93C';
    ctx.beginPath();
    ctx.arc(rayEndX, rayEndY, 3.5, 0, 2 * Math.PI);
    ctx.fill();

    if (label) {
      ctx.fillStyle = '#c8c9b7';
      ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, cy - radius - 5);
      ctx.textAlign = 'left';
    }
  }

  renderRight3DEyeModel(w, h) {
    const ctx = this.ctxRight;
    ctx.clearRect(0, 0, w, h);

    const r = this.trackingResult;
    const isLocked = r.isConverged;
    const gazeX = r.detected ? r.gazeX : 0.0;
    const gazeY = r.detected ? r.gazeY : 0.0;
    const gazeZ = r.detected ? r.gazeZ : 1.0;

    const labelFor = (key) => {
      const isOD = (key === 'A') !== this.mirrored;
      return isOD ? 'OD (RIGHT)' : 'OS (LEFT)';
    };

    const eyeGazes = (this.mode === 'landmarks' && r.detected && r.eyeGazes && r.eyeGazes.length)
      ? r.eyeGazes
      : null;

    if (eyeGazes && eyeGazes.length === 2) {
      // OU: two eyeballs, image-left eye on the left
      const radius = Math.min(w / 4.4, h * 0.34);
      this.drawEyeball(ctx, w * 0.27, h / 2 + 6, radius, eyeGazes[0].x, eyeGazes[0].y, isLocked, labelFor(eyeGazes[0].key));
      this.drawEyeball(ctx, w * 0.73, h / 2 + 6, radius, eyeGazes[1].x, eyeGazes[1].y, isLocked, labelFor(eyeGazes[1].key));
    } else {
      const radius = Math.min(w, h) * 0.36;
      const label = eyeGazes ? labelFor(eyeGazes[0].key) : null;
      this.drawEyeball(ctx, w / 2, h / 2 + 5, radius, gazeX, gazeY, isLocked, label);
    }

    // 7. Vector readout
    ctx.fillStyle = '#c8c9b7';
    ctx.font = '8.5px JetBrains Mono, monospace';
    ctx.fillText(`GAZE: [${gazeX.toFixed(2)}, ${gazeY.toFixed(2)}, ${gazeZ.toFixed(2)}]`, 6, h - 8);

    if (isLocked) {
      ctx.fillStyle = '#34d399';
      ctx.fillText("3D FOVEAL LOCK", w - 85, h - 8);
    }
  }
}

// MediaPipe Face Mesh landmark indices (478-point model with iris refinement)
AccuVisEyeTracker.LANDMARKS = {
  A: { outer: 33,  inner: 133, upper: 159, lower: 145, iris: [468, 469, 470, 471, 472] },
  B: { outer: 263, inner: 362, upper: 386, lower: 374, iris: [473, 474, 475, 476, 477] }
};

// Attach globally
window.AccuVisEyeTracker = AccuVisEyeTracker;
