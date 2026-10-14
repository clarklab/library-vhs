#!/usr/bin/env node
// Runs the actual count/read/reconcile pipeline on a caller-provided image.
// Photos, credentials and provider responses are not committed as fixtures.
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { createScanHandler } from "../netlify/functions/scan.mjs";
import { parseImageDataUrl } from "../netlify/lib/scan-contract.mjs";

const args = process.argv.slice(2);
const option = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const imagePath = option("--image") || process.env.VHS_EVAL_IMAGE;
const fixtureName = option("--fixture") || process.env.VHS_EVAL_FIXTURE;
if (args.includes("--help") || !imagePath || !fixtureName) {
  console.log("Usage: node scripts/evaluate-scan.mjs --fixture rotated-spines|mixed-shelves|rotated-covers --image /absolute/photo.png [--dry-run] [--no-verify] [--out /absolute/report.json]");
  console.log("Live mode uses ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL (including Gateway-injected values). It sends the photo to the configured AI provider and incurs normal inference usage.");
  console.log("For Netlify dev:exec, pass VHS_EVAL_IMAGE and VHS_EVAL_FIXTURE as environment variables so its CLI does not parse the evaluation flags.");
  process.exit(args.includes("--help") ? 0 : 2);
}
const fixtures = JSON.parse(await readFile(new URL("../tests/scan-fixtures.json", import.meta.url), "utf8"));
const fixture = fixtures[fixtureName];
if (!fixture) throw new Error("Unknown fixture. Use rotated-spines, mixed-shelves or rotated-covers.");
const mediaType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[extname(imagePath).toLowerCase()];
if (!mediaType) throw new Error("Provide a JPEG, PNG, WebP or GIF image.");
const image = `data:${mediaType};base64,${(await readFile(imagePath)).toString("base64")}`;
const parsed = parseImageDataUrl(image);
if (!parsed) throw new Error("The image data or format is invalid.");
if (args.includes("--dry-run")) {
  console.log(JSON.stringify({ fixture: fixtureName, validatedImageBytes: parsed.bytes, completeGroundTruth: fixture.completeGroundTruth, expectedCount: fixture.expectedCount, expectedTitles: fixture.expectedTitles.map((names) => names[0]), inferenceRun: false }, null, 2));
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Live evaluation was not run: ANTHROPIC_API_KEY is unavailable. Run with the environment injected by Netlify AI Gateway, or configure a provider key. No photo has been sent.");
  process.exit(2);
}
const handler = createScanHandler({ authenticate: async () => ({ userId: "local-evaluation" }) });
const scan = async (body) => {
  const res = await handler(new Request("http://localhost/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const result = await res.json();
  if (!res.ok) throw new Error(`${result.code}: ${result.error}`);
  return result;
};
const started = Date.now();
const initial = await scan({ image, sourceId: fixtureName, mode: "fast" });
let final = initial;
let verificationError = null;
if (initial.needsVerification && !args.includes("--no-verify")) {
  try {
    final = await scan({ image, sourceId: fixtureName, mode: "thorough", verificationContext: {
      countedCount: initial.verification.countedCount,
      uncertainCount: initial.verification.uncertainCount,
      tapes: initial.tapes,
    } });
  } catch (error) { verificationError = error.message; }
}
const normalize = (value) => value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const remaining = final.tapes.map((tape, index) => ({ index, title: normalize(tape.title) }));
const missingTitles = [];
for (const aliases of fixture.expectedTitles) {
  const at = remaining.findIndex((tape) => aliases.some((title) => normalize(title) === tape.title));
  if (at === -1) missingTitles.push(aliases[0]);
  else remaining.splice(at, 1); // A multiset comparison catches duplicate detections.
}
const excludedDetections = final.tapes.filter((tape) => fixture.excludedTitles.some((aliases) => aliases.some((title) => normalize(title) === normalize(tape.title))));
const unexpectedTitles = fixture.completeGroundTruth ? remaining.map((tape) => final.tapes[tape.index].title) : [];
const listedCountCorrect = fixture.expectedCount === null ? null : final.count === fixture.expectedCount;
const independentCountCorrect = fixture.expectedCount === null ? null : final.verification.countedCount === fixture.expectedCount;
const passed = missingTitles.length === 0 && unexpectedTitles.length === 0 && excludedDetections.length === 0 &&
  listedCountCorrect !== false && independentCountCorrect !== false;
const report = {
  fixture: fixtureName,
  assessment: !passed ? "failed" : fixture.completeGroundTruth ? "passed" : "partial-ground-truth-only",
  durationMs: Date.now() - started,
  expectedCount: fixture.expectedCount,
  listedCountCorrect,
  independentCountCorrect,
  missingTitles,
  unexpectedTitles,
  excludedDetections: excludedDetections.map((tape) => tape.title),
  verificationError,
  initial,
  final,
};
const outputPath = option("--out") || process.env.VHS_EVAL_OUTPUT;
if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
