import { coversStore, tapesStore, json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { randomBytes } from "node:crypto";

export const config = { path: ["/api/cover", "/api/cover/:coverId"] };

const ALLOWED_MEDIA = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // client resizes well below this
const PRIVATE_IMAGE_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const imageError = (message, status) => json({ error: message }, status, PRIVATE_IMAGE_HEADERS);

export function createCoverHandler({ authenticate = requireAuth, getCovers = coversStore, getTapes = tapesStore } = {}) {
  return async (req, context = {}) => {
    const coverId = context.params?.coverId;

    // Native <img> requests include the HttpOnly session cookie. The cover ID
    // identifies an image; ownership and a current session authorize access.
    if (req.method === "GET" && coverId) {
      const auth = await authenticate(req);
      if (!auth) return imageError("Not signed in.", 401);
      if (!/^[a-f0-9]{32}$/.test(coverId)) return imageError("Not found", 404);
      const blob = await getCovers().getWithMetadata(coverId, { type: "arrayBuffer", consistency: "strong" });
      if (!blob || blob.metadata?.userId !== auth.userId) return imageError("Not found", 404);
      const contentType = blob.metadata?.contentType || "image/jpeg";
      if (!ALLOWED_MEDIA[contentType]) return imageError("Not found", 404);
      return new Response(blob.data, {
        headers: {
          "content-type": contentType,
          ...PRIVATE_IMAGE_HEADERS,
        },
      });
    }

    if (req.method !== "POST") return errorResponse("Not found", 404);

    const auth = await authenticate(req);
    if (!auth) return errorResponse("Not signed in.", 401);

    const body = await readBody(req);
    const tapeId = String(body.tapeId || "");
    const parsed = parseDataUrl(body.image);
    if (!tapeId) return errorResponse("Missing tapeId.");
    if (!parsed) return errorResponse("Send a JPEG, PNG, or WebP image as a data URL.");
    if (parsed.buffer.byteLength > MAX_IMAGE_BYTES) {
      return errorResponse("That image is too large. Please try again — the app should resize it automatically.");
    }

    const tapes = getTapes();
    const tapeKey = `${auth.userId}/${tapeId}`;
    const tape = await tapes.get(tapeKey, { type: "json" });
    if (!tape) return errorResponse("Tape not found.", 404);

    const covers = getCovers();
    const newCoverId = randomBytes(16).toString("hex");
    await covers.set(newCoverId, parsed.buffer, {
      metadata: { contentType: parsed.mediaType, userId: auth.userId, tapeId },
    });

    // Swap the tape's poster to the uploaded cover, then clean up the old
    // upload (never anything we don't own the URL shape of).
    const oldCover = String(tape.posterUrl || "").match(/^\/api\/cover\/([a-f0-9]{32})$/);
    tape.posterUrl = `/api/cover/${newCoverId}`;
    tape.updatedAt = new Date().toISOString();
    await tapes.setJSON(tapeKey, tape);
    if (oldCover) {
      // A saved poster URL alone is not proof that this account owns the image.
      const old = await covers.getMetadata(oldCover[1], { consistency: "strong" }).catch(() => null);
      if (old?.metadata?.userId === auth.userId) await covers.delete(oldCover[1]).catch(() => {});
    }

    return json({ tape });
  };
}

export default createCoverHandler();

function parseDataUrl(input) {
  if (typeof input !== "string") return null;
  const match = input.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  if (!ALLOWED_MEDIA[mediaType]) return null;
  try {
    return { mediaType, buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
  } catch {
    return null;
  }
}
