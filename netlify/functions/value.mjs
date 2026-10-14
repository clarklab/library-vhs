import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { structured, aiErrorResponse, MODEL } from "../lib/ai.mjs";
import { MEDIA_FORMATS, VALUE_SCHEMA, VALUE_SYSTEM, normalizeValue } from "../lib/value-contract.mjs";
import { liveMarketValue } from "../lib/market.mjs";

export const config = { path: "/api/value" };

export function createValueHandler({ authenticate = requireAuth, runStructured = structured, runMarket = liveMarketValue } = {}) {
  return async (req) => {
    if (req.method !== "POST") return errorResponse("Not found", 404);
    try {
      const auth = await authenticate(req);
      if (!auth) return errorResponse("Not signed in.", 401);
      const body = await readBody(req);
      const str = (value, length) => typeof value === "string" ? value.trim().slice(0, length) : "";
      const title = str(body.title, 300);
      if (!title) return errorResponse("Missing title.");
      const format = MEDIA_FORMATS.includes(body.format) ? body.format : body.format === undefined ? "VHS" : "Other";
      const detail = {
        title, format,
        year: body.year != null && body.year !== "" && Number.isInteger(Number(body.year)) ? Number(body.year) : null,
        edition: str(body.edition, 200), artist: str(body.artist, 200),
        packaging: str(body.packaging, 40), barcode: str(body.barcode, 40),
        sealed: body.sealed === true ? true : body.sealed === false ? false : null,
        condition: str(body.condition, 20) || "unknown",
      };
      if (body.mode !== "ai") {
        return json({ ...await runMarket(detail, { signal: req.signal }), format }, 200, { "cache-control": "no-store" });
      }
      const result = await runStructured({
        system: VALUE_SYSTEM,
        content: [{ type: "text", text: `Provide an uncertain AI resale estimate for this physical media item:\n${JSON.stringify(detail)}` }],
        schema: VALUE_SCHEMA, maxTokens: 1800, effort: "low", timeoutMs: 25000, signal: req.signal,
      });
      // Unknown media or a clearly unidentified title must never acquire a price.
      const uncertain = format === "Other" || /^(unknown|unreadable|unidentified)(\b|$)/i.test(title);
      return json({ ...normalizeValue(uncertain ? { ...result, known: false } : result), format, model: MODEL, estimatedAt: new Date().toISOString() }, 200, { "cache-control": "no-store" });
    } catch (err) {
      return aiErrorResponse(err);
    }
  };
}

export default createValueHandler();
