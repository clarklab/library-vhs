import { api, getToken } from "./api.js";
import { state, go, refreshTapes } from "./app.js";
import { esc, downloadFile } from "./util.js";
import { icons } from "./icons.js";
import { backupSummary } from "./backup-formats.js";
import { fileWorker, collectAccountBackup, createRestorePlan, runRestorePlan } from "./backup-io.js";

let activeController = null;
export function disposeBackup() { activeController?.abort(); activeController = null; }
const BACKUP_RENDER = Symbol("backup-render");
const stamp = () => new Date().toISOString().slice(0,10);

export function renderBackup(root) {
  disposeBackup();
  const userId = state.user?.id, expectedToken = getToken(), renderId = Symbol("backup");
  root[BACKUP_RENDER] = renderId;
  let busy = false, preview = null, plan = null, retryAction = null;
  const visible = () => root.isConnected && root[BACKUP_RENDER] === renderId && state.view === "backup" && state.user?.id === userId && getToken() === expectedToken;
  const ensure = () => { if (!visible()) throw new DOMException("Backup view closed", "AbortError"); };
  root.innerHTML = `<div class="screen backup-screen"><header class="backup-header"><div><p class="eyebrow">KEEP A COPY. KEEP CONTROL.</p><h1>Take your collection<br>with you<span class="accent-dot">.</span></h1><p>Back up your saved account or bring a collection in. Your titles, details and history stay yours.</p></div><button class="btn gray" data-account>← Account</button></header>
    <div class="backup-options"><section class="backup-card backup-card-primary"><p class="eyebrow">RECOMMENDED · COMPLETE COPY</p><h2>Full account backup</h2><p>One JSON file with your collection, scout lists, saved estimates and uploaded covers. Keeps original record IDs, dates, sale prices and metadata.</p><button class="btn" data-export="json">${icons.export} Download full backup</button><small>Saved account data only. Unfinished scans and their original shelf photos stay on this device. Passwords and account keys are excluded.</small></section><section class="backup-card"><p class="eyebrow">EDITABLE COLLECTION TABLE</p><h2>Work in a spreadsheet</h2><p>All collection fields, including stable IDs, sale history, tags and cover links. Open Excel for a real .xlsx workbook, or CSV for a plain-text table.</p><div class="backup-actions"><button class="btn gray" data-export="xlsx">${icons.table} Download Excel</button><button class="btn gray" data-export="csv">${icons.fileCsv} Download CSV</button></div><small>Tables contain collection records only. Use the full backup for scout lists, estimates and uploaded image files.</small></section></div>
    <section class="backup-import" data-drop><div><p class="eyebrow">BRING YOUR DATA IN</p><h2>Import a file</h2><p>Drop a JSON backup, Excel workbook, CSV or TSV. We’ll detect the format and show a preview before saving anything.</p></div><button class="btn gray" data-choose>${icons.plus} Choose import file</button><input type="file" data-import-file accept=".json,.xlsx,.xls,.csv,.tsv,.txt,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden /><p class="backup-import-note">Imports add missing records. Existing records and edits are kept, even when you import the same file again. To update existing titles, use your collection editor.</p></section>
    <section class="backup-status" data-status-wrap hidden aria-live="polite"><p data-status role="status"></p><progress data-progress max="1" value="0" aria-label="Backup progress"></progress><div class="backup-actions"><button class="btn gray" data-stop hidden>Stop</button><button class="btn gray" data-retry hidden>Try again</button></div></section>
    <section class="backup-preview" data-preview hidden aria-label="Import preview"></section></div>`;
  root.querySelector("[data-account]").addEventListener("click",() => go("settings"));
  root.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click",() => run(() => exportData(button.dataset.export))));
  root.querySelector("[data-choose]").addEventListener("click",() => root.querySelector("[data-import-file]").click());
  root.querySelector("[data-import-file]").addEventListener("change",(event) => { const file = event.target.files?.[0]; if (file) run(() => readFile(file)); event.target.value = ""; });
  const drop = root.querySelector("[data-drop]");
  drop.addEventListener("dragover",(event) => { event.preventDefault(); if (!busy) drop.classList.add("drag-over"); });
  drop.addEventListener("dragleave",() => drop.classList.remove("drag-over"));
  drop.addEventListener("drop",(event) => { event.preventDefault(); drop.classList.remove("drag-over"); if (busy) return; const files = event.dataTransfer?.files; if (files?.length !== 1) { status("Choose one file at a time.",true); return; } run(() => readFile(files[0])); });
  root.querySelector("[data-stop]").addEventListener("click",() => { activeController?.abort(); });
  root.querySelector("[data-retry]").addEventListener("click",() => { if (retryAction) run(retryAction); });

  function status(message,error = false,progress = null) {
    if (!visible()) return;
    const wrap = root.querySelector("[data-status-wrap]"); wrap.hidden = false; wrap.classList.toggle("has-error",error);
    root.querySelector("[data-status]").textContent = message;
    const meter = root.querySelector("[data-progress]"); meter.hidden = !busy;
    if (progress && progress.total > 0) { meter.max = progress.total; meter.value = progress.complete; }
    else meter.removeAttribute("value");
  }
  function paintBusy() {
    if (!visible()) return;
    root.querySelectorAll("[data-export],[data-choose],[data-confirm-import],[data-dismiss]").forEach((button) => { button.disabled = busy || (button.hasAttribute("data-confirm-import") && (preview?.issues.some((item) => item.severity === "error") || plan?.completed)); });
    root.querySelector("[data-stop]").hidden = !busy;
    root.querySelector("[data-retry]").hidden = busy || !retryAction;
    root.querySelector("[data-progress]").hidden = !busy;
  }
  async function run(action) {
    if (busy || !visible()) return;
    root.querySelectorAll("[data-status-wrap] .backup-issues").forEach((list) => list.remove());
    busy = true; retryAction = null; const controller = new AbortController(); activeController = controller; paintBusy();
    try { await action(); }
    catch (error) {
      if (!visible()) return;
      retryAction = action;
      status(error.name === "AbortError" ? "Stopped. Completed imports are kept. Try again to continue safely." : error.message,true);
      if (error.failures?.length) {
        const list = document.createElement("ul"); list.className = "backup-issues";
        for (const item of error.failures.slice(0,20)) { const entry = document.createElement("li"); entry.textContent = `${item.title}: ${item.message}`; list.appendChild(entry); }
        root.querySelector("[data-status-wrap]").appendChild(list);
      }
    } finally {
      if (activeController === controller) activeController = null;
      busy = false; paintBusy();
    }
  }
  const options = () => ({expectedToken,signal:activeController?.signal});
  const progress = (value) => { ensure(); status(value.message,false,value); };
  async function exportData(format) {
    ensure(); status("Reading your saved account…");
    if (format === "json") {
      const backup = await collectAccountBackup(api,options(),progress);
      const text = await fileWorker("json",{backup},options()); ensure();
      downloadFile(`vhs-vault-backup-${stamp()}.json`,text,"application/json");
      const summary = backupSummary(backup);
      status(`Backup downloaded: ${summary.tapes} collection records, ${summary.scouts} scout lists and ${summary.covers} uploaded covers.`);
    } else {
      const {tapes} = await api.listTapes(options()); ensure(); status(`Preparing ${tapes.length} collection records…`);
      const data = await fileWorker(format,{tapes,options:{accountId:userId}},options()); ensure();
      downloadFile(`vhs-vault-collection-${stamp()}.${format}`,data,format === "csv" ? "text/csv;charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      status(`${format === "csv" ? "CSV" : "Excel"} downloaded: ${tapes.length} collection records.`);
    }
  }
  async function readFile(file) {
    ensure(); preview = null; plan = null; root.querySelector("[data-preview]").hidden = true;
    const signature = (await file.slice(0,256).text()).replace(/^\ufeff/, "").trimStart();
    const json = signature.startsWith("{") || signature.startsWith("[");
    const limit = json ? 512 : 20;
    if (file.size > limit * 1024 * 1024) throw new Error(`This ${json ? "JSON backup" : "spreadsheet"} is larger than ${limit} MB. ${json ? "Use a device with more capacity or contact support before changing this backup." : "Split the table into smaller files and try again."}`);
    if (!file.size) throw new Error("This file is empty.");
    status(`Reading ${file.name}…`);
    const result = await fileWorker("parse",{buffer:await file.arrayBuffer()},options()); ensure();
    preview = {...result,fileName:file.name};
    const summary = backupSummary(preview.backup);
    if (!summary.tapes && !summary.scouts && !summary.covers) preview.issues.push({severity:"error",message:"There are no records to import."});
    showPreview(); status("Preview ready. Review the file below before importing.");
  }
  function showPreview() {
    const summary = backupSummary(preview.backup), issues = preview.issues, errors = issues.filter((item) => item.severity === "error");
    const rows = (Array.isArray(preview.backup.tapes) ? preview.backup.tapes : []).slice(0,8);
    const panel = root.querySelector("[data-preview]"); panel.hidden = false;
    panel.innerHTML = `<p class="eyebrow">REVIEW BEFORE IMPORT</p><h2>${esc(preview.fileName)}</h2><p>${esc(preview.type)} · ${errors.length ? `${errors.length} issue${errors.length === 1 ? "" : "s"} to fix` : "Ready to import"}</p><div class="backup-counts"><span><strong>${summary.tapes}</strong> collection records</span><span><strong>${summary.scouts}</strong> scout lists</span><span><strong>${summary.estimates}</strong> saved estimates</span><span><strong>${summary.covers}</strong> uploaded covers</span></div>${rows.length ? `<div class="backup-table-wrap"><table class="backup-table"><thead><tr><th>Title</th><th>Format</th><th>Status</th><th>Sold price</th></tr></thead><tbody>${rows.map((tape) => `<tr><td>${esc(tape?.title || "Missing title")}</td><td>${esc(tape?.format || "VHS")}</td><td>${esc(tape?.status || "keep")}</td><td>${tape?.priceSold === null || tape?.priceSold === undefined ? "—" : esc(tape.priceSold)}</td></tr>`).join("")}</tbody></table></div>${summary.tapes > rows.length ? `<p class="caption">Showing ${rows.length} of ${summary.tapes} collection records.</p>` : ""}` : ""}${summary.scouts ? `<p>Scout lists: ${esc(preview.backup.scouts.filter((list) => list && typeof list === "object").slice(0,8).map((list) => `${list.name} (${list.items?.length || 0} items)`).join(", "))}${summary.scouts > 8 ? "…" : ""}</p>` : ""}${issues.length ? `<ul class="backup-issues">${issues.slice(0,30).map((item) => `<li class="${item.severity === "error" ? "error" : "warning"}">${item.row ? `${typeof item.row === "number" ? "Row " : ""}${esc(item.row)}: ` : ""}${esc(item.message)}</li>`).join("")}${issues.length > 30 ? `<li>${issues.length-30} additional issues. Fix the file and choose it again.</li>` : ""}</ul>` : ""}<p>Existing records are kept unchanged. Distinct physical copies stay separate. No AI lookup runs during import.</p><div class="backup-actions"><button class="btn" data-confirm-import ${errors.length ? "disabled" : ""}>Import ${summary.tapes+summary.scouts+summary.covers} ${summary.tapes+summary.scouts+summary.covers === 1 ? "record" : "records"}</button><button class="btn gray" data-dismiss>Dismiss preview</button></div>`;
    panel.querySelector("[data-confirm-import]").addEventListener("click",() => run(importData));
    panel.querySelector("[data-dismiss]").addEventListener("click",() => { preview = null; plan = null; panel.hidden = true; });
    panel.scrollIntoView({behavior:"smooth",block:"start"});
  }
  async function importData() {
    ensure();
    if (!preview || preview.issues.some((item) => item.severity === "error")) return;
    if (!plan) plan = await createRestorePlan(preview.backup);
    ensure(); await runRestorePlan(plan,api,options(),progress); ensure();
    const message = `Import complete. ${plan.created} records added; ${plan.existing} already present. Your existing edits are unchanged.`;
    try { await refreshTapes(); }
    catch { ensure(); status(`${message} Open your collection again to refresh its display.`); return; }
    ensure(); status(message);
  }
}
