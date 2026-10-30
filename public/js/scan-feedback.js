import { esc } from "./util.js";
import { sessionSummary, canRetryPhoto, canRetryAfterServiceUpdate } from "./scan-session.js";

const elapsed = (start, now = Date.now()) => {
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
const reconnectable = (photo) => Boolean(photo.jobId) && !["failed", "expired", "completed", "complete"].includes(photo.jobStatus);
const phase = (photo) => {
  if (photo.status === "preparing") return "Preparing photo";
  if (photo.status === "complete") return "Ready to review";
  if (photo.status === "error") return "Needs attention";
  if (photo.stage === "verifying") return photo.initialResult?.tapes?.length ? `Checking the first ${photo.initialResult.tapes.length} titles` : "Checking the first reading";
  if (photo.stage === "queued") return "Starting background scan";
  if (photo.jobProgress?.countFinished && Number.isInteger(photo.jobProgress.independentCount)) return `${photo.jobProgress.independentCount} possible tapes counted · reading labels`;
  return photo.status === "processing" ? "Reading titles and counting tapes" : "Waiting to start";
};

export function scanFailureCopy(photo) {
  const message = photo.error || "The scan did not finish.";
  const code = photo.errorCode || (/Request failed \((\d+)\)/.exec(message)?.[1] ? `HTTP_${/Request failed \((\d+)\)/.exec(message)[1]}` : "");
  if (["HTTP_504", "AI_TIMEOUT", "REQUEST_TIMEOUT", "HTTP_408"].includes(code)) return { message: "The scan timed out before it finished.", next: reconnectable(photo) ? "Retry to reconnect to this scan. Any completed work is kept." : "Retry this photo. Large shelves can take a few minutes." };
  if (["AI_CONFIGURATION", "AI_UNAVAILABLE", "HTTP_404"].includes(code)) return { message: "The scanning service could not start this photo.", next: "Try again after the service is available. Your photo can also be reviewed manually." };
  if (["AI_RATE_LIMITED", "HTTP_429"].includes(code)) return { message: "The scanning service is busy right now.", next: "Wait for the retry button, then continue with this photo." };
  if (["AI_TRUNCATED", "INVALID_IMAGE", "IMAGE_PREPARATION_FAILED", "PHOTO_PREPARATION_FAILED"].includes(code)) return { message, next: "Choose another photo or take closer pictures of smaller shelf sections." };
  return { message, next: photo.retryable === false ? "Choose another photo, or add its titles manually." : "Retry to continue. Your other photos and reviewed titles are kept." };
}

// Keep live feedback outside the editable title list. Timer updates never
// rebuild controls, steal focus, or pretend to know model completion percent.
export function createScanFeedback(root, { onSelect, onRetry, onChoose, onPause, onResume, onReview }) {
  let session, fingerprint = "", timer;
  root.classList.add("scan-feedback");
  root.hidden = true;
  root.innerHTML = `<div class="scan-feedback-header"><span class="scan-feedback-symbol" aria-hidden="true"><i></i></span><div class="scan-feedback-copy"><p class="eyebrow" data-feedback-eyebrow>SCAN IN PROGRESS</p><h2 data-feedback-title aria-live="polite" aria-atomic="true"></h2><p data-feedback-description></p></div><button type="button" class="btn gray" data-feedback-action></button></div><div class="scan-feedback-track" aria-hidden="true"><i></i></div><p class="scan-feedback-total" data-feedback-total></p><ol class="scan-active-photos" data-active-photos></ol><div class="scan-failure-list" data-scan-failures></div>`;
  const $ = (selector) => root.querySelector(selector);
  const action = $("[data-feedback-action]");
  function tick() {
    if (!session || !root.isConnected) return;
    const now = Date.now();
    root.querySelectorAll("[data-elapsed]").forEach((node) => {
      const start = Number(node.dataset.elapsed);
      node.textContent = start > 0 ? `${elapsed(start, now)} elapsed` : "Connecting…";
    });
    root.querySelectorAll("[data-retry-id]").forEach((button) => {
      const photo = session.draft.photos.find((item) => item.id === button.dataset.retryId);
      if (!photo) return;
      const wait = Math.max(0, Math.ceil(((photo.retryAfter || 0) - now) / 1000));
      const service = button.dataset.serviceRetry === "true";
      button.disabled = session.saving || (service ? wait > 0 : !canRetryPhoto(photo, now));
      button.textContent = wait ? `Retry in ${wait}s` : service ? "Check service again" : reconnectable(photo) ? "Reconnect to scan" : "Retry photo";
    });
    const slow = session.draft.photos.some((photo) => photo.status === "processing" && photo.startedAt && now - photo.startedAt > 30000);
    root.classList.toggle("taking-time", slow);
    const note = $("[data-slow-note]");
    if (note) note.hidden = !slow;
  }
  function update(next) {
    session = next;
    const { draft } = session, stats = sessionSummary(draft);
    const active = draft.photos.filter((photo) => ["preparing", "processing"].includes(photo.status));
    const errors = draft.photos.filter((photo) => photo.status === "error");
    const warnings = draft.photos.filter((photo) => photo.status === "complete" && (photo.verificationError || photo.verification?.error));
    const hasStarted = draft.photos.some((photo) => photo.startedAt || photo.jobId || photo.attemptCount);
    const paused = draft.paused && stats.pending > 0 && hasStarted && !active.length;
    const complete = stats.photos > 0 && stats.completed === stats.photos;
    const show = active.length > 0 || errors.length > 0 || paused || complete || warnings.length > 0 || (!draft.paused && stats.pending > 0);
    root.hidden = !show;
    if (!show) { clearInterval(timer); timer = null; return; }
    const busy = active.length > 0 || (!draft.paused && stats.pending > 0);
    const state = busy ? "busy" : paused ? "paused" : errors.length ? "error" : "complete";
    root.dataset.state = state;
    $("[data-feedback-eyebrow]").textContent = busy ? "SCAN IN PROGRESS" : paused ? "SCAN UPDATES PAUSED" : errors.length ? "SCAN NEEDS ATTENTION" : "SCAN FINISHED";
    const titles = draft.items.length;
    $("[data-feedback-title]").textContent = busy ? active.some((photo) => photo.status === "processing") ? active.every((photo) => photo.stage === "verifying") ? "Double-checking your tapes…" : active.every((photo) => photo.stage === "queued") ? "Starting your scan…" : "Reading your shelf…" : "Getting your photos ready…" : paused ? "Pick up where you left off." : errors.length ? stats.completed ? "Some photos need another try." : "Your photo couldn’t finish." : titles ? `${titles} title${titles === 1 ? " is" : "s are"} ready to review.` : "No tapes were identified.";
    $("[data-feedback-description]").textContent = busy ? "Large shelves can take a few minutes. We’ll show each photo’s progress here." : paused ? "Submitted scans can keep running in the background. Resume to see their results." : errors.length ? "The reason and next step are shown below. Your photo is kept for another try." : titles ? "Check the photo dots and titles before choosing where to save them." : "Try a closer shelf photo, or add its titles manually.";
    $("[data-feedback-total]").textContent = `${stats.completed} of ${stats.photos} photo${stats.photos === 1 ? "" : "s"} ready${stats.errors ? ` · ${stats.errors} need attention` : ""}`;
    action.hidden = !(busy || paused || titles);
    action.textContent = busy ? "Pause updates" : paused ? "Resume updates" : "Review tapes";
    action.disabled = session.saving;
    action.onclick = busy ? onPause : paused ? onResume : onReview;
    const key = JSON.stringify([active.map((photo) => [photo.id, photo.status, photo.stage, photo.startedAt, photo.stageStartedAt, photo.jobProgress, photo.initialResult?.tapes?.length]), errors.map((photo) => [photo.id, photo.error, photo.errorCode, photo.errorStatus, photo.errorDetails, photo.requestId, photo.retryable, photo.retryAfter, photo.jobId, photo.jobStatus, photo.errorDiagnostics]), warnings.map((photo) => [photo.id, photo.verificationError, photo.verification?.error]), session.saving]);
    if (key !== fingerprint) {
      fingerprint = key;
      $("[data-active-photos]").innerHTML = active.map((photo) => `<li><span class="scan-working-dot" aria-hidden="true"></span><div><strong>Photo ${draft.photos.indexOf(photo) + 1}</strong><span>${esc(phase(photo))}</span></div><time data-elapsed="${Number(photo.startedAt || photo.preparationStartedAt || Date.now())}" aria-live="off"></time></li>`).join("") + (busy ? '<li class="scan-slow-note" data-slow-note hidden>This is still running. Larger photos and the extra accuracy check take longer.</li>' : "");
      $("[data-scan-failures]").innerHTML = errors.map((photo) => {
        const copy = scanFailureCopy(photo), service = canRetryAfterServiceUpdate(photo);
        const retry = photo.image && (photo.retryable !== false || service);
        const details = [photo.errorCode || photo.errorStatus && `HTTP ${photo.errorStatus}`, photo.requestId && `Reference: ${photo.requestId}`, photo.errorDetails, photo.errorDiagnostics?.stage && `Stage: ${photo.errorDiagnostics.stage}`, photo.errorDiagnostics?.providerStatus && `Provider HTTP ${photo.errorDiagnostics.providerStatus}`, photo.errorDiagnostics?.providerRequestId && `Provider reference: ${photo.errorDiagnostics.providerRequestId}`].filter(Boolean).join(" · ");
        return `<article class="scan-failure" role="alert"><div><button type="button" class="scan-failure-photo" data-failure-photo="${esc(photo.id)}">Photo ${draft.photos.indexOf(photo) + 1}</button><h3>${esc(copy.message)}</h3><p>${esc(copy.next)}</p>${details ? `<details><summary>Technical details</summary><p>${esc(details)}</p></details>` : ""}</div><div class="scan-failure-actions">${retry ? `<button class="btn" type="button" data-retry-id="${esc(photo.id)}" data-service-retry="${service}">Retry photo</button>` : ""}<button class="btn gray" type="button" data-choose-replacement>Choose another photo</button></div></article>`;
      }).join("") + warnings.map((photo) => `<article class="scan-verification-warning" role="status"><strong>Photo ${draft.photos.indexOf(photo) + 1}: check the first reading</strong><p>${esc(photo.verificationError || photo.verification?.error?.error || photo.verification?.error?.message || "The separate count did not finish. Check every tape in this photo.")}</p><button class="scan-text-button" data-failure-photo="${esc(photo.id)}">Review this photo</button></article>`).join("");
      root.querySelectorAll("[data-failure-photo]").forEach((button) => { button.onclick = () => onSelect(button.dataset.failurePhoto); });
      root.querySelectorAll("[data-retry-id]").forEach((button) => { button.onclick = () => onRetry(button.dataset.retryId, { afterServiceUpdate: button.dataset.serviceRetry === "true" }); });
      root.querySelectorAll("[data-choose-replacement]").forEach((button) => { button.onclick = onChoose; });
    }
    tick();
    if (!timer && (busy || errors.some((photo) => photo.retryAfter > Date.now()))) timer = setInterval(tick, 1000);
    else if (!busy && !errors.some((photo) => photo.retryAfter > Date.now())) { clearInterval(timer); timer = null; }
  }
  return { update, destroy() { clearInterval(timer); session = null; }, show() { if (!root.hidden) root.scrollIntoView({ behavior: "smooth", block: "start" }); } };
}
