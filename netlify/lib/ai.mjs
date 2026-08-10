import Anthropic from "@anthropic-ai/sdk";

// Netlify AI Gateway injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL into the
// function environment, so a zero-config client routes through the gateway.
let _client;
export function anthropic() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export const MODEL = process.env.VHS_AI_MODEL || "claude-opus-5";

/**
 * Runs a structured-output request and returns the parsed JSON object.
 * Throws with a friendly message on refusal or truncation.
 */
export async function structured({ system, content, schema, maxTokens = 8000, effort = "low", timeoutMs = 50000 }) {
  let response;
  try {
    response = await anthropic().messages.create(
      {
        model: MODEL,
        max_tokens: maxTokens,
        system,
        output_config: {
          effort,
          format: { type: "json_schema", schema },
        },
        messages: [{ role: "user", content }],
      },
      // No SDK retries: a timed-out vision call would retry for another full
      // timeout window and blow past the function's own limit. Fail fast with
      // a friendly message and let the user tap retry instead.
      { timeout: timeoutMs, maxRetries: 0 }
    );
  } catch (err) {
    if (err?.name === "APIConnectionTimeoutError") {
      throw new FriendlyError("The AI is taking too long right now. Please try again in a moment.");
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new FriendlyError("The AI declined to process this request. Try a different photo.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new FriendlyError("The AI response was too long. Try a photo with fewer tapes.");
  }

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new FriendlyError("The AI returned an empty response. Please try again.");
  return JSON.parse(text);
}

export class FriendlyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.friendly = true;
    this.status = status;
  }
}

export function aiErrorResponse(err) {
  console.error("AI error:", err);
  if (err?.friendly) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { "content-type": "application/json" },
    });
  }
  const status = err?.status === 429 ? 429 : 502;
  const message =
    err?.status === 429
      ? "The AI service is rate limited right now. Wait a moment and try again."
      : err?.status === 401 || err?.status === 403
        ? "AI Gateway isn't available. Make sure the site is deployed to Netlify with AI features enabled."
        : "The AI request failed. Please try again.";
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
