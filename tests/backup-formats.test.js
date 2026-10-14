import test from "node:test";
import assert from "node:assert/strict";
import { collectionTable, encodeCsv, parseDelimited, tableToBackup, validateBackup, sha256, BACKUP_FORMAT, backupSummary } from "../public/js/backup-formats.js";
import { collectAccountBackup, createRestorePlan, runRestorePlan } from "../public/js/backup-io.js";
const date = "2026-10-14T12:00:00.000Z";
const tape = {id:"legacy-1",title:"A, \"quoted\" title\nSecond line",format:"VHS",year:1987,director:"Director",actors:["Doe, Jane","A; B"],genre:"Comedy",runtime:"96 min",rated:"PG",plot:"Full plot",imdbRating:"7.5",imdbId:"tt123",posterUrl:"https://example.com/cover.jpg",edition:"First",label:"Label",packaging:"slipcase",sealed:false,condition:"good",status:"sold",pricePaid:0,priceAsking:10.5,priceSold:8,soldDate:"2026-10-13",location:"A1",acquiredFrom:"Store",acquiredDate:"2026-10-12",barcode:"001234",notes:"Line 1\nLine 2",tags:["one","semi; colon"],source:"scan",createdAt:date,updatedAt:date};
const backup = (tapes = [tape]) => ({format:BACKUP_FORMAT,version:1,source:{accountId:"owner"},exportedAt:date,tapes,scouts:[],covers:[]});

test("CSV roundtrip retains every field, original account, arrays, zero, false, dates, quotes and newlines",async () => {
  const csv = encodeCsv(collectionTable([tape],{accountId:"owner"}));
  const result = await tableToBackup(parseDelimited(csv),{csv:true});
  assert.deepEqual(result.issues,[]); assert.deepEqual(result.backup.tapes,[tape]); assert.equal(result.backup.source.accountId,"owner");
});
test("formula-like and literal apostrophe strings are inert in CSV and roundtrip exactly",async () => {
  for (const title of ["=HYPERLINK(\"evil\")","+SUM(A1)","-formula","@SUM(A1)","'literal","  =SUM(A1)","\tDanger"]) {
    const csv = encodeCsv(collectionTable([{...tape,title}],{accountId:"owner"}));
    assert.ok(parseDelimited(csv)[1][0].startsWith("'"));
    const result = await tableToBackup(parseDelimited(csv),{csv:true}); assert.equal(result.backup.tapes[0].title,title);
  }
});
test("stable generated IDs survive reorder and repeated import while preserving identical physical copies",async () => {
  const first = await tableToBackup([["Title"],["A"],["B"],["A"]],{csv:true});
  const reordered = await tableToBackup([["Title"],["A"],["A"],["B"]],{csv:true});
  assert.deepEqual(first.backup.tapes.map((row) => row.id).sort(),reordered.backup.tapes.map((row) => row.id).sort());
  assert.equal(new Set(first.backup.tapes.map((row) => row.id)).size,3);
  assert.equal(first.backup.tapes[0].status,"keep");
});
test("legacy headers and tab/semicolon separators preserve sold status and sale fields",async () => {
  const result = await tableToBackup(parseDelimited('Title\tStatus\tSold Price\tSold Date\tAdded\nExample\tSold\t$1,234.50\t2020-02-03\t2020-01-01'),{csv:true});
  assert.equal(result.backup.tapes[0].priceSold,1234.5); assert.equal(result.backup.tapes[0].status,"sold"); assert.equal(result.backup.tapes[0].createdAt,"2020-01-01T00:00:00.000Z");
  assert.deepEqual(parseDelimited('Title;Year\n"A; B";1987'),[["Title","Year"],["A; B","1987"]]);
});
test("preview rejects bad numbers, unknown columns, conflicting IDs and mixed sources before any write",async () => {
  const result = await tableToBackup([["Title","Price Paid","Record ID","Source Account ID","Unknown"],["A","nope","same","a","data"],["B","1","same","b",""]],{csv:true});
  assert.equal(result.issues.filter((issue) => issue.severity === "error").length,4);
  assert.throws(() => parseDelimited('Title\n"unfinished'),/unfinished/);
  await assert.rejects(() => tableToBackup([["not a title"]]),/Title column/);
});
test("full backup preserves estimates and checks missing/corrupt uploaded images",async () => {
  const data = backup();
  data.tapes[0] = {...tape,posterUrl:"/api/cover/"+"a".repeat(32)};
  const result = await validateBackup(data); assert.match(result.issues[0].message,/missing/);
  data.covers.push({id:"a".repeat(32),contentType:"image/png",data:btoa("test"),sha256:"0".repeat(64)});
  const corrupt = await validateBackup(data); assert.match(corrupt.issues[0].message,/integrity/);
  await assert.rejects(() => validateBackup({...data,version:9}),/not a supported/);
  assert.deepEqual(backupSummary({tapes:{},scouts:{},covers:{}}),{tapes:0,scouts:0,items:0,covers:0,estimates:0});
});
test("restore chunks hundreds of tapes <=100 and acknowledges only actual results",async () => {
  const data = backup(Array.from({length:250},(_,i) => ({...tape,id:`id-${i}`})));
  const plan = await createRestorePlan(data), batches = [];
  await runRestorePlan(plan,{restoreBackup:async (payload) => { batches.push(payload.records.length); return {results:payload.records.map((record) => ({sourceId:record.id,status:"created"}))}; }});
  assert.deepEqual(batches,[100,100,50]); assert.equal(plan.created,250); assert.equal(plan.completed,true);
});
test("partial result retries only failed stable IDs and stops before dependent scout records",async () => {
  const data = backup([{...tape,id:"a"},{...tape,id:"b"}]), plan = await createRestorePlan(data); let call = 0;
  const requests = [];
  const client = {restoreBackup:async (payload) => { requests.push(payload.records.map((record) => record.id)); call++; return {results:payload.records.map((record) => ({sourceId:record.id,status:call === 1 && record.id === "b" ? "failed" : "created",error:"temporary"}))}; }};
  await assert.rejects(() => runRestorePlan(plan,client),/could not be restored/); assert.equal(plan.created,1);
  await runRestorePlan(plan,client); assert.deepEqual(requests,[["a","b"],["b"]]); assert.equal(plan.created,2);
});
test("lost response retries original IDs, account options are passed through, and abort blocks more writes",async () => {
  const plan = await createRestorePlan(backup()), opts = {expectedToken:"account-one"}; let calls = 0;
  const client = {restoreBackup:async (payload,options) => { assert.equal(options,opts); calls++; if (calls === 1) throw new Error("lost response"); return {results:[{sourceId:"legacy-1",status:"existing"}]}; }};
  await assert.rejects(() => runRestorePlan(plan,client,opts),/lost response/); await runRestorePlan(plan,client,opts); assert.equal(plan.existing,1);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => runRestorePlan(awaitablePlan(),client,{signal:controller.signal}),{name:"AbortError"});
  function awaitablePlan() { return {tasks:[{done:false,payload:{records:[tape]}}],failures:[]}; }
});
test("scout staging uses one snapshot and is counted only when the final part publishes",async () => {
  const data = backup([]), list = {id:"list",clientId:"list-client",name:"Large visit",photos:[],items:Array.from({length:205},(_,i) => ({title:`Item${i}`,clientId:`item${i}`}))}; data.scouts = [list];
  const plan = await createRestorePlan(data); assert.equal(plan.tasks.length,3);
  assert.deepEqual(plan.tasks.map((task) => task.payload.records[0].items.length),[100,100,5]);
  assert.equal(plan.tasks[0].payload.scoutPart.snapshotId,await sha256(JSON.stringify(list)));
  await runRestorePlan(plan,{restoreBackup:async (payload) => ({results:[{sourceId:"list",status:payload.scoutPart.index === 2 ? "created" : "staged"}]})}); assert.equal(plan.created,1);
});
test("complete export follows paginated scouts and refuses an inconsistent snapshot",async () => {
  const manifest = {source:{accountId:"owner"},exportedAt:date,tapeIds:[tape.id],scoutIds:["list"],coverIds:[],fingerprint:"snapshot"}; let manifestReads = 0;
  const client = {backupManifest:async () => ({...manifest,fingerprint:++manifestReads > 2 ? "changed" : "snapshot"}),backupTapes:async () => ({records:[tape],nextCursor:null}),backupScout:async (_id,cursor) => ({record:{id:"list",name:"List",items:[{title:String(cursor)}]},nextCursor:cursor === 0 ? 1 : null})};
  const data = await collectAccountBackup(client); assert.equal(data.scouts[0].items.length,2);
  manifestReads = 1; await assert.rejects(() => collectAccountBackup(client),/changed while backing up/);
});
test("a staged final scout part is not reported complete and a retry restages that list",async () => {
  const data = backup([]); data.scouts = [{id:"list",clientId:"list-client",name:"List",items:Array.from({length:101},(_,index) => ({title:`Item ${index}`,clientId:`item${index}`}))}];
  const plan = await createRestorePlan(data);
  await assert.rejects(() => runRestorePlan(plan,{restoreBackup:async () => ({results:[{sourceId:"list",status:"staged"}]})}),/could not be restored/);
  assert.equal(plan.completed,false); assert.ok(plan.tasks.every((task) => !task.done));
  await runRestorePlan(plan,{restoreBackup:async (payload) => ({results:[{sourceId:"list",status:payload.scoutPart.index === 1 ? "created" : "staged"}]})}); assert.equal(plan.created,1);
});
test("invalid JSON metadata and false live-sales estimates are rejected in preview",async () => {
  const data = backup(); data.tapes[0] = {...tape,status:"nonsense"};
  const clientId = "scout";
  data.scouts = [{id:"s_"+await sha256(clientId),clientId,name:"List",photos:[],items:[{title:"Title",clientId:"item",estimate:{known:true,source:"live_sales",liveComps:true}}]}];
  const result = await validateBackup(data);
  assert.ok(result.issues.some((issue) => /Invalid status/.test(issue.message))); assert.ok(result.issues.some((issue) => /price estimate/.test(issue.message)));
});
