import { test, expect } from "@playwright/test";

const photo = { name: "three-tapes.svg", mimeType: "image/svg+xml", buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#41483c"/>${["JAWS","JURASSIC PARK","UNREADABLE"].map((title,i)=>`<rect x="${170+i*300}" y="90" width="210" height="520" fill="${["#f4d55f","#ef9d87","#dde3cc"][i]}"/><text x="${190+i*300}" y="370" font-size="28" font-family="sans-serif">${title}</text>`).join("")}</svg>`) };
async function setup(page) {
  const errors = [], saved = [], valueCalls = [];
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem("vhsvault.token","visual-test");localStorage.setItem("vhsvault.installDismissedAt",String(Date.now()));});
  await page.route("**/api/**",async(route)=>{
    const path = new URL(route.request().url()).pathname, data = route.request().postDataJSON();
    let response = {};
    if (path === "/api/auth/me") response = {user:{id:"visual-user",email:"visual@example.com"}};
    if (path === "/api/tapes") {
      if (route.request().method()==="GET") response={tapes:saved};
      else { saved.push(...data.tapes.map(item=>({...item,id:item.clientId}))); response={tapes:saved,failedCount:0}; }
    }
    if (path === "/api/scan") response = {
      tapes:["Jaws","Jurassic Park","Unknown"].map((title,i)=>({title,format:"VHS",year:i===0?1975:i===1?1993:null,sourceIndex:i+1,marker:{x:(275+i*300)/1200,y:.5},confidence:i===2?"low":"high",needsReview:i===2,visual:i===2?"Label obscured":""})),
      verification:{status:"matched",countedCount:3,listedCount:3,uncertainCount:0,positions:[0,1,2].map(i=>({sourceIndex:i+1,label:`Spine ${i+1}`,marker:{x:(275+i*300)/1200,y:.5}}))},
      coverage:{markedCount:3,unplacedCount:0},needsVerification:false,warnings:[],
    };
    if (path === "/api/value") {
      valueCalls.push(data.title);
      response={known:true,low:5,high:9,typical:7,source:"live_web_search",currency:"USD",liveComps:false,estimatedAt:"2026-10-14T15:00:00.000Z",market:{status:"available",basis:"asking",sampleCount:2,askingCount:2,soldCount:0,fetchedAt:"2026-10-14T15:00:00.000Z",listings:[{id:"one",title:`${data.title} VHS used`,url:"https://www.ebay.com/itm/123456789012",price:5,currency:"USD",kind:"asking",condition:"used",evidence:"VHS tape US $5.00"}],warnings:[]}};
    }
    await route.fulfill({json:response});
  });
  await page.goto("/"); await page.locator("[data-start-scan]").click();
  return {errors,saved,valueCalls};
}

test("photo dots link to titles, rotate with the image, and leave the save choice until reading finishes", async({page})=>{
  await page.setViewportSize({width:1440,height:1060});
  const app=await setup(page);
  await expect(page.locator("[data-finish]")).not.toBeVisible();
  await page.locator("[data-file-library]").setInputFiles(photo);
  await expect(page.locator("[data-finish]")).not.toBeVisible();
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-map-pins] .tape-pin")).toHaveCount(3);
  await expect(page.locator("[data-finish]")).toBeVisible();
  await expect(page.locator("[data-save]")).toBeDisabled();
  const pin=page.locator("[data-map-pins] .tape-pin").nth(1);
  await pin.click();
  await expect(page.locator(".scan-tape-row.selected [data-title]")).toHaveValue("Jurassic Park");
  await page.locator("[data-expand]").click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Rotate photo right 90 degrees"}).click();
  const rotated=dialog.locator(".tape-pin").first();
  expect(await rotated.evaluate(el=>parseFloat(el.style.left))).toBeCloseTo(50);
  expect(await rotated.evaluate(el=>parseFloat(el.style.top))).toBeCloseTo(275/1200*100);
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
  await page.locator(".scan-tape-row").last().locator("[data-include]").uncheck();
  await page.locator("[data-photo-confirm]").check();
  await expect(page.locator("[data-save]")).toBeEnabled();
  await page.locator("[data-compare-count]").click();
  await expect(page.locator("[data-map-hint]")).toContainText("not title matches");
  await expect(page.locator("[data-map-pins] .counter")).toHaveCount(3);
  await page.locator("[data-compare-count]").click();
  await page.screenshot({path:"test-results/scan-dots-desktop.png",fullPage:true});
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-save-summary]")).toContainText("2 titles added");
  expect(app.saved.map(item=>item.title)).toEqual(["Jaws","Jurassic Park"]);
  expect(app.errors).toEqual([]);
});

test("a missed tape can be marked, named and priced with linked asking evidence on a phone",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const app=await setup(page);
  await page.locator("[data-file-library]").setInputFiles(photo); await page.locator("[data-run]").click();
  await expect(page.locator("[data-map-pins] .tape-pin")).toHaveCount(3);
  await page.locator("[data-add-dot]").click();
  const image=page.locator(".photo-map-content"); const box=await image.boundingBox();
  await image.click({position:{x:box.width*.9,y:box.height*.8}});
  await page.locator("[data-manual-title]").fill("Alien");
  await page.getByRole("button",{name:"Add title",exact:true}).click();
  await expect(page.locator("[data-map-pins] .tape-pin")).toHaveCount(4);
  await expect(page.locator(".scan-tape-row.selected [data-title]")).toHaveValue("Alien");
  await page.locator("[data-prices]").click();
  await expect(page.locator("[data-price-message]")).toContainText("3 checked");
  expect(app.valueCalls.sort()).toEqual(["Alien","Jaws","Jurassic Park"]);
  await expect(page.locator(".scan-tape-row.selected [data-price-caption]")).toHaveText("2 asking prices");
  await page.locator(".scan-tape-row.selected .market-evidence summary").click();
  await expect(page.locator(".scan-tape-row.selected .market-listings a")).toHaveAttribute("href","https://www.ebay.com/itm/123456789012");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:"test-results/scan-dots-mobile.png",fullPage:true});
  await page.reload(); await page.locator("[data-start-scan]").click();
  await expect(page.locator("[data-map-pins] .tape-pin")).toHaveCount(4);
  expect(app.errors).toEqual([]);
});

test("changing photos cancels dot placement and manual titles use the selected photo", async({page})=>{
  await setup(page);
  await page.locator("[data-file-library]").setInputFiles([photo,{...photo,name:"second-shelf.svg"}]);
  await page.locator("[data-run]").click();
  await expect(page.locator(".scan-tape-row")).toHaveCount(6);
  await page.locator(".scan-tape-row").first().locator("[data-source]").click();
  await page.locator(".scan-tape-row").first().locator("[data-place-item]").click();
  await expect(page.locator("[data-placement-note]")).toBeVisible();
  await page.locator(".scan-tape-row").nth(3).locator("[data-source]").click();
  await expect(page.locator("[data-photo-heading]")).toHaveText("Photo 2");
  await expect(page.locator("[data-placement-note]")).not.toBeVisible();
  await page.locator("[data-manual-toggle]").click();
  await expect(page.locator("[data-manual-photo] option:checked")).toHaveText("Photo 2");
  await page.locator("[data-manual-title]").fill("Second shelf title");
  await page.getByRole("button",{name:"Add title",exact:true}).click();
  await expect(page.locator(".scan-tape-row.selected [data-item-caption]")).toContainText("Photo 2");
  await page.locator("[data-preview]").first().click();
  const point=await page.locator("[data-map-pins] .tape-pin").first().evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
  expect(point.x).toBeCloseTo(275/1200*100); expect(point.y).toBe(50);
});

test("placing a dot in a rotated zoomed preview stores original photo coordinates", async({page})=>{
  await setup(page);
  await page.locator("[data-file-library]").setInputFiles(photo);
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-map-pins] .tape-pin")).toHaveCount(3);
  await page.locator("[data-add-dot]").click(); await page.locator("[data-expand]").click();
  const dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Rotate photo right 90 degrees"}).click();
  await dialog.getByRole("button",{name:"Zoom in photo",exact:true}).click();
  const layer=dialog.locator("[data-preview-pins]");
  const bounds=await layer.boundingBox();
  await layer.click({position:{x:bounds.width*.7,y:bounds.height*.4}});
  await page.locator("[data-manual-title]").fill("Rotated find");
  await page.getByRole("button",{name:"Add title",exact:true}).click();
  const point=await page.locator("[data-map-pins] .tape-pin").last().evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
  expect(point.x).toBeCloseTo(40,0); expect(point.y).toBeCloseTo(30,0);
});
