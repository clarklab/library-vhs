import test from "node:test";
import assert from "node:assert/strict";
import { sampleTapes, sampleRequest, SAMPLE_READ_ONLY } from "../public/js/sample-vault.js";

test("the sample vault holds 24 distinct, well-formed tapes", () => {
  const tapes = sampleTapes();
  assert.equal(tapes.length, 24);
  assert.equal(new Set(tapes.map((tape) => tape.id)).size, 24);
  for (const title of ["The Punisher", "Dead Heat", "Jaws", "RoboCop", "The Sandlot", "Beauty and the Beast"]) assert.ok(tapes.some((tape) => tape.title === title), title);
  for (const tape of tapes) {
    assert.ok(["available", "sold", "hold", "keep"].includes(tape.status), tape.title);
    assert.ok(["sealed", "mint", "good", "fair", "poor"].includes(tape.condition), tape.title);
    assert.ok(["", "slipcase", "bigbox", "clamshell", "screener", "other"].includes(tape.packaging), tape.title);
    if (tape.status === "sold") assert.ok(tape.priceSold > 0 && tape.soldDate, tape.title);
    if (tape.status === "available") assert.ok(tape.priceAsking > 0, tape.title);
  }
  tapes[0].title = "changed";
  assert.equal(sampleTapes()[0].title, "The Punisher");
});

test("the sample answers reads in the browser and refuses every write", async () => {
  assert.equal((await sampleRequest("GET", "/api/tapes")).tapes.length, 24);
  assert.equal((await sampleRequest("GET", "/api/auth/me")).user.sample, true);
  for (const [method, path] of [["POST", "/api/tapes"], ["PATCH", "/api/tapes/sample-1"], ["POST", "/api/value"], ["POST", "/api/upc"], ["DELETE", "/api/tapes/sample-1"]]) {
    await assert.rejects(() => sampleRequest(method, path), { message: SAMPLE_READ_ONLY, status: 403 });
  }
});
