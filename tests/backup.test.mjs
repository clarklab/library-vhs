import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_FORMAT, BACKUP_VERSION, backupManifest, digest, restoreRecords, tapeDestinationId, coverDestinationId } from "../netlify/lib/backup-store.mjs";
import { createBackupHandler } from "../netlify/functions/backup.mjs";
import { normalizeValue } from "../netlify/lib/value-contract.mjs";

function storeMock({ phantom = false, lostResponse = false } = {}) {
  const records = new Map();
  return {
    records,
    async list({ prefix }) { return { blobs: [...records.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async get(key) { return structuredClone(records.get(key)?.data ?? null); },
    async getWithMetadata(key) { return structuredClone(records.get(key) ?? null); },
    async getMetadata(key) { const value = records.get(key); return value ? { metadata: structuredClone(value.metadata) } : null; },
    async setJSON(key, data, options = {}) { return this.set(key, structuredClone(data), options); },
    async set(key, data, options = {}) {
      if (options.onlyIfNew && records.has(key)) return { modified: false };
      if (!phantom) records.set(key, { data, metadata: options.metadata || {} });
      if (lostResponse) throw new Error("Response lost");
      return { modified: true };
    },
    async delete(key) { records.delete(key); },
  };
}
const storesMock = (options) => ({ tapes: storeMock(options), scouts: storeMock(options), covers: storeMock(options), staging: storeMock(options) });
const sourceId = "original-account", targetId = "restored-account";
const createdAt = "2023-02-01T12:00:00.000Z", updatedAt = "2025-02-01T12:00:00.000Z";
const envelope = (kind, records, extra = {}) => ({ format: BACKUP_FORMAT, version: BACKUP_VERSION, source: { accountId: sourceId }, exportedAt: "2026-10-14T12:00:00.000Z", kind, records, ...extra });
const tape = (clientId = "physical-copy-1", extra = {}) => ({ id: `c_${digest(clientId)}`, clientId, title: "Alien", year: 1979, format: "VHS", createdAt, updatedAt, notes: "My actual copy", actors: ["Sigourney Weaver"], tags: ["science fiction"], status: "sold", priceSold: 12, soldDate: "2025-01-01", ...extra });
const legacy = (id = "legacy-1") => ({ id, title: "Alien", createdAt, updatedAt, posterUrl: "" });
const scout = (items = [{ clientId: "physical-copy-1", title: "Alien", format: "VHS", purchasedTapeId: tape().id, estimate: { ...normalizeValue({ known: true, low: 10, high: 30, typical: 20, demand: "steady", factors: ["Check edition"], summary: "AI estimate only." }), estimatedAt: updatedAt } }]) => ({ id: `s_${digest("list-1")}`, clientId: "list-1", name: "Saturday thrift", createdAt, updatedAt, revision: "old-revision", photos: [{ id: "photo-1", name: "Shelf" }], items });
const coverId = "a".repeat(32);
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const cover = () => ({ id: coverId, contentType: "image/png", data: bytes.toString("base64"), sha256: digest(bytes) });

test("restore preserves full tape data/dates and retries retain edited records and distinct physical copies", async () => {
  const stores = storesMock();
  const input = envelope("tapes", [tape(), tape("physical-copy-2")]);
  const first = await restoreRecords({ stores, userId: targetId, input });
  assert.equal(first.created, 2);
  const key = `${targetId}/${tape().id}`;
  const saved = await stores.tapes.get(key);
  for (const field of ["createdAt", "updatedAt", "status", "priceSold", "soldDate", "notes", "actors", "tags"]) assert.deepEqual(saved[field], tape()[field]);
  saved.notes = "Edited after restore";
  await stores.tapes.setJSON(key, saved);
  const retry = await restoreRecords({ stores, userId: targetId, input });
  assert.equal(retry.existing, 2);
  assert.equal(stores.tapes.records.size, 2);
  assert.equal((await stores.tapes.get(key)).notes, "Edited after restore");
});

test("same-account legacy IDs survive, cross-account legacy mapping is deterministic and source-specific", async () => {
  const stores = storesMock();
  const input = envelope("tapes", [legacy()]);
  const same = await restoreRecords({ stores, userId: sourceId, input });
  assert.equal(same.results[0].id, "legacy-1");
  const cross = await restoreRecords({ stores, userId: targetId, input });
  assert.equal(cross.results[0].id, tapeDestinationId({ sourceId, userId: targetId, id: "legacy-1" }));
  const differentSource = await restoreRecords({ stores, userId: targetId, input: { ...input, source: { accountId: "different-account" } } });
  assert.notEqual(differentSource.results[0].id, cross.results[0].id);
});

test("portable covers restore before records, remap across accounts, and never overwrite another owner's asset", async () => {
  const stores = storesMock();
  const savedTape = tape("physical-copy-1", { posterUrl: `/api/cover/${coverId}` });
  const missingCover = await restoreRecords({ stores, userId: targetId, input: envelope("tapes", [savedTape]) });
  assert.equal(missingCover.failedCount, 1);
  assert.equal(stores.tapes.records.size, 0);
  const imported = await restoreRecords({ stores, userId: targetId, input: envelope("covers", [cover()]) });
  const mapped = coverDestinationId({ sourceId, userId: targetId, id: coverId });
  assert.equal(imported.results[0].id, mapped);
  assert.equal(imported.created, 1);
  assert.equal((await restoreRecords({ stores, userId: targetId, input: envelope("covers", [cover()]) })).existing, 1);
  assert.equal((await restoreRecords({ stores, userId: targetId, input: envelope("tapes", [savedTape]) })).created, 1);
  assert.equal((await stores.tapes.get(`${targetId}/${savedTape.id}`)).posterUrl, `/api/cover/${mapped}`);
  await stores.covers.set(coverId, bytes, { metadata: { userId: "someone-else", contentType: "image/png" } });
  const collision = await restoreRecords({ stores, userId: sourceId, input: envelope("covers", [cover()]) });
  assert.equal(collision.failedCount, 1);
  assert.equal((await stores.covers.getMetadata(coverId)).metadata.userId, "someone-else");
});

test("scout estimates, source references and purchase links survive portable restore", async () => {
  const stores = storesMock();
  await restoreRecords({ stores, userId: targetId, input: envelope("tapes", [tape()]) });
  const original = scout();
  const restored = await restoreRecords({ stores, userId: targetId, input: envelope("scouts", [original]) });
  assert.equal(restored.created, 1);
  const saved = await stores.scouts.get(`${targetId}/${original.id}`);
  assert.deepEqual(saved.items, original.items);
  assert.deepEqual(saved.photos, original.photos);
  assert.equal(saved.createdAt, createdAt);
  assert.equal(saved.updatedAt, updatedAt);
  assert.equal((await restoreRecords({ stores, userId: targetId, input: envelope("scouts", [original]) })).existing, 1);
});

test("unknown versions and invalid envelope sizes fail before writes; record failures are explicit", async () => {
  const stores = storesMock();
  await assert.rejects(() => restoreRecords({ stores, userId: targetId, input: envelope("tapes", [tape()], { version: 2 }) }), /not supported/);
  await assert.rejects(() => restoreRecords({ stores, userId: targetId, input: envelope("tapes", Array.from({ length: 101 }, () => tape())) }), /between 1 and 100/);
  const result = await restoreRecords({ stores, userId: targetId, input: envelope("tapes", [tape("good"), tape("secret", { passHash: "secret" }), tape("bad-date", { createdAt: "yesterday" }), tape("wrong-id", { id: tape().id })]) });
  assert.equal(result.created, 1);
  assert.equal(result.failedCount, 3);
  assert.ok(result.results.slice(1).every((record) => record.status === "failed" && !record.retryable));
  assert.equal(stores.tapes.records.size, 1);
});

test("untrusted backups cannot choose storage paths, inject unknown fields or overwrite another account", async () => {
  const stores = storesMock();
  await stores.tapes.setJSON(`${sourceId}/${tape().id}`, tape("physical-copy-1", { notes: "Private original" }));
  const bad = [tape("traversal", { id: "../another-user/tape" }), JSON.parse('{"id":"poison","title":"Alien","__proto__":{"admin":true}}'), tape("forged-owner", { userId: sourceId })];
  const rejected = await restoreRecords({ stores, userId: targetId, input: envelope("tapes", bad) });
  assert.equal(rejected.failedCount, 3);
  assert.equal(stores.tapes.records.size, 1);
  assert.equal({}.admin, undefined);
  await restoreRecords({ stores, userId: targetId, input: envelope("tapes", [tape("physical-copy-1", { notes: "Imported elsewhere" })]) });
  assert.equal((await stores.tapes.get(`${sourceId}/${tape().id}`)).notes, "Private original");
  await assert.rejects(() => restoreRecords({ stores, userId: targetId, input: envelope("tapes", [legacy("a"), legacy("a")]) }), /distinct ID/);
  await assert.rejects(() => restoreRecords({ stores, userId: targetId, input: envelope("tapes", [tape("same", { id: "a" }), tape("same", { id: "b" })]) }), /distinct clientId/);
});

test("forged live-sales estimates and unknown scout properties fail validation", async () => {
  const stores = storesMock();
  const record = scout();
  record.items[0].estimate.liveComps = true;
  assert.equal((await restoreRecords({ stores, userId: targetId, input: envelope("scouts", [record]) })).failedCount, 1);
  assert.equal((await restoreRecords({ stores, userId: targetId, input: envelope("scouts", [{ ...scout(), passHash: "secret" }]) })).failedCount, 1);
  assert.equal(stores.scouts.records.size, 0);
});

test("cover checksums, byte signatures and base64 are validated before storing", async () => {
  const stores = storesMock();
  for (const invalid of [{ ...cover(), sha256: "0".repeat(64) }, { ...cover(), contentType: "image/jpeg" }, { ...cover(), data: "garbage" }, { ...cover(), contentType: "text/html" }]) {
    const result = await restoreRecords({ stores, userId: targetId, input: envelope("covers", [invalid]) });
    assert.equal(result.failedCount, 1);
  }
  assert.equal(stores.covers.records.size, 0);
});

test("confirmation reads detect phantom writes and recover lost responses", async () => {
  const phantom = storesMock({ phantom: true });
  const result = await restoreRecords({ stores: phantom, userId: targetId, input: envelope("tapes", [tape()]) });
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].retryable, true);
  const lost = storesMock({ lostResponse: true });
  const recovered = await restoreRecords({ stores: lost, userId: targetId, input: envelope("tapes", [tape()]) });
  assert.equal(recovered.created, 1);
  assert.equal(lost.tapes.records.size, 1);
});

test("concurrent identical restore requests create one record and an ID collision keeps the existing record", async () => {
  const stores = storesMock();
  const input = envelope("tapes", [tape()]);
  const results = await Promise.all([restoreRecords({ stores, userId: targetId, input }), restoreRecords({ stores, userId: targetId, input })]);
  assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.existing, 0), 1);
  assert.equal(stores.tapes.records.size, 1);
  await stores.tapes.setJSON(`${targetId}/${tape().id}`, { ...tape(), clientId: "different-copy", notes: "Preserve me" });
  const collision = await restoreRecords({ stores, userId: targetId, input });
  assert.equal(collision.failedCount, 1);
  assert.equal((await stores.tapes.get(`${targetId}/${tape().id}`)).notes, "Preserve me");
});

test("large scout restores publish only after all checksum-verified chunks arrive and retries do not replace edits", async () => {
  const stores = storesMock();
  const original = scout(Array.from({ length: 205 }, (_, index) => ({ clientId: `copy-${index}`, title: `Tape ${index}`, notes: "x".repeat(2000) })));
  const snapshotId = digest(JSON.stringify(original));
  const send = (index, changed = false) => restoreRecords({ stores, userId: targetId, input: envelope("scouts", [{ ...original, items: original.items.slice(index * 100, (index + 1) * 100).map((item) => changed ? { ...item, title: "Corrupted" } : item) }], { scoutPart: { index, count: 3, totalItems: 205, snapshotId } }) });
  assert.equal((await send(0)).results[0].status, "staged");
  assert.equal(stores.scouts.records.size, 0);
  assert.equal((await send(0, true)).failedCount, 1);
  assert.equal((await send(1)).results[0].status, "staged");
  assert.equal((await send(2)).created, 1);
  const key = `${targetId}/${original.id}`;
  const saved = await stores.scouts.get(key);
  assert.deepEqual(saved.items, original.items);
  assert.equal(stores.staging.records.size, 0);
  await stores.scouts.setJSON(key, { ...saved, name: "Changed after import" });
  assert.equal((await send(2)).existing, 1);
  assert.equal((await stores.scouts.get(key)).name, "Changed after import");
});

test("wrong full scout checksum never publishes a partial list", async () => {
  const stores = storesMock();
  const original = scout();
  const result = await restoreRecords({ stores, userId: targetId, input: envelope("scouts", [original], { scoutPart: { index: 0, count: 1, totalItems: 1, snapshotId: "0".repeat(64) } }) });
  assert.equal(result.failedCount, 1);
  assert.equal(stores.scouts.records.size, 0);
});

test("exports are account-scoped, exclude internal/secrets, paginate, and detect edits by fingerprint", async () => {
  const stores = storesMock();
  for (let index = 0; index < 105; index++) {
    const record = tape(`copy-${index}`, { passHash: "never export", backupReceipt: "internal" });
    await stores.tapes.setJSON(`${sourceId}/${record.id}`, record);
  }
  await stores.tapes.setJSON(`other-user/${tape().id}`, tape());
  const handler = createBackupHandler({ authenticate: async () => ({ userId: sourceId }), getStores: () => stores });
  const initial = await backupManifest({ stores, userId: sourceId });
  assert.equal(initial.tapeIds.length, 105);
  const first = await handler(new Request("https://example.test/api/backup/tapes"), { params: { kind: "tapes" } });
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstBody = await first.json();
  assert.equal(firstBody.records.length, 100);
  assert.equal(firstBody.nextCursor, "100");
  assert.ok(!JSON.stringify(firstBody).includes("never export"));
  assert.ok(!JSON.stringify(firstBody).includes("backupReceipt"));
  const last = await (await handler(new Request("https://example.test/api/backup/tapes?cursor=100"), { params: { kind: "tapes" } })).json();
  assert.equal(last.records.length, 5);
  assert.equal(last.nextCursor, null);
  await stores.tapes.setJSON(`${sourceId}/${tape("copy-0").id}`, tape("copy-0", { notes: "Changed" }));
  assert.notEqual((await backupManifest({ stores, userId: sourceId })).fingerprint, initial.fingerprint);
});

test("backup routes require auth, forbid other users' covers and reject oversized HTTP input", async () => {
  const unauthenticated = createBackupHandler({ authenticate: async () => null, getStores: () => { throw new Error("Must not open stores"); } });
  assert.equal((await unauthenticated(new Request("https://example.test/api/backup"))).status, 401);
  const stores = storesMock();
  await stores.covers.set(coverId, bytes, { metadata: { userId: sourceId, contentType: "image/png" } });
  const other = createBackupHandler({ authenticate: async () => ({ userId: targetId }), getStores: () => stores });
  assert.equal((await other(new Request(`https://example.test/api/backup/covers/${coverId}`), { params: { kind: "covers", id: coverId } })).status, 404);
  const owner = createBackupHandler({ authenticate: async () => ({ userId: sourceId }), getStores: () => stores });
  const exported = await (await owner(new Request(`https://example.test/api/backup/covers/${coverId}`), { params: { kind: "covers", id: coverId } })).json();
  assert.deepEqual(exported, cover());
  const tooBig = new Request("https://example.test/api/backup/restore", { method: "POST", headers: { "content-length": String(5 * 1024 * 1024) }, body: "{}" });
  assert.equal((await owner(tooBig, { params: { kind: "restore" } })).status, 413);
  const undeclaredSize = new Request("https://example.test/api/backup/restore", { method: "POST", body: "x".repeat(4 * 1024 * 1024 + 1) });
  assert.equal((await owner(undeclaredSize, { params: { kind: "restore" } })).status, 413);
});

test("browser backup orchestration completes a portable cross-account round trip with multi-part scouts", async () => {
  const { collectAccountBackup, createRestorePlan, runRestorePlan } = await import("../public/js/backup-io.js");
  const { validateBackup } = await import("../public/js/backup-formats.js");
  const stores = storesMock();
  const originalTape = tape("physical-copy-1", { posterUrl: `/api/cover/${coverId}` });
  const originalScout = scout([
    ...scout().items,
    ...Array.from({ length: 204 }, (_, index) => ({ clientId: `extra-${index}`, title: `Tape ${index}`, format: "VHS", estimate: null, purchasedTapeId: null })),
  ]);
  await stores.tapes.setJSON(`${sourceId}/${originalTape.id}`, originalTape);
  await stores.scouts.setJSON(`${sourceId}/${originalScout.id}`, originalScout);
  await stores.covers.set(coverId, bytes, { metadata: { userId: sourceId, contentType: "image/png" } });
  const client = (userId) => {
    const handler = createBackupHandler({ authenticate: async () => ({ userId }), getStores: () => stores });
    const request = async (kind, id, cursor, payload) => {
      const url = `https://example.test/api/backup${kind ? `/${kind}` : ""}${id ? `/${id}` : ""}${cursor !== undefined ? `?cursor=${cursor}` : ""}`;
      const response = await handler(new Request(url, payload ? { method: "POST", body: JSON.stringify(payload) } : {}), { params: { kind, id } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      return body;
    };
    return {
      backupManifest: () => request(),
      backupTapes: (cursor) => request("tapes", null, cursor),
      backupScout: (id, cursor) => request("scouts", id, cursor),
      backupCover: (id) => request("covers", id),
      restoreBackup: (payload) => request("restore", null, undefined, payload),
    };
  };
  const backup = JSON.parse(JSON.stringify(await collectAccountBackup(client(sourceId))));
  assert.equal(backup.scouts[0].items.length, 205);
  assert.deepEqual(backup.covers[0], cover());
  const validation = await validateBackup(backup);
  assert.deepEqual(validation.issues, []);
  const first = await runRestorePlan(await createRestorePlan(backup), client(targetId));
  assert.equal(first.created, 3);
  assert.equal(first.completed, true);
  const again = await runRestorePlan(await createRestorePlan(backup), client(targetId));
  assert.equal(again.created, 0);
  assert.equal(again.existing, 3);
  const destination = await collectAccountBackup(client(targetId));
  assert.equal(destination.tapes.length, 1);
  assert.equal(destination.scouts.length, 1);
  assert.equal(destination.covers.length, 1);
  assert.deepEqual(destination.scouts[0].items, originalScout.items);
  assert.equal(destination.tapes[0].createdAt, createdAt);
  assert.equal(destination.tapes[0].updatedAt, updatedAt);
  assert.deepEqual((await validateBackup(destination)).issues, []);
});
