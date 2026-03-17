/* =========================================================
   GREEN FINDER – app.js
   Analyzes camera pixels inside a bottle-shaped silhouette
   and returns the % of green hues detected.
   ========================================================= */

'use strict';

// ── State ────────────────────────────────────────────────
let stream        = null;
let animFrame     = null;
let isScanning    = false;
let displayedPct  = 0;   // smoothed value shown on screen

// ── DOM refs (resolved after DOMContentLoaded) ───────────
let video, offscreen, ctx, pctValue;
let bottleSVGEl, bottleMaskContainer;

// ── Bottle path (in SVG-space 200×500 viewBox) ──────────
// Must mirror the <path> in #bottle-svg exactly.
const BOTTLE_PATH_D =
  'M85 0 L85 75 C55 85 40 115 40 145 L40 445 C40 475 60 495 85 495 L115 495 C140 495 160 475 160 445 L160 145 C160 115 145 85 115 75 L115 0 Z';

// We will rasterize the bottle path onto the offscreen canvas
// in the same proportions as the on-screen SVG element.

// ── Cached bottle mask ───────────────────────────────────
let maskCanvas   = null;   // holds the rasterized bottle silhouette
let maskCtx      = null;
let maskW        = 0;
let maskH        = 0;
let maskPixels   = null;   // Uint8ClampedArray of the alpha channel

// ── Green detection thresholds (HSL) ─────────────────────
// A pixel is "green" when:
//   hue in [80°, 160°]   (covers yellow-green → pure green → cyan-green)
//   saturation ≥ 25%
//   lightness in [10%, 90%]  (exclude near-black and near-white)
const HUE_MIN  = 80;
const HUE_MAX  = 160;
const SAT_MIN  = 0.25;
const LIT_MIN  = 0.10;
const LIT_MAX  = 0.90;

// ── Helpers ───────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6;               break;
      case b: h = ((r - g) / d + 4) / 6;               break;
    }
  }
  return [h * 360, s, l];
}

function isGreen(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return h >= HUE_MIN && h <= HUE_MAX && s >= SAT_MIN && l >= LIT_MIN && l <= LIT_MAX;
}

// ── Build the bottle mask ─────────────────────────────────
// We draw the SVG path into an offscreen canvas at the same
// pixel size the SVG occupies on screen, then read back the
// alpha values. A pixel inside the bottle has alpha > 0.
function buildMask() {
  const rect = bottleMaskContainer.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  maskW = Math.round(rect.width);
  maskH = Math.round(rect.height);

  maskCanvas = document.createElement('canvas');
  maskCanvas.width  = maskW;
  maskCanvas.height = maskH;
  maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  // Scale the SVG viewBox (200×500) → mask canvas size
  const scaleX = maskW / 200;
  const scaleY = maskH / 500;

  const path = new Path2D(BOTTLE_PATH_D);
  maskCtx.save();
  maskCtx.scale(scaleX, scaleY);
  maskCtx.fillStyle = '#fff';
  maskCtx.fill(path);
  maskCtx.restore();

  const imgData = maskCtx.getImageData(0, 0, maskW, maskH);
  // Extract just the alpha channel into a flat Uint8Array for fast lookup
  const raw = imgData.data;
  maskPixels = new Uint8Array(maskW * maskH);
  for (let i = 0; i < maskW * maskH; i++) {
    maskPixels[i] = raw[i * 4 + 3]; // alpha
  }
}

// ── Main analysis loop ────────────────────────────────────
function analyzeFrame() {
  if (!isScanning) return;
  animFrame = requestAnimationFrame(analyzeFrame);

  if (!maskPixels || maskW === 0) {
    buildMask();
    if (!maskPixels) return;
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // ── Size the offscreen canvas to match the mask ──────
  if (offscreen.width !== maskW || offscreen.height !== maskH) {
    offscreen.width  = maskW;
    offscreen.height = maskH;
  }

  // ── Figure out where in the video the bottle maps to ─
  // The video fills its container (object-fit: cover),
  // so we need to map mask-canvas coordinates back to
  // the video's natural frame.
  const containerW = window.innerWidth;
  const containerH = window.innerHeight;

  // Scale that object-fit:cover uses
  const videoAspect     = vw / vh;
  const containerAspect = containerW / containerH;
  let renderedW, renderedH, offsetX, offsetY;

  if (videoAspect > containerAspect) {
    // Video wider than container → clipped left/right
    renderedH = containerH;
    renderedW = containerH * videoAspect;
    offsetX   = (renderedW - containerW) / 2;
    offsetY   = 0;
  } else {
    // Video taller than container → clipped top/bottom
    renderedW = containerW;
    renderedH = containerW / videoAspect;
    offsetX   = 0;
    offsetY   = (renderedH - containerH) / 2;
  }

  // The bottle container is centred in the viewport
  const bottleRect = bottleMaskContainer.getBoundingClientRect();
  const bottleLeft = bottleRect.left + offsetX;
  const bottleTop  = bottleRect.top  + offsetY;

  // ── Draw the bottle-sized region of the video ────────
  ctx.drawImage(
    video,
    (bottleLeft / renderedW) * vw,
    (bottleTop  / renderedH) * vh,
    (maskW / renderedW) * vw,
    (maskH / renderedH) * vh,
    0, 0,
    maskW, maskH
  );

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, maskW, maskH);
  } catch (e) {
    // Tainted canvas (cross-origin) – shouldn't happen with getUserMedia
    return;
  }

  const pixels = imgData.data;
  let total   = 0;
  let greens  = 0;

  for (let i = 0; i < maskW * maskH; i++) {
    if (maskPixels[i] < 128) continue; // outside bottle
    total++;
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    if (isGreen(r, g, b)) greens++;
  }

  const rawPct = total > 0 ? Math.round((greens / total) * 100) : 0;

  // Smooth display value (lerp at ~20% per frame)
  displayedPct += (rawPct - displayedPct) * 0.18;
  const shown = Math.round(displayedPct);

  pctValue.textContent = shown;

  // Colour-shift the number based on intensity
  if (shown >= 60) {
    pctValue.style.color = '#00FF00';
    pctValue.style.textShadow = '0 0 20px #00FF00, 0 0 40px rgba(0,255,0,0.6)';
  } else if (shown >= 30) {
    pctValue.style.color = '#88FF00';
    pctValue.style.textShadow = '0 0 16px #88FF00';
  } else {
    pctValue.style.color = '#44CC00';
    pctValue.style.textShadow = '0 0 12px #44CC00';
  }
}

// ── Start scanner ─────────────────────────────────────────
async function startScanner() {
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('scanner').classList.remove('hidden');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = stream;

    video.addEventListener('loadedmetadata', () => {
      video.play();

      // Build mask once the container has been painted
      requestAnimationFrame(() => {
        buildMask();
        isScanning = true;
        analyzeFrame();
      });
    }, { once: true });

  } catch (err) {
    showError(err);
  }
}

// ── Stop scanner ──────────────────────────────────────────
function stopScanner() {
  isScanning = false;
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;
  displayedPct = 0;

  document.getElementById('scanner').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');
}

// ── Error handling ────────────────────────────────────────
function showError(err) {
  document.getElementById('scanner').classList.add('hidden');
  const errScreen = document.getElementById('error-screen');
  const errMsg    = document.getElementById('error-msg');
  errScreen.classList.remove('hidden');

  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    errMsg.textContent =
      'Camera permission was denied. Please allow camera access in your browser settings, then reload the page.';
  } else if (err && err.name === 'NotFoundError') {
    errMsg.textContent =
      'No camera was found on this device. Make sure you are using a device with a camera.';
  } else if (err && err.name === 'NotSupportedError') {
    errMsg.textContent =
      'Camera access is not supported in this browser. Try opening the page in Chrome or Safari over HTTPS.';
  } else {
    errMsg.textContent =
      'Could not access the camera. Please check your browser settings and try again.';
  }
}

// ── Mask rebuild on orientation change ───────────────────
function handleResize() {
  if (!isScanning) return;
  maskPixels = null; // force rebuild next frame
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  video              = document.getElementById('video');
  offscreen          = document.getElementById('offscreen');
  ctx                = offscreen.getContext('2d', { willReadFrequently: true });
  pctValue           = document.getElementById('pct-value');
  bottleMaskContainer = document.getElementById('bottle-mask-container');

  window.addEventListener('resize',            handleResize);
  window.addEventListener('orientationchange', handleResize);

  // Expose control functions globally (called from onclick attributes)
  window.startScanner = startScanner;
  window.stopScanner  = stopScanner;
});
