import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { lookupUpc, normalizeGtin } from "../lib/upc.mjs";

export const config = { path: "/api/upc" };

export function createUpcHandler({ authenticate = requireAuth, lookup = lookupUpc } = {}) {
  return async (req) => {
    if (req.method !== "POST") return errorResponse("Not found", 404);
    const auth = await authenticate(req);
    if (!auth) return errorResponse("Not signed in.", 401);
    const body = await readBody(req);
    const gtin = normalizeGtin(body.code, typeof body.format === "string" ? body.format : "");
    if (!gtin) return errorResponse("That doesn’t look like a complete UPC. Check the numbers under the barcode.");
    try {
      return json(await lookup(gtin, { signal: req.signal }), 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error?.name === "AbortError") return errorResponse("Lookup stopped.", 499);
      return errorResponse("Barcode lookup is unavailable right now. Try typing the title instead.", 502);
    }
  };
}

export default createUpcHandler();
