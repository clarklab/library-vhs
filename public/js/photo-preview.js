// Inspect a stored source photo without changing its pixels or provider payload.
import { openSheet } from "./ui.js";
import { esc } from "./util.js";
import { drawPins, tapePins, countPins, rotatePoint } from "./photo-markers.js";

export function openPhotoPreview({ photo, number, titles = [], compareCount = false, onSelect, onPlace }) {
  let observer;
  let closed = false;
  const { body, sheet, close } = openSheet({
    title: `Photo ${number} · ${titles.length} titles`,
    content: `<div class="scan-source-preview">
      <div class="scan-photo-tools" role="group" aria-label="Photo inspection tools">
        <button class="btn gray" type="button" data-rotate-left aria-label="Rotate photo left 90 degrees"><span aria-hidden="true">↶</span> Left</button>
        <button class="btn gray" type="button" data-rotate-right aria-label="Rotate photo right 90 degrees"><span aria-hidden="true">↷</span> Right</button>
        <button class="btn gray" type="button" data-zoom-out aria-label="Zoom out photo">−</button>
        <output class="scan-photo-zoom" data-photo-zoom role="status" aria-live="polite">100%</output>
        <button class="btn gray" type="button" data-zoom-in aria-label="Zoom in photo">+</button>
        <button class="btn gray" type="button" data-fit-photo aria-label="Fit photo to view">Fit</button>
      </div>
      <div class="scan-photo-viewport" data-photo-viewport tabindex="0" role="region" aria-label="Source photo. Scroll or use arrow keys to inspect enlarged details.">
        <div class="scan-photo-stage" data-photo-stage><img class="scan-photo-image" data-photo-image src="${photo.image}" alt="Photo ${number}: ${esc(photo.name)}" draggable="false" /><div class="scan-preview-pin-layer" data-preview-pins></div></div>
      </div>
      <p class="hint">Rotate to read sideways spines. Zoom in, then scroll to inspect each tape. These controls only change your view.</p>
      <p class="hint">${onPlace ? "Tap the tape to place its dot." : compareCount ? "Outlined dots are the separate count, not title matches." : "Tap a pink dot to open its title. Check for tapes without a dot."}</p>
      <ol>${titles.map((item, index) => `<li value="${item.displayNumber || index + 1}">${esc(item.title || "Unreadable title")}</li>`).join("")}</ol>
    </div>`,
    onClose: () => { closed = true; observer?.disconnect(); },
  });
  sheet.classList.add("scan-photo-sheet");
  const viewport = body.querySelector("[data-photo-viewport]");
  const stage = body.querySelector("[data-photo-stage]");
  const image = body.querySelector("[data-photo-image]");
  const pinLayer = body.querySelector("[data-preview-pins]");
  const output = body.querySelector("[data-photo-zoom]");
  const zoomOut = body.querySelector("[data-zoom-out]");
  const zoomIn = body.querySelector("[data-zoom-in]");
  let rotation = 0;
  let zoom = 1;
  const maxZoom = 8;

  function draw({ center = false } = {}) {
    if (closed || !body.isConnected || !image.naturalWidth || !viewport.clientWidth) return;
    const centerX = center ? 0.5 : (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(stage.offsetWidth, 1);
    const centerY = center ? 0.5 : (viewport.scrollTop + viewport.clientHeight / 2) / Math.max(stage.offsetHeight, 1);
    const sideways = rotation % 180 !== 0;
    const rotatedWidth = sideways ? image.naturalHeight : image.naturalWidth;
    const rotatedHeight = sideways ? image.naturalWidth : image.naturalHeight;
    const fit = Math.min((viewport.clientWidth - 2) / rotatedWidth, (viewport.clientHeight - 2) / rotatedHeight, 1);
    const scale = Math.max(0.01, fit) * zoom;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    // The stage follows the rotated bounds so every edge stays scrollable.
    stage.style.width = `${Math.max(viewport.clientWidth, Math.ceil(sideways ? height : width))}px`;
    stage.style.height = `${Math.max(viewport.clientHeight, Math.ceil(sideways ? width : height))}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    pinLayer.style.width = `${sideways ? height : width}px`;
    pinLayer.style.height = `${sideways ? width : height}px`;
    drawPins(pinLayer, compareCount ? countPins(photo) : tapePins(titles), { rotation, onSelect: (pin) => {
      if (pin.counter || !onSelect) return;
      close(); onSelect(pin.id);
    } });
    viewport.scrollLeft = stage.offsetWidth * centerX - viewport.clientWidth / 2;
    viewport.scrollTop = stage.offsetHeight * centerY - viewport.clientHeight / 2;
    output.textContent = `${Math.round(zoom * 100)}%`;
    output.setAttribute("aria-label", `${Math.round(zoom * 100)} percent of fitted size, rotated ${rotation} degrees`);
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= maxZoom;
  }
  body.querySelector("[data-rotate-left]").onclick = () => { rotation = (rotation + 270) % 360; draw({ center: true }); };
  body.querySelector("[data-rotate-right]").onclick = () => { rotation = (rotation + 90) % 360; draw({ center: true }); };
  zoomOut.onclick = () => { zoom = Math.max(1, zoom / 1.5); draw(); };
  zoomIn.onclick = () => { zoom = Math.min(maxZoom, zoom * 1.5); draw(); };
  body.querySelector("[data-fit-photo]").onclick = () => { zoom = 1; draw({ center: true }); };
  image.onload = () => draw({ center: true });
  if (onPlace) {
    pinLayer.classList.add("placing");
    pinLayer.onclick = (event) => {
      if (event.target.closest(".tape-pin")) return;
      const bounds = pinLayer.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const point = rotatePoint({ x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) }, -rotation);
      close(); onPlace(point);
    };
  }
  observer = new ResizeObserver(() => draw({ center: zoom === 1 }));
  observer.observe(viewport);
  requestAnimationFrame(() => draw({ center: true }));
}
