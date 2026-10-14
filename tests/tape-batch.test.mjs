import test from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency, sanitizeTape, saveTapeBatch } from "../netlify/lib/tape-batch.mjs";

function memoryStore({ delay = 0, failWrites = [], loseWriteResponses = [], phantomWrites = [] } = {}) {
  const records = new Map();
  const calls = [];
  let activeWrites = 0;
  let peakWrites = 0;
  const store = {
    records,
    calls,
    get peakWrites() { return peakWrites; },
    async setJSON(key, value, options) {
      calls.push({ key, value: structuredClone(value), options });
      activeWrites++;
      peakWrites = Math.max(peakWrites, activeWrites);
      try {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (failWrites.includes(value.clientId)) throw new Error("Storage unavailable");
        if (phantomWrites.includes(value.clientId)) return { modified: true, etag: "" };
        // Check and insert synchronously, mirroring Blobs' atomic condition.
        if (options?.onlyIfNew && records.has(key)) return { modified: false };
        records.set(key, structuredClone(value));
        if (loseWriteResponses.includes(value.clientId)) throw new Error("Response lost after commit");
        return { modified: true, etag: "confirmed-etag" };
      } finally {
        activeWrites--;
      }
    },
    async get(key, options) {
      assert.equal(options.consistency, "strong");
      return structuredClone(records.get(key) ?? null);
    },
  };
  return store;
}

const save = (store, inputs, userId = "owner") => saveTapeBatch({ store, userId, inputs });

test("retrying a batch after losing its response acknowledges the original records", async () => {
  const store = memoryStore();
  const inputs = [{ clientId: "copy-1", title: "Alien" }, { clientId: "copy-2", title: "Alien" }];
  const first = await save(store, inputs);
  const retry = await save(store, inputs);
  assert.equal(first.tapes.length, 2);
  assert.equal(new Set(first.tapes.map((t) => t.id)).size, 2, "physical copies stay separate");
  assert.deepEqual(retry, first);
  assert.equal(store.records.size, 2);
  assert.ok(store.calls.every((call) => call.options.onlyIfNew === true));
});

test("concurrent retries create only one record and return the same stored tape", async () => {
  const store = memoryStore({ delay: 2 });
  const batches = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    save(store, [{ clientId: "one-physical-tape", title: `Version ${index}` }])
  )));
  assert.equal(store.records.size, 1);
  for (const batch of batches) {
    assert.equal(batch.failedCount, 0);
    assert.deepEqual(batch.tapes, batches[0].tapes);
  }
});

test("retrying a saved clientId preserves later edits and timestamps", async () => {
  const store = memoryStore();
  const input = { clientId: "edited-copy", title: "Uncorrected scan" };
  const first = await save(store, [input]);
  const key = `owner/${first.tapes[0].id}`;
  const edited = { ...store.records.get(key), title: "Corrected title", location: "Shelf 6", updatedAt: "2026-10-14T22:30:00.000Z" };
  store.records.set(key, edited);
  const retry = await save(store, [input]);
  assert.deepEqual(retry.tapes, [edited]);
  assert.deepEqual(store.records.get(key), edited);
});

test("the same clientId in different authenticated collections stays isolated", async () => {
  const store = memoryStore();
  const first = await save(store, [{ clientId: "same-id", title: "Owner A" }], "user-a");
  const second = await save(store, [{ clientId: "same-id", title: "Owner B" }], "user-b");
  assert.equal(store.records.size, 2);
  assert.equal(first.tapes[0].title, "Owner A");
  assert.equal(second.tapes[0].title, "Owner B");
  assert.ok([...store.records.keys()].every((key) => /^user-[ab]\/c_[a-f0-9]{64}$/.test(key)));
});

test("partial failure reports exactly which stable IDs can safely be retried", async () => {
  const store = memoryStore({ failWrites: ["retry-me"] });
  const result = await save(store, [
    { clientId: "saved", title: "Saved tape" },
    { clientId: "retry-me", title: "Unconfirmed tape" },
    { clientId: "fix-me", title: "  " },
  ]);
  assert.deepEqual(result.tapes.map((tape) => tape.clientId), ["saved"]);
  assert.equal(result.failedCount, 2);
  assert.deepEqual(result.failedClientIds, ["retry-me", "fix-me"]);
  assert.deepEqual(result.failures.map(({ index, code, retryable }) => ({ index, code, retryable })), [
    { index: 1, code: "save_failed", retryable: true },
    { index: 2, code: "missing_title", retryable: false },
  ]);
});

test("a lost write acknowledgement is recovered by a strong confirmation read", async () => {
  const store = memoryStore({ loseWriteResponses: ["committed"] });
  const result = await save(store, [{ clientId: "committed", title: "Already saved" }]);
  assert.equal(result.failedCount, 0);
  assert.equal(result.tapes[0].title, "Already saved");
  assert.equal(store.records.size, 1);
});

test("a failed conditional write cannot be reported as saved by a false SDK success", async () => {
  const store = memoryStore({ phantomWrites: ["not-committed"] });
  const result = await save(store, [{ clientId: "not-committed", title: "Not stored" }]);
  assert.equal(result.tapes.length, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.failures[0].code, "save_failed");
  assert.equal(store.records.size, 0);
});

test("a failed confirmation read retains the stable ID so a later retry is safe", async () => {
  const store = memoryStore();
  const get = store.get;
  store.get = async () => { throw new Error("Read temporarily unavailable"); };
  const inputs = [{ clientId: "saved-but-unconfirmed", title: "Still safe" }];
  const first = await save(store, inputs);
  assert.equal(first.failedCount, 1);
  assert.equal(first.failures[0].retryable, true);
  store.get = get;
  const retry = await save(store, inputs);
  assert.equal(retry.failedCount, 0);
  assert.equal(store.records.size, 1);
});

test("invalid and repeated entries produce indexed failures instead of silently disappearing", async () => {
  const store = memoryStore();
  const result = await save(store, [
    null, [], "title", {}, { title: 123 }, { title: "X", clientId: "../../other" },
    { title: "X", clientId: "" }, { title: "X", clientId: null },
    { title: "X", clientId: "a".repeat(129) },
    { title: "First", clientId: "duplicate" }, { title: "Second", clientId: "duplicate" },
  ]);
  assert.equal(result.tapes.length, 1);
  assert.equal(result.tapes[0].title, "First");
  assert.equal(result.failedCount, 10);
  assert.deepEqual(result.failures.map((f) => f.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
  assert.ok(result.failures.every((failure) => !failure.retryable));
  assert.equal(store.calls.length, 1);
});

test("legacy clients without clientId still create distinct records", async () => {
  const store = memoryStore();
  const result = await save(store, [{ title: "Alien" }, { title: "Alien" }]);
  assert.equal(result.tapes.length, 2);
  assert.equal(store.records.size, 2);
  assert.ok(result.tapes.every((tape) => !Object.hasOwn(tape, "clientId")));
});

test("100-tape batches preserve input order while bounding concurrent writes", async () => {
  const store = memoryStore({ delay: 1 });
  const inputs = Array.from({ length: 100 }, (_, i) => ({ clientId: `copy-${i}`, title: `Tape ${i}` }));
  const result = await save(store, inputs);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.tapes.map((t) => t.clientId), inputs.map((t) => t.clientId));
  assert.ok(store.peakWrites > 1, "batch writes run concurrently");
  assert.ok(store.peakWrites <= 8, "write concurrency is bounded");
});

test("empty and oversized batches are rejected before any writes", async () => {
  const store = memoryStore();
  for (const inputs of [[], null, Array.from({ length: 101 }, () => ({ title: "Too many" }))]) {
    await assert.rejects(() => save(store, inputs), RangeError);
  }
  assert.equal(store.calls.length, 0);
});

test("bounded mapping caps inventory reads and preserves their ordering", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(Array.from({ length: 500 }, (_, i) => i), 16, async (index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return index;
  });
  assert.equal(peak, 16);
  assert.deepEqual(result, Array.from({ length: 500 }, (_, i) => i));
});

test("sanitization preserves update semantics and excludes create-only identity fields", () => {
  assert.deepEqual(sanitizeTape({ title: " Corrected ", id: "bad", clientId: "bad" }, true), { title: "Corrected" });
  assert.equal(sanitizeTape({ title: "Tape" }).status, "keep");
  assert.equal(sanitizeTape({ title: "Tape", posterUrl: "javascript:alert(1)" }).posterUrl, "");
  assert.equal(sanitizeTape({ title: " ".repeat(301) + "Alien" }).title, "Alien");
  assert.equal(sanitizeTape({ title: "Tape", notes: { toString: null } }).notes, "");
  assert.equal(sanitizeTape({ title: "Tape", pricePaid: { valueOf: null, toString: null } }).pricePaid, null);
  assert.deepEqual(sanitizeTape(null, true), {});
});
