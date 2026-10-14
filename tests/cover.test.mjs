import test from "node:test";
import assert from "node:assert/strict";
import { createCoverHandler } from "../netlify/functions/cover.mjs";
import { requireAuth } from "../netlify/lib/util.mjs";

const COVER_ID = "c".repeat(32);
const OWNER_TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

function fixture() {
  const users = new Map([ ["owner", { id: "owner", sessionVersion: 0 }], ["other", { id: "other", sessionVersion: 0 }] ]);
  const sessions = new Map([
    [OWNER_TOKEN, { userId: "owner", expiresAt: Date.now() + 60000 }],
    [OTHER_TOKEN, { userId: "other", expiresAt: Date.now() + 60000 }],
  ]);
  const covers = new Map([[COVER_ID, { data: IMAGE, metadata: { userId: "owner", contentType: "image/png" } }]]);
  const tapes = new Map();
  const reads = [];
  const handler = createCoverHandler({
    authenticate: (req) => requireAuth(req, {
      users: { get: async (id) => users.get(id) },
      sessions: { get: async (id) => sessions.get(id), delete: async (id) => sessions.delete(id) },
    }),
    getCovers: () => ({
      getWithMetadata: async (id) => { reads.push(id); return covers.get(id); },
      getMetadata: async (id) => { const cover = covers.get(id); return cover ? { metadata: cover.metadata } : null; },
      set: async (id, data, { metadata }) => covers.set(id, { data, metadata }),
      delete: async (id) => covers.delete(id),
    }),
    getTapes: () => ({ get: async (key) => tapes.get(key), setJSON: async (key, tape) => tapes.set(key, tape) }),
  });
  return { handler, users, covers, tapes, reads };
}

function imageRequest(token = OWNER_TOKEN, { bearer = false, id = COVER_ID } = {}) {
  return new Request(`https://vault.test/api/cover/${id}`, {
    headers: token ? (bearer ? { authorization: `Bearer ${token}` } : { cookie: `__Host-vhs_session=${token}` }) : {},
  });
}

test("an owner can load an uploaded cover with a native image cookie request or legacy bearer", async () => {
  const { handler } = fixture();
  for (const bearer of [false, true]) {
    const response = await handler(imageRequest(OWNER_TOKEN, { bearer }), { params: { coverId: COVER_ID } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), IMAGE);
  }
});

test("signed-out cover requests fail before any image is read", async () => {
  const { handler, reads } = fixture();
  const response = await handler(imageRequest(null), { params: { coverId: COVER_ID } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(reads, []);
});

test("another account and covers without owner metadata are indistinguishable from missing covers", async () => {
  const { handler, covers } = fixture();
  let response = await handler(imageRequest(OTHER_TOKEN), { params: { coverId: COVER_ID } });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  covers.get(COVER_ID).metadata = { contentType: "image/png" };
  response = await handler(imageRequest(), { params: { coverId: COVER_ID } });
  assert.equal(response.status, 404);
});

test("revoked sessions cannot retrieve uploaded image bytes", async () => {
  const { handler, users, reads } = fixture();
  users.get("owner").sessionVersion = 1;
  const response = await handler(imageRequest(), { params: { coverId: COVER_ID } });
  assert.equal(response.status, 401);
  assert.deepEqual(reads, []);
});

test("cover metadata cannot turn an authenticated image response into executable content", async () => {
  const { handler, covers } = fixture();
  covers.get(COVER_ID).metadata.contentType = "text/html";
  const response = await handler(imageRequest(), { params: { coverId: COVER_ID } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("upload cleanup cannot delete a different account's cover referenced by a tape URL", async () => {
  const { handler, covers, tapes } = fixture();
  tapes.set("other/tape-1", { id: "tape-1", posterUrl: `/api/cover/${COVER_ID}` });
  const response = await handler(new Request("https://vault.test/api/cover", {
    method: "POST",
    headers: { cookie: `__Host-vhs_session=${OTHER_TOKEN}`, origin: "https://vault.test", "content-type": "application/json" },
    body: JSON.stringify({ tapeId: "tape-1", image: `data:image/png;base64,${IMAGE.toString("base64")}` }),
  }));
  assert.equal(response.status, 200);
  assert.ok(covers.has(COVER_ID));
  const { tape } = await response.json();
  assert.notEqual(tape.posterUrl, `/api/cover/${COVER_ID}`);
  const uploadedId = tape.posterUrl.split("/").pop();
  assert.equal(covers.get(uploadedId).metadata.userId, "other");
});
