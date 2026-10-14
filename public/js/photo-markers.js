// Coordinates always refer to the uploaded image, before display rotation.
export function markerPoint(value) {
  return value && typeof value.x === "number" && typeof value.y === "number" &&
    Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1
    ? { x: value.x, y: value.y } : null;
}

export function rotatePoint(point, degrees = 0) {
  const turn = ((degrees % 360) + 360) % 360;
  if (turn === 90) return { x: 1 - point.y, y: point.x };
  if (turn === 180) return { x: 1 - point.x, y: 1 - point.y };
  if (turn === 270) return { x: point.y, y: 1 - point.x };
  return { ...point };
}

export function tapePins(items) {
  return items.flatMap((item, index) => {
    const marker = markerPoint(item.marker);
    return marker ? [{ id: item.clientId || `source-${index}`, marker, number: item.displayNumber || index + 1,
      title: item.title || "Unreadable tape", uncertain: Boolean(item.markerIssue || (item.needsReview && !item.confirmed)), excluded: item.include === false }] : [];
  });
}

export function countPins(photo) {
  return (photo?.verification?.positions || []).flatMap((position, index) => {
    const marker = markerPoint(position.marker);
    return marker ? [{ id: `count-${index}`, marker, number: index + 1, title: position.label || "Counted position", uncertain: true, counter: true }] : [];
  });
}

const layers = new WeakMap();
export function drawPins(layer, pins, { rotation = 0, selectedId, onSelect } = {}) {
  let nodes = layers.get(layer);
  if (!nodes) { nodes = new Map(); layers.set(layer, nodes); }
  const ids = new Set(pins.map((pin) => pin.id));
  for (const [id, button] of nodes) if (!ids.has(id)) { button.remove(); nodes.delete(id); }
  const width = layer.clientWidth, height = layer.clientHeight;
  const points = pins.map((pin) => rotatePoint(pin.marker, rotation));
  for (const [index, pin] of pins.entries()) {
    let button = nodes.get(pin.id);
    if (!button) { button = document.createElement("button"); button.type = "button"; button.dataset.markerId = pin.id; nodes.set(pin.id, button); layer.append(button); }
    const point = points[index];
    const crowded = width > 0 && height > 0 && points.some((other, otherIndex) => otherIndex !== index && Math.hypot((other.x - point.x) * width, (other.y - point.y) * height) < 26);
    button.className = `tape-pin${crowded ? " compact" : ""}${pin.uncertain ? " uncertain" : ""}${pin.excluded ? " excluded" : ""}${pin.counter ? " counter" : ""}${pin.id === selectedId ? " selected" : ""}`;
    button.style.left = `${point.x * 100}%`; button.style.top = `${point.y * 100}%`;
    button.textContent = pin.number;
    button.setAttribute("aria-label", `${pin.counter ? "Count position" : "Tape"} ${pin.number}: ${pin.title}${pin.excluded ? ", excluded" : ""}`);
    button.setAttribute("aria-pressed", String(pin.id === selectedId));
    button.onclick = (event) => { event.stopPropagation(); onSelect?.(pin); };
  }
}

export function createPhotoMap(root, { onSelect, onPlace } = {}) {
  root.innerHTML = `<div class="photo-map-frame"><div class="photo-map-content"><img alt="Selected shelf photo" draggable="false" data-map-image /><div class="photo-map-pins" data-map-pins></div><span class="photo-map-crosshair" hidden aria-hidden="true">+</span></div></div>`;
  const frame = root.querySelector(".photo-map-frame"), content = root.querySelector(".photo-map-content");
  const image = root.querySelector("img"), layer = root.querySelector("[data-map-pins]"), crosshair = root.querySelector(".photo-map-crosshair");
  let photo, pins = [], selectedId, placing = false, keyboardPoint = { x: .5, y: .5 };
  const resize = () => {
    if (!image.naturalWidth || !frame.clientWidth) return;
    const maximum = window.matchMedia("(max-width: 700px)").matches ? 430 : 570;
    const ratio = Math.min(frame.clientWidth / image.naturalWidth, maximum / image.naturalHeight, 1);
    content.style.width = `${image.naturalWidth * ratio}px`;
    content.style.height = `${image.naturalHeight * ratio}px`;
    drawPins(layer, pins, { selectedId, onSelect });
  };
  image.onload = resize;
  const observer = new ResizeObserver(resize); observer.observe(frame);
  content.onclick = (event) => {
    if (!placing || event.target.closest(".tape-pin")) return;
    const bounds = content.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    onPlace?.({ x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) });
  };
  content.onkeydown = (event) => {
    if (!placing || event.target !== content) return;
    const movement = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02] }[event.key];
    if (movement) {
      event.preventDefault(); keyboardPoint = { x: Math.max(0, Math.min(1, keyboardPoint.x + movement[0])), y: Math.max(0, Math.min(1, keyboardPoint.y + movement[1])) };
      crosshair.hidden = false; crosshair.style.left = `${keyboardPoint.x * 100}%`; crosshair.style.top = `${keyboardPoint.y * 100}%`;
    } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); onPlace?.(keyboardPoint); }
  };
  return {
    update(next) {
      if (photo?.id !== next.photo?.id || image.getAttribute("src") !== next.photo?.image) {
        photo = next.photo; if (photo?.image) image.src = photo.image; else image.removeAttribute("src");
      }
      image.alt = next.alt || "Shelf photo with numbered tape markers";
      pins = next.pins || []; selectedId = next.selectedId; placing = Boolean(next.placing);
      content.classList.toggle("placing", placing); content.tabIndex = placing ? 0 : -1;
      if (placing) { content.setAttribute("role", "button"); content.setAttribute("aria-label", "Place a tape marker. Use arrow keys to move, then Enter to place."); }
      else { content.removeAttribute("role"); content.removeAttribute("aria-label"); crosshair.hidden = true; }
      drawPins(layer, pins, { selectedId, onSelect }); resize();
    },
    focusPlacement() { content.focus(); },
    destroy() { observer.disconnect(); },
  };
}
