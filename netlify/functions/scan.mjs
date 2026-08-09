import { json, errorResponse, requireAuth } from "../lib/util.mjs";
import { structured, aiErrorResponse, FriendlyError } from "../lib/ai.mjs";

export const config = { path: "/api/scan" };

const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // decoded size guard

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    count: {
      type: "integer",
      description: "Total number of distinct VHS tapes visible in the photo.",
    },
    tapes: {
      type: "array",
      description: "One entry per distinct tape, in reading order (left-to-right, top-to-bottom).",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The movie title exactly as identified." },
          year: {
            type: ["integer", "null"],
            description: "Release year of the film if known, else null.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "high = title clearly readable or cover unmistakable; medium = partially readable or inferred from artwork; low = a guess.",
          },
          visual: {
            type: "string",
            description:
              "Very short note on what identified it, e.g. 'red spine, big-box', 'front cover with shark artwork'.",
          },
          edition: {
            type: "string",
            description:
              "Notable edition/release details visible on the tape (e.g. 'McTiernan cut', 'Spanish release', 'ex-rental big box'), else empty string.",
          },
        },
        required: ["title", "year", "confidence", "visual", "edition"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "string",
      description:
        "Anything the user should double-check: unreadable spines, partially hidden tapes, non-VHS items. Empty string if nothing.",
    },
  },
  required: ["count", "tapes", "notes"],
  additionalProperties: false,
};

const SYSTEM = `You identify VHS tapes in photos for a collector's inventory app.
The photo may show a single tape, a stack, a shelf of spines, or a table of tapes at a swap meet.

Work in two passes:
1. COUNT: carefully count every distinct VHS tape visible (front covers, back covers, and spines all count; the same tape shown twice counts once if clearly the same physical item).
2. IDENTIFY: for each tape, read the title from the cover or spine. Use the artwork, logos, studio marks, and typography to identify tapes whose text is small or partially obscured. If you genuinely cannot identify a tape, still include it with your best guess and confidence "low" (use title "Unknown" only as a last resort).

Rules:
- "count" must equal the number of entries in "tapes".
- Report titles in their common English release name when obvious, otherwise exactly as printed.
- Do not invent tapes that are not visible. Do not include DVDs, CDs, books, or other non-VHS items in "tapes" — mention them in "notes" instead.`;

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);
  if (req.method !== "POST") return errorResponse("Not found", 404);

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid request body.");
  }

  const parsed = parseDataUrl(body.image);
  if (!parsed) return errorResponse("Send a JPEG, PNG, or WebP image as a data URL.");
  if (parsed.bytes > MAX_IMAGE_BYTES) {
    return errorResponse("That photo is too large. Please try again — the app should resize it automatically.");
  }

  try {
    const result = await structured({
      system: SYSTEM,
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
        },
        {
          type: "text",
          text: "Count and identify every VHS tape in this photo.",
        },
      ],
      schema: SCAN_SCHEMA,
      maxTokens: 8000,
      effort: "low",
    });

    const tapes = Array.isArray(result.tapes) ? result.tapes.slice(0, 60) : [];
    return json({
      count: tapes.length,
      reportedCount: result.count,
      tapes: tapes.map((t) => ({
        title: String(t.title || "").slice(0, 300),
        year: Number.isFinite(t.year) ? t.year : null,
        confidence: ["high", "medium", "low"].includes(t.confidence) ? t.confidence : "low",
        visual: String(t.visual || "").slice(0, 200),
        edition: String(t.edition || "").slice(0, 200),
      })),
      notes: String(result.notes || "").slice(0, 600),
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return aiErrorResponse(new FriendlyError("The AI returned an unreadable response. Please try again."));
    }
    return aiErrorResponse(err);
  }
};

function parseDataUrl(input) {
  if (typeof input !== "string") return null;
  const match = input.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  if (!ALLOWED_MEDIA.includes(mediaType)) return null;
  const data = match[2].replace(/\s/g, "");
  return { mediaType, data, bytes: Math.floor(data.length * 0.75) };
}
