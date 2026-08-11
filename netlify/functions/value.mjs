import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { structured, aiErrorResponse, FriendlyError } from "../lib/ai.mjs";

export const config = { path: "/api/value" };

const VALUE_SCHEMA = {
  type: "object",
  properties: {
    known: {
      type: "boolean",
      description: "true if you recognize this film's VHS releases well enough to estimate a market value.",
    },
    low: { type: ["number", "null"], description: "Low end of a realistic sale price range in USD." },
    high: { type: ["number", "null"], description: "High end of a realistic sale price range in USD." },
    typical: { type: ["number", "null"], description: "The most likely swap-meet / online sale price in USD." },
    demand: {
      type: "string",
      enum: ["hot", "steady", "slow"],
      description: "Collector demand: hot = actively sought, steady = sells eventually, slow = common shelf stock.",
    },
    factors: {
      type: "array",
      items: { type: "string" },
      description: "Up to 4 short bullets on what drives this tape's value (edition, sealed premium, cult status, common print, etc.).",
    },
    summary: {
      type: "string",
      description: "One or two sentences a seller could read aloud about this tape's market.",
    },
  },
  required: ["known", "low", "high", "typical", "demand", "factors", "summary"],
  additionalProperties: false,
};

const SYSTEM = `You estimate resale values of VHS tapes for a collector's inventory app.
Ground your estimates in the real collector market: most mass-market VHS tapes sell for $2-10, popular titles in nice condition $10-25, sealed tapes carry a large premium (often 3-20x), and genuinely rare tapes (horror, cult, first prints, big-box, Disney Black Diamond variants people actually chase) can run far higher.
Be honest and conservative: when a tape is common shelf stock, say so. Factor in the specific edition, packaging, sealed status, and condition provided. If you don't recognize the title well enough, set known=false and null prices.
These are ESTIMATES from market knowledge, not live price data — never imply otherwise in the summary.`;

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);
  if (req.method !== "POST") return errorResponse("Not found", 404);

  const body = await readBody(req);
  const title = String(body.title || "").slice(0, 300).trim();
  if (!title) return errorResponse("Missing title.");

  const detail = {
    title,
    year: Number.isFinite(Number(body.year)) ? Number(body.year) : null,
    edition: String(body.edition || "").slice(0, 200),
    packaging: String(body.packaging || "").slice(0, 40),
    sealed: body.sealed === true,
    condition: String(body.condition || "").slice(0, 20),
  };

  try {
    const result = await structured({
      system: SYSTEM,
      content: [
        {
          type: "text",
          text: `Estimate the current resale value of this VHS tape:\n${JSON.stringify(detail, null, 2)}`,
        },
      ],
      schema: VALUE_SCHEMA,
      maxTokens: 1500,
      effort: "low",
      timeoutMs: 25000,
    });

    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
    return json({
      known: result.known === true,
      low: num(result.low),
      high: num(result.high),
      typical: num(result.typical),
      demand: ["hot", "steady", "slow"].includes(result.demand) ? result.demand : "steady",
      factors: (Array.isArray(result.factors) ? result.factors : []).slice(0, 4).map((f) => String(f).slice(0, 200)),
      summary: String(result.summary || "").slice(0, 500),
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return aiErrorResponse(new FriendlyError("The AI returned an unreadable response. Please try again."));
    }
    return aiErrorResponse(err);
  }
};
