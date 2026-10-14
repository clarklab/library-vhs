import { getStore } from "@netlify/blobs";
import { requireAuth, tapesStore, coversStore, json } from "../lib/util.mjs";
import { mapWithConcurrency } from "../lib/tape-batch.mjs";
import { BackupError, BACKUP_PAGE_SIZE, backupManifest, digest, exportTape, exportScout, restoreRecords } from "../lib/backup-store.mjs";

export const config = { path: ["/api/backup", "/api/backup/:kind", "/api/backup/:kind/:id"] };
const reply = (data, status = 200) => json(data, status, { "cache-control": "no-store" });
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

async function readLimitedJson(req) {
  if (Number(req.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new BackupError("This restore chunk is too large. Use smaller chunks.", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new BackupError("Provide a restore request.");
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) { await reader.cancel(); throw new BackupError("This restore chunk is too large. Use smaller chunks.", 413); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("The restore request is not valid JSON.");
  }
}

export function createBackupHandler({ authenticate = requireAuth, getStores = () => ({
  tapes: tapesStore(), covers: coversStore(), scouts: getStore({ name: "scouts", consistency: "strong" }),
  staging: getStore({ name: "backup-imports", consistency: "strong" }),
}) } = {}) {
  return async (req, context = {}) => {
    try {
      const auth = await authenticate(req);
      if (!auth) return reply({ error: "Not signed in." }, 401);
      const stores = getStores();
      const { kind, id } = context.params || {};
      if (req.method === "POST" && kind === "restore" && !id) {
        return reply(await restoreRecords({ stores, userId: auth.userId, input: await readLimitedJson(req) }));
      }
      if (req.method !== "GET") return reply({ error: "Not found." }, 404);
      if (!kind) return reply(await backupManifest({ stores, userId: auth.userId }));
      if (kind === "tapes" && !id) {
        const cursor = new URL(req.url).searchParams.get("cursor") || "0";
        if (!/^\d{1,10}$/.test(cursor)) throw new BackupError("Invalid backup cursor.");
        const start = Number(cursor);
        const { blobs } = await stores.tapes.list({ prefix: `${auth.userId}/` });
        blobs.sort((a, b) => a.key.localeCompare(b.key));
        const records = await mapWithConcurrency(blobs.slice(start, start + BACKUP_PAGE_SIZE), 8, async ({ key }) => {
          const record = await stores.tapes.get(key, { type: "json", consistency: "strong" });
          if (!record) throw new BackupError("The account changed during backup. Please start the export again.", 409);
          return exportTape(record);
        });
        return reply({ records, nextCursor: start + BACKUP_PAGE_SIZE < blobs.length ? String(start + BACKUP_PAGE_SIZE) : null });
      }
      if (kind === "scouts" && /^s_[a-f0-9]{64}$/.test(id || "")) {
        const record = await stores.scouts.get(`${auth.userId}/${id}`, { type: "json", consistency: "strong" });
        if (!record) return reply({ error: "Scout list not found." }, 404);
        const cursor = new URL(req.url).searchParams.get("cursor") || "0";
        if (!/^\d{1,10}$/.test(cursor)) throw new BackupError("Invalid backup cursor.");
        const start = Number(cursor), clean = exportScout(record);
        return reply({ record: { ...clean, items: clean.items.slice(start, start + BACKUP_PAGE_SIZE) }, totalItems: clean.items.length, nextCursor: start + BACKUP_PAGE_SIZE < clean.items.length ? String(start + BACKUP_PAGE_SIZE) : null });
      }
      if (kind === "covers" && /^[a-f0-9]{32}$/.test(id || "")) {
        const cover = await stores.covers.getWithMetadata(id, { type: "arrayBuffer", consistency: "strong" });
        if (!cover || cover.metadata?.userId !== auth.userId) return reply({ error: "Cover not found." }, 404);
        const bytes = Buffer.from(cover.data);
        return reply({ id, contentType: cover.metadata.contentType || "image/jpeg", data: bytes.toString("base64"), sha256: digest(bytes) });
      }
      return reply({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof BackupError) return reply({ error: error.message, retryable: error.status >= 500 }, error.status);
      console.error("Backup request failed:", { name: error?.name });
      return reply({ error: "The backup operation could not be completed. Retry without changing the backup file.", retryable: true }, 503);
    }
  };
}

export default createBackupHandler();
