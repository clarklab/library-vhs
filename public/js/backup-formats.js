import { validMarketEstimate } from "./market-contract.js";

// Portable account data and table conversion. No DOM or network dependencies.
export const BACKUP_FORMAT = "tape-deck-account-backup";
export const BACKUP_VERSION = 1;
export const TABLE_FORMAT = "tape-deck-table-v1";
export const MAX_TABLE_ROWS = 10000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const limits = { title:300, director:300, artist:200, genre:120, runtime:40, rated:20, plot:1200, imdbRating:10, imdbId:20, posterUrl:600, format:40, edition:200, label:120, packaging:40, acquiredDate:30, acquiredFrom:200, barcode:40, condition:40, status:40, soldDate:30, location:200, notes:2000, source:30 };
export const COLUMNS = [
  ["title","Title"], ["format","Format"], ["year","Year"], ["director","Director"], ["artist","Artist"], ["actors","Actors"], ["genre","Genre"], ["runtime","Runtime"], ["rated","Rated"], ["plot","Plot"], ["imdbRating","IMDb Rating"], ["imdbId","IMDb ID"], ["posterUrl","Cover URL"], ["edition","Edition"], ["label","Studio/Label"], ["packaging","Packaging"], ["sealed","Sealed"], ["condition","Condition"], ["status","Status"], ["pricePaid","Price Paid"], ["priceAsking","Asking Price"], ["priceSold","Sold Price"], ["soldDate","Sold Date"], ["location","Location"], ["acquiredFrom","Where Acquired"], ["acquiredDate","Date Acquired"], ["barcode","Barcode"], ["notes","Notes"], ["tags","Tags"], ["source","Source"], ["estimate","Saved Price Evidence"], ["createdAt","Created At"], ["updatedAt","Updated At"], ["id","Record ID"], ["clientId","Client ID"], ["_sourceAccountId","Source Account ID"], ["_tableFormat","Export Format"],
];
const tapeFields = new Set(COLUMNS.map(([key]) => key).filter((key) => !key.startsWith("_")));
const normalizeHeader = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const aliases = new Map(COLUMNS.flatMap(([key,label]) => [[normalizeHeader(key),key],[normalizeHeader(label),key]]));
for (const [alias,key] of Object.entries({ movie:"title", name:"title", studio:"label", added:"createdAt", purchasedate:"acquiredDate", paid:"pricePaid", asking:"priceAsking", sold:"priceSold", imdb:"imdbId", poster:"posterUrl" })) aliases.set(alias,key);
export const sha256 = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const issue = (issues, message, row = null, severity = "error") => issues.push({ severity, row, message });

export function collectionTable(tapes, { accountId = "tabular-import" } = {}) {
  return [COLUMNS.map(([,label]) => label), ...tapes.map((tape) => COLUMNS.map(([key]) => {
    if (key === "_sourceAccountId") return accountId;
    if (key === "_tableFormat") return TABLE_FORMAT;
    const value = tape[key];
    return value && typeof value === "object" ? JSON.stringify(value) : value ?? "";
  }))];
}

// A leading apostrophe makes spreadsheet formula-like strings inert. Our format
// marker lets the importer reverse this guard without changing literal titles.
export function encodeCsv(rows) {
  return "\ufeff" + rows.map((row) => row.map((value) => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s]*[=+\-@']|^[\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\r\n");
}

export function parseDelimited(text) {
  text = String(text).replace(/^\ufeff/, "");
  const firstLine = text.split(/\r?\n/,1)[0];
  const counts = new Map([[",",0],["\t",0],[";",0]]);
  let quoted = false;
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i];
    if (c === '"') { if (quoted && firstLine[i+1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)+1);
  }
  const delimiter = [...counts].sort((a,b) => b[1]-a[1])[0][0];
  const rows = []; let row = [], cell = ""; quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (quoted) throw new Error("A quoted CSV cell is unfinished. Close its quote and try again.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function validEstimate(estimate) {
  if (!estimate || typeof estimate !== "object" || Array.isArray(estimate)) return false;
  const fields = ["known","low","high","typical","demand","factors","summary","source","currency","liveComps","worthChecking","estimatedAt","market"];
  let valid = Object.keys(estimate).every((key) => fields.includes(key));
  valid &&= ["known","liveComps","worthChecking"].every((key) => typeof estimate[key] === "boolean") && estimate.currency === "USD";
  valid &&= estimate.source === "live_web_search" ? validMarketEstimate(estimate) : estimate.source === "ai_estimate" && estimate.liveComps === false && estimate.market === undefined;
  valid &&= ["low","high","typical"].every((key) => estimate[key] === null || (typeof estimate[key] === "number" && Number.isFinite(estimate[key]) && estimate[key] >= 0 && estimate[key] <= 1000000));
  valid &&= ["hot","steady","slow"].includes(estimate.demand) && Array.isArray(estimate.factors) && estimate.factors.length <= 4 && estimate.factors.every((factor) => typeof factor === "string" && factor.length <= 200) && typeof estimate.summary === "string" && estimate.summary.length <= 500;
  valid &&= estimate.known ? estimate.low !== null && estimate.typical !== null && estimate.high !== null && estimate.low <= estimate.typical && estimate.typical <= estimate.high : [estimate.low,estimate.typical,estimate.high].every((value) => value === null);
  valid &&= estimate.worthChecking === (estimate.known && estimate.typical >= 20);
  valid &&= estimate.estimatedAt === undefined || (ISO.test(estimate.estimatedAt) && Number.isFinite(Date.parse(estimate.estimatedAt)));
  return valid;
}

function fieldErrors(record, issues, row, { scout = false } = {}) {
  if (record.estimate !== undefined && record.estimate !== null && !validEstimate(record.estimate)) issue(issues,"A saved price estimate or listing evidence is invalid. Its original data has not been changed.",row);
  const extra = scout ? new Set(["photoId","sourceIndex","visual","confidence","purchasedTapeId","marker","markerIssue"]) : new Set();
  for (const key of Object.keys(record)) if (!tapeFields.has(key) && !extra.has(key)) issue(issues, `Unsupported field “${key}”.`, row);
  if (typeof record.title !== "string" || !record.title.trim()) issue(issues,"A title is required.",row);
  for (const [key,max] of Object.entries(limits)) if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].length > max)) issue(issues,`${key} must be text up to ${max} characters.`,row);
  for (const key of ["year","pricePaid","priceAsking","priceSold"]) if (record[key] !== undefined && record[key] !== null && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) issue(issues,`${key} must be a number or blank.`,row);
  for (const key of ["id","clientId"]) if (record[key] !== undefined && (typeof record[key] !== "string" || !ID.test(record[key]))) issue(issues,`${key} must be a stable ID using letters, numbers, underscores or hyphens.`,row);
  for (const [key,values] of [["status",["available","sold","hold","keep"]],["condition",["","sealed","mint","good","fair","poor"]],["packaging",["","slipcase","bigbox","clamshell","screener","other"]]]) if (record[key] !== undefined && !values.includes(record[key])) issue(issues,`Invalid ${key}: ${record[key]}.`,row);
  if (record.sealed !== undefined && typeof record.sealed !== "boolean") issue(issues,"Sealed must be true or false.",row);
  for (const [key,max,width] of [["actors",12,120],["tags",20,40]]) if (record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length > max || record[key].some((v) => typeof v !== "string" || v.length > width))) issue(issues,`${key} must be a list of up to ${max} text values.`,row);
  for (const key of ["createdAt","updatedAt"]) if (record[key] !== undefined && (!ISO.test(record[key]) || !Number.isFinite(Date.parse(record[key])))) issue(issues,`${key} must be a valid ISO date and time.`,row);
  if (record.posterUrl && !/^https:\/\//.test(record.posterUrl) && !/^\/api\/cover\/[a-f0-9]{32}$/.test(record.posterUrl)) issue(issues,"Cover URL must use HTTPS or an uploaded cover reference.",row);
}

export async function tableToBackup(rows, { csv = false, extraIssues = [] } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("This file is empty.");
  const issues = [...extraIssues];
  const headers = rows[0].map((header) => aliases.get(normalizeHeader(header)) || null);
  if (!headers.includes("title")) throw new Error("A Title column is required. Use a collection export as a template.");
  const known = headers.filter(Boolean);
  if (new Set(known).size !== known.length) throw new Error("Two columns map to the same field. Rename or remove the duplicate column.");
  const ignored = rows[0].filter((header,index) => header && !headers[index]);
  if (ignored.length) issue(issues,`Unrecognized columns: ${ignored.join(", ")}. Rename these columns to preserve their values.`);
  const body = rows.slice(1).filter((row) => row.some((cell) => cell !== "" && cell !== null && cell !== undefined));
  if (body.length > MAX_TABLE_ROWS) throw new Error(`Import up to ${MAX_TABLE_ROWS.toLocaleString()} rows at a time.`);
  const sources = new Set(), occurrences = new Map(), seenIds = new Set(), seenClients = new Set();
  const tapes = [];
  for (const [index,cells] of body.entries()) {
    const row = index + 2, raw = Object.fromEntries(headers.flatMap((key,i) => key ? [[key,cells[i] ?? ""]] : []));
    const ownCsv = csv && raw._tableFormat === TABLE_FORMAT;
    const source = String(raw._sourceAccountId || "tabular-import"); sources.add(source);
    const record = {};
    for (const [key,value] of Object.entries(raw)) {
      if (key.startsWith("_")) continue;
      let v = ownCsv && typeof value === "string" && value.startsWith("'") ? value.slice(1) : value;
      if (v === "" || v === null || v === undefined) continue;
      if (["pricePaid","priceAsking","priceSold","year"].includes(key)) {
        const text = String(v).trim().replace(/^\$/, "").replace(/,/g, "");
        const number = typeof v === "number" ? v : /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
        if (!Number.isFinite(number)) issue(issues,`${key} has an invalid number: ${v}`,row);
        else record[key] = number;
      } else if (key === "sealed") {
        if ([true,"true","yes","1",1].includes(typeof v === "string" ? v.toLowerCase() : v)) record[key] = true;
        else if ([false,"false","no","0",0].includes(typeof v === "string" ? v.toLowerCase() : v)) record[key] = false;
        else issue(issues,"Sealed must be yes/no or true/false.",row);
      } else if (key === "estimate") {
        try { record[key] = typeof v === "object" ? v : JSON.parse(v); }
        catch { issue(issues,"Saved Price Evidence must contain valid JSON, or be blank.",row); }
      } else if (["actors","tags"].includes(key)) {
        try { record[key] = Array.isArray(v) ? v : String(v).trim().startsWith("[") ? JSON.parse(v) : String(v).split(";").map((item) => item.trim()).filter(Boolean); }
        catch { issue(issues,`${key} contains an invalid JSON list.`,row); }
      } else if (["createdAt","updatedAt"].includes(key)) {
        const date = v instanceof Date ? v : new Date(v);
        if (!Number.isFinite(date.getTime())) issue(issues,`${key} contains an invalid date.`,row);
        else record[key] = date.toISOString();
      } else if (["soldDate","acquiredDate"].includes(key) && v instanceof Date) record[key] = v.toISOString().slice(0,10);
      else record[key] = String(v);
    }
    if (record.status) {
      const status = record.status.trim().toLowerCase();
      record.status = ({"for sale":"available", "available":"available", "sold":"sold", "on hold":"hold", "hold":"hold", "keeper":"keep", "keep":"keep"})[status] || status;
    }
    record.format ||= "VHS";
    record.status ||= "keep";
    if (!record.id) {
      const identity = canonical(record); const occurrence = occurrences.get(identity) || 0; occurrences.set(identity, occurrence+1);
      record.id = "import_" + await sha256(`${identity}\0${occurrence}`);
    }
    if (seenIds.has(record.id)) issue(issues,"Two rows have the same Record ID. Distinct physical copies need distinct IDs.",row);
    if (record.clientId && seenClients.has(record.clientId)) issue(issues,"Two rows have the same Client ID. Distinct physical copies need distinct IDs.",row);
    seenIds.add(record.id); if (record.clientId) seenClients.add(record.clientId);
    fieldErrors(record,issues,row);
    tapes.push(record);
  }
  if (sources.size > 1) issue(issues,"This table combines multiple source accounts. Import each source account separately.");
  const accountId = [...sources][0] || "tabular-import";
  if (!ID.test(accountId)) issue(issues,"Source Account ID is invalid.");
  if (tapes.some((tape) => tape.posterUrl?.startsWith("/api/cover/"))) issue(issues,"This table contains uploaded cover references but not image files. For another account or deleted covers, restore the full JSON backup first.",null,"warning");
  return { backup: { format:BACKUP_FORMAT,version:BACKUP_VERSION,source:{accountId},exportedAt:new Date().toISOString(),tapes,scouts:[],covers:[] }, issues, type: csv ? "CSV / text table" : "Excel workbook" };
}

export async function validateBackup(input) {
  if (!input || input.format !== BACKUP_FORMAT || input.version !== BACKUP_VERSION) throw new Error("This JSON is not a supported VHS Vault account backup (version 1).");
  const issues = [];
  if (typeof input.source?.accountId !== "string" || !ID.test(input.source.accountId)) issue(issues,"Backup source account is missing or invalid.");
  if (!ISO.test(input.exportedAt || "") || !Number.isFinite(Date.parse(input.exportedAt))) issue(issues,"Backup export date is invalid.");
  for (const kind of ["tapes","scouts","covers"]) if (!Array.isArray(input[kind])) issue(issues,`Backup ${kind} must be a list.`);
  if (issues.length) return { backup:input,issues,type:"Full JSON backup" };
  const duplicate = (records,label) => {
    const ids = new Set();
    for (const record of records) { if (!record || typeof record !== "object" || Array.isArray(record)) { issue(issues,`Invalid ${label} record.`); continue; } if (ids.has(record.id)) issue(issues,`Duplicate ${label} ID ${record.id}.`); ids.add(record.id); }
  };
  duplicate(input.tapes,"collection"); duplicate(input.scouts,"scout list"); duplicate(input.covers,"cover");
  const coverIds = new Set(input.covers.map((cover) => cover?.id));
  const tapeClientIds = new Set();
  for (const record of input.tapes) {
    if (record?.clientId) { if (tapeClientIds.has(record.clientId)) issue(issues,"Collection records have duplicate Client IDs."); tapeClientIds.add(record.clientId); }
    if (typeof record?.id === "string" && record.id.startsWith("c_") && record.id !== `c_${await sha256(record.clientId || "")}`) issue(issues,"A collection record ID does not match its Client ID.");
  }
  const checkRecord = (record,label) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    fieldErrors(record,issues,label,{scout:typeof label === "string"});
    const coverId = record.posterUrl?.match(/^\/api\/cover\/([a-f0-9]{32})$/)?.[1];
    if (coverId && !coverIds.has(coverId)) issue(issues,"An uploaded cover is referenced but missing from this backup.",label);
  };
  input.tapes.forEach((record,index) => { checkRecord(record,index+1); if (!ID.test(record?.id || "")) issue(issues,"Collection record ID is missing or invalid.",index+1); });
  for (const list of input.scouts) {
    if (!list || typeof list !== "object") continue;
    const listFields = new Set(["id","clientId","name","items","photos","createdAt","updatedAt","revision"]);
    for (const key of Object.keys(list)) if (!listFields.has(key)) issue(issues,`Unsupported scout list field “${key}”.`);
    if (typeof list.clientId === "string" && list.id !== `s_${await sha256(list.clientId)}`) issue(issues,"A scout list ID does not match its Client ID.");
    for (const key of ["createdAt","updatedAt"]) if (list[key] !== undefined && (!ISO.test(list[key]) || !Number.isFinite(Date.parse(list[key])))) issue(issues,`Scout list ${key} is not a valid date.`);
    if (typeof list.id !== "string" || typeof list.clientId !== "string" || !ID.test(list.id) || !ID.test(list.clientId) || typeof list.name !== "string" || !list.name.trim() || list.name.length > 120) issue(issues,"A scout list has invalid IDs or name.");
    if (!Array.isArray(list.items) || list.items.length < 1 || list.items.length > 1000) { issue(issues,"Each scout list needs 1–1,000 items."); continue; }
    if (!Array.isArray(list.photos) || list.photos.length > 100 || list.photos.some((photo) => !photo || typeof photo.id !== "string" || !photo.id.trim() || photo.id.length > 128 || typeof photo.name !== "string" || photo.name.length > 160 || Object.keys(photo).some((key) => !["id","name"].includes(key)))) issue(issues,"Scout source-photo references are invalid.");
    const clients = new Set();
    for (const item of list.items) {
      const label = `Scout: ${list.name}`; checkRecord(item,label);
      if (!ID.test(item?.clientId || "") || clients.has(item.clientId)) issue(issues,"Scout items need distinct stable Client IDs.",label); clients.add(item?.clientId);
      if (!item || typeof item !== "object") continue;
      for (const [key,max] of [["artist",200],["photoId",128],["visual",200]]) if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > max)) issue(issues,`Scout ${key} must be text up to ${max} characters.`,label);
      if (item.confidence !== undefined && !["high","medium","low","manual"].includes(item.confidence)) issue(issues,"Invalid scout confidence.",label);
      if (item.sourceIndex !== undefined && item.sourceIndex !== null && (!Number.isInteger(item.sourceIndex) || item.sourceIndex < 0 || item.sourceIndex > 1000)) issue(issues,"Invalid source-photo position.",label);
      if (item.purchasedTapeId !== undefined && item.purchasedTapeId !== null && (typeof item.purchasedTapeId !== "string" || !ID.test(item.purchasedTapeId))) issue(issues,"Invalid purchased record ID.",label);
      if (item.marker !== undefined && item.marker !== null && (!item.marker || typeof item.marker !== "object" || Object.keys(item.marker).some((key) => !["x","y"].includes(key)) || ![item.marker.x,item.marker.y].every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1))) issue(issues,"Invalid tape marker coordinates.",label);
      if (item.markerIssue !== undefined && ![null,"unplaced","overlap"].includes(item.markerIssue)) issue(issues,"Invalid tape marker status.",label);
    }
  }
  for (const cover of input.covers) {
    if (!cover || !/^[a-f0-9]{32}$/.test(cover.id) || !["image/jpeg","image/png","image/webp"].includes(cover.contentType) || typeof cover.data !== "string" || cover.data.length > 3495256 || !/^[a-f0-9]{64}$/.test(cover.sha256)) { issue(issues,"An uploaded cover has invalid or oversized image data."); continue; }
    try {
      const bytes = Uint8Array.from(atob(cover.data),(c) => c.charCodeAt(0));
      if (await sha256(bytes) !== cover.sha256) issue(issues,`Cover ${cover.id} failed its integrity check.`);
      const magic = cover.contentType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : cover.contentType === "image/png" ? [137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte) : new TextDecoder().decode(bytes.subarray(0,4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8,12)) === "WEBP";
      if (!magic) issue(issues,`Cover ${cover.id} does not match its image format.`);
    }
    catch { issue(issues,`Cover ${cover.id} is not valid base64 image data.`); }
  }
  // Whitelist the envelope, never forward arbitrary account/profile properties.
  const backup = { format:BACKUP_FORMAT,version:BACKUP_VERSION,source:{accountId:input.source.accountId},exportedAt:input.exportedAt,tapes:input.tapes,scouts:input.scouts,covers:input.covers };
  return { backup,issues,type:"Full JSON backup" };
}

export function backupSummary(backup) {
  const tapes = Array.isArray(backup.tapes) ? backup.tapes : [], scouts = Array.isArray(backup.scouts) ? backup.scouts.filter((list) => list && typeof list === "object") : [], covers = Array.isArray(backup.covers) ? backup.covers : [];
  return { tapes:tapes.length, scouts:scouts.length, items:scouts.reduce((sum,list) => sum+(Array.isArray(list.items) ? list.items.length : 0),0), covers:covers.length, estimates:scouts.reduce((sum,list) => sum+(Array.isArray(list.items) ? list.items.filter((item) => item?.estimate).length : 0),0) };
}
