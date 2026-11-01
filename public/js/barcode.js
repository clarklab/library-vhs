// Camera barcode reading for UPC/EAN codes on tape boxes.
// Uses the native BarcodeDetector where the browser has one and falls back to
// the vendored ZXing build (iOS Safari has no BarcodeDetector).

const NATIVE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];
const ZXING_SRC = "/vendor/zxing-library-0.23.0.min.js";
const FRAME_MS = 140;
const MAX_FRAME_WIDTH = 960;

let zxingLoading;
function loadZxing() {
  if (globalThis.ZXing) return Promise.resolve(globalThis.ZXing);
  zxingLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ZXING_SRC;
    script.async = true;
    script.onload = () => (globalThis.ZXing ? resolve(globalThis.ZXing) : reject(new Error("Barcode reader failed to load.")));
    script.onerror = () => { zxingLoading = null; reject(new Error("Barcode reader failed to load.")); };
    document.head.append(script);
  });
  return zxingLoading;
}

/** Returns `decode(canvas) → {code, format} | null`. */
export async function createDecoder({ native = globalThis.BarcodeDetector } = {}) {
  if (native) {
    try {
      const supported = await native.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((format) => supported.includes(format));
      if (formats.length) {
        const detector = new native({ formats });
        return async (canvas) => {
          const [hit] = await detector.detect(canvas);
          return hit?.rawValue ? { code: hit.rawValue, format: hit.format } : null;
        };
      }
    } catch { /* fall through to ZXing */ }
  }
  const ZXing = await loadZxing();
  const names = new Map([[ZXing.BarcodeFormat.UPC_A, "upc_a"], [ZXing.BarcodeFormat.UPC_E, "upc_e"], [ZXing.BarcodeFormat.EAN_13, "ean_13"], [ZXing.BarcodeFormat.EAN_8, "ean_8"]]);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [...names.keys()]], [ZXing.DecodeHintType.TRY_HARDER, true]]));
  return async (canvas) => {
    try {
      // decodeWithState keeps the UPC/EAN hints; decode() without hints would reset them.
      const result = reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas))));
      return { code: result.getText(), format: names.get(result.getBarcodeFormat()) || "" };
    } catch {
      return null; // NotFoundException on most frames
    } finally {
      reader.reset();
    }
  };
}

/** Accepts a code only after it is read the same way `required` frames in a row. */
export function createReadConfirmer(required = 2) {
  let last = "", count = 0;
  return (code) => {
    count = code && code === last ? count + 1 : code ? 1 : 0;
    last = code || "";
    return count >= required;
  };
}

/** Friendly digits for display: 0 86162 11134 3 style for UPC-A. */
export function formatBarcode(code) {
  const digits = String(code || "").replace(/\D/g, "");
  return digits.length === 12 ? `${digits[0]} ${digits.slice(1, 6)} ${digits.slice(6, 11)} ${digits[11]}` : digits;
}

export function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") return "Camera access is off. Allow it in your browser settings, or type the numbers below.";
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") return "No camera found. Type the numbers below instead.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can’t use the camera here. Type the numbers below instead.";
  return "The camera couldn’t start. Type the numbers below instead.";
}

/**
 * Streams the rear camera into `video` and calls `onCode({code, format})` once
 * a code has been read twice in a row. Stops itself when the video leaves the page.
 */
export async function startBarcodeScanner(video, { onCode, decoderFactory = createDecoder } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("No camera API"), { name: "NotSupportedError" });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  let stopped = false, timer = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play();
    const decode = await decoderFactory();
    const confirm = createReadConfirmer();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (stopped) return;
      if (!video.isConnected) { stop(); return; }
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const hit = await decode(canvas).catch(() => null);
        if (stopped) return;
        if (confirm(hit?.code || "")) { stop(); onCode?.(hit); return; }
      }
      timer = setTimeout(tick, FRAME_MS);
    };
    tick();
  } catch (error) {
    stop();
    throw error;
  }
  return { stop };
}
