import { BACKUP_FORMAT, BACKUP_VERSION, sha256 } from "./backup-formats.js";

export function fileWorker(action, payload, { signal, timeoutMs = 45000 } = {}) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL("./backup-worker.js",import.meta.url),{type:"module"});
    const finish = (error,result) => { clearTimeout(timer); signal?.removeEventListener("abort",abort); worker.terminate(); error ? reject(error) : resolve(result); };
    const abort = () => finish(new DOMException("File operation stopped", "AbortError"));
    const timer = setTimeout(() => finish(new Error("This file took too long to process. Try a smaller file or use the JSON backup.")),timeoutMs);
    worker.onmessage = ({data}) => finish(data.error ? new Error(data.error) : null,data.result);
    worker.onerror = () => finish(new Error("The file reader could not start. Reload and try again."));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort",abort,{once:true});
    worker.postMessage({action,...payload},payload.buffer instanceof ArrayBuffer ? [payload.buffer] : []);
  });
}

const stopped = (signal) => { if (signal?.aborted) throw new DOMException("Operation stopped", "AbortError"); };
export async function collectAccountBackup(client, options = {}, onProgress = () => {}) {
  stopped(options.signal);
  const manifest = await client.backupManifest(options);
  const backup = {format:BACKUP_FORMAT,version:BACKUP_VERSION,source:manifest.source,exportedAt:manifest.exportedAt,tapes:[],scouts:[],covers:[]};
  const total = manifest.tapeIds.length + manifest.scoutIds.length + manifest.coverIds.length;
  let complete = 0, cursor = 0;
  const report = (message) => onProgress({complete,total,message});
  report("Reading your collection…");
  const seenCursors = new Set();
  do {
    stopped(options.signal);
    if (seenCursors.has(cursor)) throw new Error("The collection paging response repeated. Try the backup again.");
    seenCursors.add(cursor);
    const page = await client.backupTapes(cursor,options);
    if (!Array.isArray(page.records)) throw new Error("The collection response was incomplete. Try again.");
    backup.tapes.push(...page.records); complete += page.records.length; report(`Collected ${backup.tapes.length} collection records…`);
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  for (const id of manifest.scoutIds) {
    stopped(options.signal);
    let scout, next = 0, totalItems; const visited = new Set();
    do {
      if (visited.has(next)) throw new Error("The scout list paging response repeated. Try again.");
      visited.add(next);
      const page = await client.backupScout(id,next,options);
      if (!page.record || !Array.isArray(page.record.items)) throw new Error("A scout list response was incomplete. Try again.");
      if (!scout) { scout = {...page.record,items:[]}; totalItems = page.totalItems; }
      scout.items.push(...page.record.items); next = page.nextCursor;
    } while (next !== null && next !== undefined);
    if (totalItems !== undefined && scout.items.length !== totalItems) throw new Error("A scout list was incomplete. Try the backup again.");
    backup.scouts.push(scout); complete++; report(`Collected ${backup.scouts.length} scout lists…`);
  }
  for (const id of manifest.coverIds) {
    stopped(options.signal);
    const cover = await client.backupCover(id,options);
    if (cover.id !== id || typeof cover.data !== "string" || !cover.sha256) throw new Error("An uploaded cover was incomplete. Try again.");
    backup.covers.push(cover); complete++; report(`Collected ${backup.covers.length} uploaded covers…`);
  }
  const finalManifest = await client.backupManifest(options);
  const sameIds = (kind) => [...manifest[kind]].sort().join("\0") === backup[kind === "tapeIds" ? "tapes" : kind === "scoutIds" ? "scouts" : "covers"].map((record) => record.id).sort().join("\0");
  if (finalManifest.fingerprint !== manifest.fingerprint || !manifest.fingerprint || !["tapeIds","scoutIds","coverIds"].every(sameIds)) throw new Error("Your saved collection changed while backing up. Run the backup again to capture a consistent copy.");
  report("All saved data collected. Preparing your file…");
  return backup;
}

export async function createRestorePlan(backup) {
  const common = {format:BACKUP_FORMAT,version:BACKUP_VERSION,source:backup.source,exportedAt:backup.exportedAt};
  const tasks = [];
  for (const cover of backup.covers) tasks.push({payload:{...common,kind:"covers",records:[cover]},label:"uploaded covers",done:false});
  for (let i = 0; i < backup.tapes.length; i += 100) tasks.push({payload:{...common,kind:"tapes",records:backup.tapes.slice(i,i+100)},label:"collection records",done:false});
  for (const scout of backup.scouts) {
    const count = Math.ceil(scout.items.length/100), snapshotId = await sha256(JSON.stringify(scout));
    for (let i = 0; i < count; i++) tasks.push({payload:{...common,kind:"scouts",records:[{...scout,items:scout.items.slice(i*100,(i+1)*100)}],scoutPart:{index:i,count,totalItems:scout.items.length,snapshotId}},label:`scout list “${scout.name}”`,done:false});
  }
  return {tasks,created:0,existing:0,failures:[],completed:false};
}

// A task is acknowledged only after every requested ID is accounted for. Lost
// responses leave the same stable IDs queued for safe additive retries.
export async function runRestorePlan(plan, client, options = {}, onProgress = () => {}) {
  plan.failures = [];
  for (const task of plan.tasks) {
    if (task.done) continue;
    stopped(options.signal);
    onProgress({complete:plan.tasks.filter((item) => item.done).length,total:plan.tasks.length,message:`Restoring ${task.label}…`,created:plan.created,existing:plan.existing});
    const response = await client.restoreBackup(task.payload,options);
    const results = Array.isArray(response.results) ? response.results : [];
    const accepted = new Set();
    for (const record of task.payload.records) {
      const result = results.find((entry) => entry.sourceId === record.id);
      const finalScoutPart = task.payload.scoutPart && task.payload.scoutPart.index === task.payload.scoutPart.count-1;
      if (result && (["created","existing"].includes(result.status) || (result.status === "staged" && task.payload.scoutPart && !finalScoutPart))) {
        accepted.add(record.id);
        if (result.status === "created") plan.created++;
        if (result.status === "existing") plan.existing++;
      } else {
        if (finalScoutPart && result?.status === "staged") {
          for (const part of plan.tasks) if (part.payload.scoutPart?.snapshotId === task.payload.scoutPart.snapshotId) part.done = false;
        }
        plan.failures.push({id:record.id,title:record.title || record.name || record.id,message:result?.error || "The server did not confirm this record. Retry this file."});
      }
    }
    if (plan.failures.length) {
      task.payload.records = task.payload.records.filter((record) => !accepted.has(record.id));
      const error = new Error(`${plan.failures.length} record${plan.failures.length === 1 ? "" : "s"} could not be restored. Completed records are kept; retry continues the remaining work.`);
      error.failures = plan.failures; throw error;
    }
    task.done = true;
  }
  plan.completed = true;
  onProgress({complete:plan.tasks.length,total:plan.tasks.length,message:`Import complete. ${plan.created} added; ${plan.existing} already present.`,created:plan.created,existing:plan.existing});
  return plan;
}
