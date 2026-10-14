import test from "node:test";
import assert from "node:assert/strict";
import { marketLabel, marketMeta, marketEvidence } from "../public/js/market-view.js";
const price = {known:true,low:10,high:20,typical:15,source:"live_web_search",market:{status:"available",basis:"asking",sampleCount:2,fetchedAt:"2026-10-14T12:00:00Z",listings:[]}};
test("live asking and sold evidence retain distinct labels, sample counts and check dates",() => {
  assert.equal(marketLabel(price),"$10–$20"); assert.match(marketMeta(price),/2 asking prices/); assert.match(marketMeta(price),/Checked/); assert.match(marketEvidence(price),/asking prices, not completed sales/);
  const sold = {...price,market:{...price.market,basis:"sold"}}; assert.match(marketMeta(sold),/2 sold listings/); assert.match(marketEvidence(sold),/Matched sold evidence/);
  assert.match(marketMeta({...price,source:"ai_estimate"}),/AI estimate/);
});
test("unknown and unavailable checks never acquire a fabricated price or a live-sales label",() => {
  assert.equal(marketLabel({...price,known:false,market:{status:"no_matches"}}),"No matching listings"); assert.equal(marketLabel({...price,known:false,market:{status:"unavailable"}}),"Check unavailable"); assert.equal(marketLabel(null),"Not checked");
  assert.match(marketMeta({known:false,source:"ai_estimate"}),/AI estimate/);
});
test("market evidence escapes provider markup and rejects non-HTTPS and credentialed links",() => {
  const value = {...price,summary:'<img src=x onerror="bad()">',market:{...price.market,listings:[{title:"<script>bad()</script>",url:"javascript:bad()",price:10,kind:"asking"},{title:"Safe",url:"https://example.com/listing?a=1&b=2",price:20,kind:"sold"},{title:"Credentials",url:"https://user:password@example.com",price:30,kind:"asking"}]}};
  const html = marketEvidence(value); assert.ok(!html.includes("<script>")); assert.ok(!html.includes("<img")); assert.ok(!html.includes("javascript:")); assert.ok(!html.includes("user:password")); assert.match(html,/href="https:\/\/example.com\/listing\?a=1&amp;b=2"/); assert.match(html,/rel="noopener noreferrer"/);
});
