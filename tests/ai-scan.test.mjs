import test from "node:test";
import assert from "node:assert/strict";
import { structured, parseStructuredResponse, matchesSchema, normalizeAiError, aiErrorResponse, MODEL, THOROUGH_MODEL } from "../netlify/lib/ai.mjs";
import {
  SCAN_SCHEMA, COUNT_SCHEMA, MAX_IMAGE_BYTES, parseImageDataUrl,
  normalizeScanResult, normalizeIndependentCount, reconcileScan, parseVerificationContext,
} from "../netlify/lib/scan-contract.mjs";
import { createScanHandler } from "../netlify/functions/scan.mjs";

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5xkAAAAASUVORK5CYII=";
const tape = (overrides = {}) => ({ title: "Alien", format: "VHS", year: 1979, confidence: "high", visual: "Leftmost black spine", edition: "", ...overrides });
const reading = (tapes = [tape()], count = tapes.length) => ({ count, tapes, notes: "" });
const response = (data, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(data) }] });
const request = (body) => new Request("https://example.test/api/scan", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const countResult = (count, uncertainCount = 0) => ({ count, positions: Number.isInteger(count) && count > 0 && count < 200 ? Array.from({ length: count }, (_, index) => `box-${index + 1}`) : [], uncertainCount, notes: "" });

// Upload rejection must happen before paid inference.
test("image parser validates base64, exact byte count and matching file signature", () => {
  const image = parseImageDataUrl(PHOTO);
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.bytes, Buffer.from(PHOTO.split(",")[1], "base64").length);
  assert.equal(parseImageDataUrl(PHOTO.replace("image/png", "image/jpeg")), null);
  assert.equal(parseImageDataUrl("data:image/png;base64,@@@@"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64,"), null);
  assert.equal(parseImageDataUrl("data:text/plain;base64,aGVsbG8="), null);
  assert.equal(parseImageDataUrl(null), null);
});

test("oversized input returns a non-retryable 413 before decoding", () => {
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${"A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024)}`),
    (error) => error.status === 413 && error.code === "IMAGE_TOO_LARGE" && !error.retryable);
});

test("structured output validates nested types, required fields, enum and unexpected properties", () => {
  assert.equal(matchesSchema(reading(), SCAN_SCHEMA), true);
  for (const bad of [null, {}, reading([null]), reading([tape({ year: "1979" })]), reading([tape({ confidence: "certain" })]), { ...reading(), extra: true }]) {
    assert.equal(matchesSchema(bad, SCAN_SCHEMA), false);
    assert.throws(() => parseStructuredResponse(response(bad), SCAN_SCHEMA), (error) => error.code === "AI_INVALID_RESPONSE");
  }
});

test("thinking blocks are ignored but refusal, truncation and unfinished turns cannot become results", () => {
  assert.deepEqual(parseStructuredResponse(response(reading()), SCAN_SCHEMA), reading());
  assert.throws(() => parseStructuredResponse(response(reading(), "max_tokens"), SCAN_SCHEMA), (error) => error.code === "AI_TRUNCATED");
  assert.throws(() => parseStructuredResponse(response(reading(), "refusal"), SCAN_SCHEMA), (error) => error.code === "AI_REFUSAL");
  assert.throws(() => parseStructuredResponse(response(reading(), "pause_turn"), SCAN_SCHEMA), (error) => error.code === "AI_INVALID_RESPONSE");
  assert.throws(() => parseStructuredResponse({ stop_reason: "end_turn", content: {} }, SCAN_SCHEMA), (error) => error.code === "AI_INVALID_RESPONSE");
});

test("scan normalization retains separate physical copies of the same film", () => {
  const normalized = normalizeScanResult(reading([tape(), tape({ visual: "Second black spine" })]));
  assert.equal(normalized.count, 2);
  assert.deepEqual(normalized.tapes.map((item) => item.sourceIndex), [1, 2]);
  assert.equal(normalized.tapes[0].title, normalized.tapes[1].title);
});

test("unreadable titles are review items even if the model marks them high confidence", () => {
  const normalized = normalizeScanResult(reading([tape({ title: " ", year: 20 }), tape({ title: "Unknown tape" }), tape({ confidence: "medium" })]));
  assert.equal(normalized.reviewCount, 3);
  assert.equal(normalized.tapes[0].title, "Unknown");
  assert.equal(normalized.tapes[0].year, null);
  assert.equal(normalized.tapes[1].confidence, "low");
});

test("ambiguous format requires review and clear non-VHS entries fail the scan contract", () => {
  const normalized = normalizeScanResult(reading([tape({ format: "unknown" })]));
  assert.equal(normalized.tapes[0].format, "unknown");
  assert.equal(normalized.tapes[0].confidence, "medium");
  assert.equal(normalized.tapes[0].needsReview, true);
  assert.throws(() => normalizeScanResult(reading([tape({ format: "DVD" })])), (error) => error.code === "AI_INVALID_RESPONSE");
});

test("count disagreement and dense scenes are surfaced rather than silently truncating", () => {
  const normalized = normalizeScanResult(reading([tape()], 110));
  assert.equal(normalized.reportedCount, 110);
  assert.deepEqual(normalized.warnings.map((warning) => warning.code), ["COUNT_MISMATCH", "PHOTO_TOO_DENSE"]);
  assert.throws(() => normalizeScanResult(reading(Array.from({ length: 101 }, () => tape()))), (error) => error.code === "PHOTO_TOO_DENSE");
});

test("invalid and malicious counts do not become inventory evidence", () => {
  for (const count of [-1, 1.5, 10001, "12", Infinity]) {
    assert.throws(() => normalizeScanResult(reading([tape()], count)), (error) => error.code === "AI_INVALID_RESPONSE");
    assert.throws(() => normalizeIndependentCount(countResult(count)), (error) => error.code === "AI_INVALID_COUNT");
  }
  assert.throws(() => normalizeIndependentCount(countResult(2, 3)), (error) => error.code === "AI_INVALID_COUNT");
  assert.throws(() => normalizeIndependentCount({ ...countResult(2), positions: ["R1-left", "R1-left"] }), (error) => error.code === "AI_INVALID_COUNT");
  assert.throws(() => normalizeIndependentCount({ ...countResult(2), positions: ["R1-left"] }), (error) => error.code === "AI_INVALID_COUNT");
});

test("independent counting catches title omissions even when identification self-count agrees", () => {
  const result = reconcileScan(reading([tape()], 1), countResult(2));
  assert.equal(result.verification.status, "mismatch");
  assert.equal(result.verification.countedCount, 2);
  assert.equal(result.needsVerification, true);
  assert.ok(result.warnings.some((warning) => warning.code === "INDEPENDENT_COUNT_MISMATCH"));
});

test("a matched count does not hide title or object-boundary uncertainty", () => {
  assert.equal(reconcileScan(reading(), countResult(1)).needsVerification, false);
  assert.equal(reconcileScan(reading([tape({ confidence: "medium" })]), countResult(1)).needsVerification, true);
  assert.equal(reconcileScan(reading(), countResult(1, 1)).needsVerification, true);
  assert.equal(reconcileScan(reading(), null).verification.status, "unavailable");
});

test("independent counter notes expose ignored non-VHS shelf areas to the reviewer", () => {
  const result = reconcileScan(reading(), { ...countResult(1), notes: "DVDs below and CD jewel cases on the right were excluded." });
  assert.match(result.notes, /DVDs below and CD jewel cases/);
});

test("a failed verifier can never silently force the initial count to match", () => {
  const result = reconcileScan(reading([tape(), tape()], 2), countResult(3), { reviewed: true });
  assert.equal(result.count, 2);
  assert.equal(result.verification.stage, "reviewed");
  assert.equal(result.verification.status, "mismatch");
  assert.equal(result.needsVerification, true);
});

test("verification context bounds untrusted input", () => {
  assert.equal(parseVerificationContext({ tapes: new Array(101).fill(tape()) }), null);
  const context = parseVerificationContext({ countedCount: "2", tapes: [null, { title: "x".repeat(500) }] });
  assert.equal(context.countedCount, null);
  assert.equal(context.tapes[0].title, "Unknown");
  assert.equal(context.tapes[1].title.length, 300);
});

test("provider transient retry is bounded to two attempts under one deadline", async () => {
  const options = [];
  const sleeps = [];
  const client = { messages: { create: async (payload, option) => {
    options.push(option);
    assert.equal(payload.model, MODEL);
    assert.equal(payload.thinking.type, "adaptive");
    if (options.length === 1) throw { status: 503 };
    return response(reading());
  } } };
  await structured({ system: "test", content: [], schema: SCAN_SCHEMA, client, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(options.length, 2);
  assert.deepEqual(sleeps, [1200]);
  assert.equal(options[0].maxRetries, 0);
  assert.ok(options[1].timeout <= options[0].timeout && options[0].timeout <= 48000);
});

test("long rate limits, timeouts and configuration errors are not retried inside the function", async () => {
  for (const failure of [{ status: 429, headers: new Headers({ "retry-after": "30" }) }, { name: "APIConnectionTimeoutError" }, { status: 401 }]) {
    let calls = 0;
    const client = { messages: { create: async () => { calls++; throw failure; } } };
    await assert.rejects(structured({ system: "test", content: [], schema: SCAN_SCHEMA, client }));
    assert.equal(calls, 1);
  }
});

test("cancelled request cannot start an inference call", async () => {
  let calls = 0;
  const client = { messages: { create: async () => { calls++; } } };
  await assert.rejects(structured({ system: "test", content: [], schema: SCAN_SCHEMA, client, signal: AbortSignal.abort() }), (error) => error.code === "SCAN_CANCELLED");
  assert.equal(calls, 0);
});

test("public errors expose recovery metadata without provider request data", async (t) => {
  t.mock.method(console, "error", () => {});
  const error = normalizeAiError({ status: 429, headers: new Headers({ "retry-after": "9" }), message: "secret-photo-data" });
  const res = aiErrorResponse(error);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "9");
  const body = await res.json();
  assert.equal(body.retryable, true);
  assert.equal(body.retryAfterMs, 9000);
  assert.equal(JSON.stringify(body).includes("secret-photo-data"), false);
});

test("scan route rejects invalid uploads and modes without calling provider", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const handler = createScanHandler({ authenticate: async () => ({ userId: "test" }), runStructured: async () => { calls++; } });
  const invalid = await handler(request({ image: "not-an-image" }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_IMAGE");
  assert.equal((await handler(request({ image: PHOTO, mode: "arbitrary-model" }))).status, 400);
  assert.equal(calls, 0);
});

test("fast route runs independent count and title OCR without giving counter the title draft", async () => {
  const calls = [];
  const handler = createScanHandler({ authenticate: async () => ({ userId: "test" }), runStructured: async (options) => {
    calls.push(options);
    return options.schema === COUNT_SCHEMA ? countResult(2) : reading([tape()]);
  } });
  const res = await handler(request({ image: PHOTO, sourceId: "photo-1" }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls.find((call) => call.schema === COUNT_SCHEMA).content[1].text.includes("Alien"), false);
  assert.equal(body.sourceId, "photo-1");
  assert.equal(body.verification.countedCount, 2);
  assert.equal(body.needsVerification, true);
  assert.equal(body.model, MODEL);
});

test("counter failures preserve successful title readings with an explicit warning", async () => {
  const handler = createScanHandler({ authenticate: async () => ({ userId: "test" }), runStructured: async (options) => {
    if (options.schema === COUNT_SCHEMA) throw new Error("counter unavailable");
    return reading();
  } });
  const body = await (await handler(request({ image: PHOTO }))).json();
  assert.equal(body.count, 1);
  assert.equal(body.verification.status, "unavailable");
  assert.equal(body.needsVerification, true);
});

test("conditional thorough route uses Opus to reconcile the draft and preserves independent evidence", async () => {
  const calls = [];
  const handler = createScanHandler({ authenticate: async () => ({ userId: "test" }), runStructured: async (options) => {
    calls.push(options);
    return options.schema === COUNT_SCHEMA ? countResult(2) : reading([tape(), tape({ title: "Aliens", year: 1986 })]);
  } });
  const body = await (await handler(request({ image: PHOTO, mode: "thorough", verificationContext: { countedCount: 2, uncertainCount: 0, tapes: [tape()] } }))).json();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, THOROUGH_MODEL);
  assert.equal(calls[1].model, THOROUGH_MODEL);
  assert.equal(calls[0].content[1].text.includes("fallible hypotheses"), true);
  assert.equal(body.verification.status, "matched");
  assert.equal(body.verification.stage, "reviewed");
  assert.equal(body.count, 2);
  assert.equal(body.needsVerification, false);
});

test("thorough route retries independent counting when earlier count was unavailable", async () => {
  const calls = [];
  const handler = createScanHandler({ authenticate: async () => ({ userId: "test" }), runStructured: async (options) => {
    calls.push(options);
    return options.schema === COUNT_SCHEMA ? countResult(1) : reading();
  } });
  const body = await (await handler(request({ image: PHOTO, mode: "thorough", verificationContext: { countedCount: null, tapes: [tape()] } }))).json();
  assert.equal(calls.length, 2);
  assert.equal(body.verification.status, "matched");
});
