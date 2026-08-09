// Global tilt engine: exposes --tilt-x / --tilt-y (each -1..1) on <html>,
// driven by device orientation on phones and pointer position on desktop.
// The plastic-wrap glint and the 3D cover boxes both read these variables,
// so everything moves together like real objects under one light source.

let targetX = 0;
let targetY = 0;
let currentX = 0;
let currentY = 0;
let raf = null;
let baseBeta = null; // calibrate to however the phone is being held

const clamp = (v) => Math.max(-1, Math.min(1, v));

function tick() {
  // Ease toward the target so motion feels like glass, not a cursor.
  currentX += (targetX - currentX) * 0.12;
  currentY += (targetY - currentY) * 0.12;
  const root = document.documentElement.style;
  root.setProperty("--tilt-x", currentX.toFixed(4));
  root.setProperty("--tilt-y", currentY.toFixed(4));
  if (Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.002) {
    raf = requestAnimationFrame(tick);
  } else {
    raf = null;
  }
}

function nudge() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function onOrientation(event) {
  if (event.beta === null || event.gamma === null) return;
  if (baseBeta === null) baseBeta = event.beta; // treat current pose as neutral
  targetX = clamp(event.gamma / 30); // left-right roll
  targetY = clamp((event.beta - baseBeta) / 30); // front-back pitch
  nudge();
}

function onPointer(event) {
  targetX = clamp((event.clientX / window.innerWidth) * 2 - 1);
  targetY = clamp((event.clientY / window.innerHeight) * 2 - 1);
  nudge();
}

export function initTilt() {
  document.documentElement.style.setProperty("--tilt-x", "0");
  document.documentElement.style.setProperty("--tilt-y", "0");

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const supportsOrientation = "DeviceOrientationEvent" in window;
  if (supportsOrientation && typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS: permission needs a user gesture — ask quietly on the first touch.
    const request = () => {
      DeviceOrientationEvent.requestPermission()
        .then((state) => {
          if (state === "granted") window.addEventListener("deviceorientation", onOrientation);
        })
        .catch(() => {});
      window.removeEventListener("touchend", request);
    };
    window.addEventListener("touchend", request, { once: true });
  } else if (supportsOrientation) {
    window.addEventListener("deviceorientation", onOrientation);
  }

  // Desktop / no-gyro fallback: follow the pointer.
  if (window.matchMedia("(hover: hover)").matches) {
    window.addEventListener("pointermove", onPointer, { passive: true });
  }

  // Recalibrate neutral pose when the app returns to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) baseBeta = null;
  });
}
