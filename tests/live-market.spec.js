import { test, expect } from "@playwright/test";
const date = "2026-10-14T12:00:00.000Z";
const legacy = {known:true,low:8,high:15,typical:10,source:"ai_estimate",factors:[],summary:"Older preliminary estimate",estimatedAt:date};
const live = {known:true,low:12,high:18,typical:15,source:"live_web_search",liveComps:false,currency:"USD",summary:"Two matching VHS asking listings.",factors:[],estimatedAt:date,market:{status:"available",basis:"asking",fetchedAt:date,sampleCount:2,askingCount:2,soldCount:0,listings:[{id:"one",title:"Jaws VHS slipcase",url:"https://example.com/listing-one",price:12,currency:"USD",kind:"asking",condition:"Used",edition:"Standard",shipping:null,soldAt:null,evidence:"Title, format and price shown in listing."},{id:"two",title:"Jaws VHS release",url:"https://example.com/listing-two",price:18,currency:"USD",kind:"asking",condition:"Used",edition:"Standard",shipping:null,soldAt:null,evidence:"Matching title and format."}],warnings:[]}};
async function setup(page,{unavailable=false}={}) {
  let tape = {id:"owned",clientId:"physical-copy",title:"Jaws",year:1975,format:"VHS",edition:"",artist:"",condition:"good",packaging:"slipcase",barcode:"",sealed:false,status:"keep",actors:[],estimate:legacy};
  const patches = [], checks = [];
  await page.addInitScript(() => {localStorage.setItem("vhsvault.token","live-market-test");localStorage.setItem("vhsvault.installDismissedAt",String(Date.now()));});
  await page.route("**/api/**",async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname; let body = {};
    if (path === "/api/auth/me") body = {user:{id:"owner",email:"owner@example.com"}};
    if (path === "/api/tapes") body = {tapes:[tape]};
    if (path === "/api/value") { checks.push(req.postDataJSON()); body = unavailable ? {...live,known:false,low:null,high:null,typical:null,summary:"The listing service is unavailable.",market:{...live.market,status:"unavailable",basis:"none",sampleCount:0,listings:[]}} : live; }
    if (path === "/api/tapes/owned" && req.method() === "PATCH") { const patch = req.postDataJSON(); patches.push(patch); const {estimateFor,...fields} = patch; tape = {...tape,...fields}; body = {tape}; }
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.goto("/"); await expect(page.locator(".library-screen")).toBeVisible();
  await page.evaluate(async () => { const {go} = await import("/js/app.js"); go("detail","owned"); });
  await expect(page.locator("[data-cached-market]")).toContainText("AI estimate");
  return {patches,checks,getTape:()=>tape};
}
test("collection live checks show dated asking sources, persist evidence and keep legacy estimates labeled",async ({page}) => {
  const fixture = await setup(page); await page.locator("[data-value]").click();
  const dialog = page.getByRole("dialog",{name:"Current market prices"}); await expect(dialog.locator(".value-result")).toBeVisible(); await expect(dialog.locator(".value-range")).toContainText("2 asking prices"); await expect(dialog.locator("[data-price-save]")).toContainText("saved with this tape");
  await dialog.locator(".market-evidence summary").click(); await expect(dialog.getByRole("link",{name:"Jaws VHS slipcase ↗"})).toHaveAttribute("href","https://example.com/listing-one"); await expect(dialog.locator(".market-evidence")).toContainText("not completed sales");
  expect(fixture.patches).toHaveLength(1); expect(fixture.patches[0].estimate).toEqual(live); expect(fixture.patches[0].estimateFor).toEqual({title:"Jaws",year:1975,format:"VHS",edition:"",artist:"",condition:"good",sealed:false,packaging:"slipcase",barcode:""});
  await dialog.getByRole("button",{name:"Close",exact:true}).click(); await expect(page.locator("[data-cached-market]")).toContainText("2 asking prices");
});
test("a live service outage leaves the previous collection price intact",async ({page}) => {
  const fixture = await setup(page,{unavailable:true}); await page.locator("[data-value]").click();
  const dialog = page.getByRole("dialog",{name:"Current market prices"}); await expect(dialog.locator(".value-big")).toHaveText("Check unavailable"); await expect(dialog.locator("[data-price-save]")).toContainText("previously saved price is kept");
  expect(fixture.patches).toHaveLength(0); expect(fixture.getTape().estimate).toEqual(legacy); await expect(page.locator("[data-cached-market]")).toContainText("AI estimate");
});
test("a price check for edited details waits for explicit Save and uses the same identity snapshot",async ({page}) => {
  const fixture = await setup(page); await page.locator("[name=edition]").fill("Anniversary edition"); await page.locator("[data-value]").click();
  const dialog = page.getByRole("dialog",{name:"Current market prices"}); await expect(dialog.locator("[data-price-save]")).toContainText("Save the edited tape details"); expect(fixture.patches).toHaveLength(0);
  await dialog.getByRole("button",{name:"Close",exact:true}).click(); await page.locator("[data-save]").click(); await expect.poll(() => fixture.patches.length).toBe(1);
  expect(fixture.patches[0].edition).toBe("Anniversary edition"); expect(fixture.patches[0].estimateFor.edition).toBe("Anniversary edition"); expect(fixture.patches[0].estimate).toEqual(live);
});
