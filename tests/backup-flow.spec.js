import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const date = "2026-10-14T12:00:00.000Z";
const tape = {id:"legacy-one",title:"The Arrival",year:1996,format:"VHS",status:"sold",pricePaid:0,priceSold:12.5,soldDate:"2026-10-01",sealed:false,actors:["A; B","C, D"],tags:["first run"],notes:"Retain this\nand this",posterUrl:"https://example.com/cover.jpg",createdAt:date,updatedAt:date};
const cover = {id:"a".repeat(32),contentType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="};
cover.sha256 = createHash("sha256").update(Buffer.from(cover.data,"base64")).digest("hex");
const list = {id:"s_"+createHash("sha256").update("list-client").digest("hex"),clientId:"list-client",name:"Shop visit",items:[{clientId:"find-one",title:"Possible find",format:"VHS",confidence:"high",estimate:{known:true,low:5,typical:10,high:15,demand:"steady",factors:[],summary:"Test estimate",source:"ai_estimate",currency:"USD",liveComps:false,worthChecking:false,estimatedAt:date}}],photos:[{id:"photo",name:"Shelf"}],createdAt:date,updatedAt:date};

async function setup(page,{restore = null} = {}) {
  await page.addInitScript(() => { localStorage.setItem("vhsvault.token","backup-test"); localStorage.setItem("vhsvault.installDismissedAt",String(Date.now())); });
  const requests = [];
  await page.route("**/api/**",async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname; let body = {};
    if (path === "/api/auth/me") body = {user:{id:"backup-owner",email:"backup@example.com"}};
    if (path === "/api/tapes") body = {tapes:[tape]};
    if (path === "/api/backup") body = {format:"tape-deck-account-backup",version:1,source:{accountId:"backup-owner"},exportedAt:date,tapeIds:[tape.id],scoutIds:[list.id],coverIds:[cover.id],fingerprint:"unchanged"};
    if (path === "/api/backup/tapes") body = {records:[{...tape,posterUrl:"/api/cover/"+cover.id}],nextCursor:null};
    if (path === `/api/backup/scouts/${list.id}`) body = {record:list,nextCursor:null};
    if (path === `/api/backup/covers/${cover.id}`) body = cover;
    if (path === "/api/backup/restore") {
      const payload = request.postDataJSON(); requests.push(payload);
      body = restore ? await restore(payload,requests.length) : {results:payload.records.map((record) => ({sourceId:record.id,status:"created"}))};
    }
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.goto("/");
  await expect(page.locator(".library-screen")).toBeVisible();
  await page.evaluate(async () => { const {go} = await import("/js/app.js"); go("backup"); });
  await expect(page.getByRole("heading",{name:/Take your collection/})).toBeVisible();
  return requests;
}

test("full JSON download includes saved account data, images and estimates, then previews and restores in dependency order",async ({page}) => {
  const requests = await setup(page);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button",{name:"Download full backup"}).click();
  const download = await downloadPromise; const bytes = await readFile(await download.path()); const backup = JSON.parse(bytes.toString());
  expect(download.suggestedFilename()).toMatch(/\.json$/); expect(backup.tapes[0].pricePaid).toBe(0); expect(backup.tapes[0].status).toBe("sold"); expect(backup.scouts[0].items[0].estimate.typical).toBe(10); expect(backup.covers).toEqual([cover]); expect(Object.keys(backup.source)).toEqual(["accountId"]);
  await page.locator("[data-import-file]").setInputFiles({name:"complete.json",mimeType:"application/json",buffer:bytes});
  await expect(page.getByRole("button",{name:"Import 3 records"})).toBeEnabled(); expect(requests).toHaveLength(0);
  await page.getByRole("button",{name:"Import 3 records"}).click();
  await expect(page.locator("[data-status]")).toContainText("Import complete. 3 records added");
  expect(requests.map((payload) => payload.kind)).toEqual(["covers","tapes","scouts"]);
  expect(requests[1].records[0].notes).toBe(tape.notes);
  expect(requests[2].scoutPart).toEqual({index:0,count:1,totalItems:1,snapshotId:expect.stringMatching(/^[a-f0-9]{64}$/)});
});

test("real Excel workbook downloads and reimports all fields through the local worker",async ({page}) => {
  const errors = [], external = []; page.on("pageerror",(error) => errors.push(error.message)); page.on("request",(request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1")) external.push(request.url()); });
  const requests = await setup(page);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button",{name:"Download Excel"}).click();
  const download = await downloadPromise, bytes = await readFile(await download.path());
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/); expect(bytes.subarray(0,2).toString()).toBe("PK");
  await page.locator("[data-import-file]").setInputFiles({name:"renamed.dat",mimeType:"application/octet-stream",buffer:bytes});
  await expect(page.getByRole("button",{name:"Import 1 record"})).toBeEnabled(); await expect(page.locator("[data-preview]")).toContainText("Excel workbook");
  await page.getByRole("button",{name:"Import 1 record"}).click(); await expect(page.locator("[data-status]")).toContainText("Import complete");
  expect(requests[0].source.accountId).toBe("backup-owner"); expect(requests[0].records[0]).toEqual(tape); expect(errors).toEqual([]);
  expect(external.filter((url) => /sheetjs|xlsx|cdn/.test(url))).toEqual([]);
});

test("mobile CSV preview blocks invalid fields, then a partial import retries only missing stable IDs",async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const requests = await setup(page,{restore:async (payload,attempt) => ({results:payload.records.map((record,index) => ({sourceId:record.id,status:attempt === 1 && index === 1 ? "failed" : "created",error:"Connection interrupted"}))})});
  await page.locator("[data-import-file]").setInputFiles({name:"bad.csv",mimeType:"text/csv",buffer:Buffer.from("Title,Price Paid\nExample,not-a-number")});
  await expect(page.locator("[data-confirm-import]")).toBeDisabled(); await expect(page.locator("[data-preview]")).toContainText("invalid number"); expect(requests).toHaveLength(0);
  await page.locator("[data-import-file]").setInputFiles({name:"good.csv",mimeType:"text/csv",buffer:Buffer.from("Title,Status,Price Paid,Sold Price\nExample,Sold,0,12.5\nAnother,Keeper,3,")});
  await expect(page.locator("[data-confirm-import]")).toBeEnabled(); await page.screenshot({path:"test-results/backup-import-mobile.png",fullPage:true});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); expect(overflow).toBe(false);
  await page.locator("[data-confirm-import]").click(); await expect(page.locator("[data-retry]")).toBeVisible();
  await page.locator("[data-retry]").click(); await expect(page.locator("[data-status]")).toContainText("Import complete. 2 records added");
  expect(requests).toHaveLength(2); expect(requests[0].records).toHaveLength(2); expect(requests[1].records).toHaveLength(1); expect(requests[1].records[0].id).toBe(requests[0].records[1].id);
});

test("navigating away aborts a large import before another batch is sent",async ({page}) => {
  let release; const hold = new Promise((resolve) => {release = resolve;});
  const requests = await setup(page,{restore:async (payload) => { await hold; return {results:payload.records.map((record) => ({sourceId:record.id,status:"created"}))}; }});
  const csv = "Title\n"+Array.from({length:205},(_,index) => `Tape ${index}`).join("\n");
  await page.locator("[data-import-file]").setInputFiles({name:"large.csv",mimeType:"text/csv",buffer:Buffer.from(csv)}); await expect(page.locator("[data-confirm-import]")).toBeEnabled(); await page.locator("[data-confirm-import]").click(); await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("button",{name:"← Account"}).click(); release();
  await expect(page.locator(".backup-screen")).toHaveCount(0); await page.waitForTimeout(100); expect(requests).toHaveLength(1); expect(requests[0].records).toHaveLength(100);
});
