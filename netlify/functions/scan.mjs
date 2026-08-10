import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { structured, aiErrorResponse, FriendlyError } from "../lib/ai.mjs";

export const config = { path: "/api/scan" };

const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// Keep well under Netlify's ~6MB function payload cap (base64 adds ~33%).
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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

Expect real-world photos: tapes are often laid SIDEWAYS or upside down (read rotated text carefully — titles may run vertically), lighting is dim with glare or shadows, and covers are VHS box designs that can differ from the movie's theatrical poster art (different layout, vertical titles, studio banners, rental stickers, price tags).

Work in two passes:
1. COUNT: sweep the photo systematically (left to right, top to bottom) and count every distinct VHS tape visible (front covers, back covers, and spines all count; the same tape shown twice counts once if clearly the same physical item).
2. IDENTIFY: go back over the photo in the same order and read each tape's title from its cover or spine. Rotate mentally when the box is sideways. Use the artwork, logos, studio marks, actor names, and typography to identify tapes whose text is small, blurry, or partially obscured. If you genuinely cannot identify a tape, still include it with your best guess and confidence "low" (use title "Unknown" only as a last resort).

Rules:
- "tapes" MUST contain exactly one entry per physical tape you counted — never stop early, never skip a tape because it is hard to read, and never pad with extra entries. "count" must equal the number of entries in "tapes".
- Report titles in their common English release name when obvious, otherwise exactly as printed.
- Do not invent tapes that are not visible. Do not include DVDs, CDs, books, or other non-VHS items in "tapes" — mention them in "notes" instead.`;

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);
  if (req.method !== "POST") return errorResponse("Not found", 404);

  const body = await readBody(req);
  const parsed = parseDataUrl(body.image);
  if (!parsed) return errorResponse("Send a JPEG, PNG, or WebP image as a data URL.");
  if (parsed.bytes > MAX_IMAGE_BYTES) {
    return errorResponse("That photo is too large. Please try again — the app should resize it automatically.");
  }

  const imageBlock = {
    type: "image",
    source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
  };

  try {
    const started = Date.now();
    const result = await structured({
      system: SYSTEM,
      content: [
        imageBlock,
        {
          type: "text",
          text: "Count and identify every VHS tape in this photo.",
        },
      ],
      schema: SCAN_SCHEMA,
      maxTokens: 8000,
      effort: "medium",
    });

    let tapes = cleanTapes(result.tapes);
    let notes = String(result.notes || "").slice(0, 600);
    const reported = Number.isFinite(result.count) ? result.count : tapes.length;

    // Reconciliation pass: the model sometimes counts correctly but stops
    // identifying early. If it saw more tapes than it named, go back for the
    // rest (skipped when the first pass already ate most of our time budget).
    if (reported > tapes.length && tapes.length > 0 && tapes.length < 60 && Date.now() - started < 30000) {
      try {
        const followUp = await structured({
          system: SYSTEM,
          content: [
            imageBlock,
            {
              type: "text",
              text: `You previously counted ${reported} tapes in this photo but only identified these ${tapes.length}:\n${tapes.map((t) => `- ${t.title}`).join("\n")}\n\nIdentify ONLY the remaining ${reported - tapes.length} tape(s) you have not listed yet. Do not repeat the tapes above.`,
            },
          ],
          schema: SCAN_SCHEMA,
          maxTokens: 4000,
          effort: "low",
          timeoutMs: 20000,
        });
        const seen = new Set(tapes.map((t) => t.title.toLowerCase().trim()));
        for (const t of cleanTapes(followUp.tapes)) {
          if (!seen.has(t.title.toLowerCase().trim()) && tapes.length < 60) tapes.push(t);
        }
      } catch {
        /* first-pass results still stand */
      }
    }

    return json({
      count: tapes.length,
      reportedCount: reported,
      tapes,
      notes,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return aiErrorResponse(new FriendlyError("The AI returned an unreadable response. Please try again."));
    }
    return aiErrorResponse(err);
  }
};

function cleanTapes(raw) {
  const tapes = Array.isArray(raw) ? raw.slice(0, 60) : [];
  return tapes.map((t) => ({
    title: String(t.title || "").slice(0, 300),
    year: Number.isFinite(t.year) ? t.year : null,
    confidence: ["high", "medium", "low"].includes(t.confidence) ? t.confidence : "low",
    visual: String(t.visual || "").slice(0, 200),
    edition: String(t.edition || "").slice(0, 200),
  }));
}

function parseDataUrl(input) {
  if (typeof input !== "string") return null;
  const match = input.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  if (!ALLOWED_MEDIA.includes(mediaType)) return null;
  const data = match[2].replace(/\s/g, "");
  return { mediaType, data, bytes: Math.floor(data.length * 0.75) };
}
