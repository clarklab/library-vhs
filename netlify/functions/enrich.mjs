import { json, errorResponse, requireAuth } from "../lib/util.mjs";
import { structured, aiErrorResponse } from "../lib/ai.mjs";

export const config = { path: "/api/enrich" };

const MAX_ITEMS = 25;

const ENRICH_SCHEMA = {
  type: "object",
  properties: {
    movies: {
      type: "array",
      description: "One entry per requested title, in the same order as the request.",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index of the requested title this entry answers." },
          known: {
            type: "boolean",
            description:
              "true only if you are confident you know this specific film. If false, leave the other fields empty/null rather than guessing.",
          },
          title: { type: "string", description: "Canonical release title." },
          year: { type: ["integer", "null"] },
          director: { type: "string" },
          actors: {
            type: "array",
            items: { type: "string" },
            description: "Up to 4 top-billed actors.",
          },
          genre: { type: "string", description: "1-3 comma-separated genres, e.g. 'Horror, Thriller'." },
          runtime: { type: "string", description: "e.g. '96 min', or empty if unsure." },
          rated: { type: "string", description: "MPAA rating like PG, R, or empty if unsure." },
          plot: { type: "string", description: "One or two sentence plot summary." },
        },
        required: ["index", "known", "title", "year", "director", "actors", "genre", "runtime", "rated", "plot"],
        additionalProperties: false,
      },
    },
  },
  required: ["movies"],
  additionalProperties: false,
};

const SYSTEM = `You are a film reference librarian filling in metadata for a VHS collector's inventory.
For each requested title, provide accurate facts about the film. Many will be mainstream releases; some will be obscure direct-to-video titles.
Accuracy matters more than completeness: if you are not confident about a specific film, set known=false and leave fields empty instead of guessing. Never invent directors, actors, or years.
If a year is given with the title, use it to pick the right film among remakes/sequels.`;

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);
  if (req.method !== "POST") return errorResponse("Not found", 404);

  const body = await req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const cleaned = items
    .map((item) => ({
      title: String(item?.title || "").trim().slice(0, 300),
      year: Number.isFinite(Number(item?.year)) ? Number(item.year) : null,
    }))
    .filter((item) => item.title);

  if (cleaned.length === 0) return errorResponse("Send at least one title to enrich.");

  const omdbKey = auth.user.settings?.omdbKey || process.env.OMDB_API_KEY || "";
  const results = cleaned.map((item) => ({
    query: item,
    title: item.title,
    year: item.year,
    director: "",
    actors: [],
    genre: "",
    runtime: "",
    rated: "",
    plot: "",
    imdbRating: "",
    imdbId: "",
    posterUrl: "",
    matched: false,
    sources: [],
  }));

  // Pass 1: OMDb (verified data + posters) when a key is available.
  if (omdbKey) {
    await Promise.all(
      results.map(async (result) => {
        try {
          const hit = await omdbLookup(omdbKey, result.query.title, result.query.year);
          if (hit) {
            applyOmdb(result, hit);
            result.matched = true;
            result.sources.push("omdb");
          }
        } catch (err) {
          console.error("omdb lookup failed:", err?.message);
        }
      })
    );
  }

  // Pass 2: AI fills anything OMDb didn't cover.
  const missing = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.matched);

  if (missing.length > 0) {
    try {
      const listing = missing
        .map(({ result }, i) => `${i}. ${result.query.title}${result.query.year ? ` (${result.query.year})` : ""}`)
        .join("\n");
      const ai = await structured({
        system: SYSTEM,
        content: [{ type: "text", text: `Provide metadata for these films:\n${listing}` }],
        schema: ENRICH_SCHEMA,
        maxTokens: 8000,
        effort: "low",
      });
      for (const movie of ai.movies || []) {
        const target = missing[movie.index]?.result;
        if (!target || !movie.known) continue;
        target.title = String(movie.title || target.title).slice(0, 300);
        target.year = Number.isFinite(movie.year) ? movie.year : target.year;
        target.director = String(movie.director || "").slice(0, 300);
        target.actors = (movie.actors || []).map((a) => String(a).slice(0, 120)).slice(0, 4);
        target.genre = String(movie.genre || "").slice(0, 120);
        target.runtime = String(movie.runtime || "").slice(0, 40);
        target.rated = String(movie.rated || "").slice(0, 20);
        target.plot = String(movie.plot || "").slice(0, 1200);
        target.matched = true;
        target.sources.push("ai");
      }
    } catch (err) {
      // If OMDb already matched some titles, return partial results instead of failing.
      if (results.every((r) => !r.matched)) return aiErrorResponse(err);
      console.error("AI enrichment failed, returning partial results:", err?.message);
    }
  }

  return json({ results });
};

// ---------- OMDb ----------

async function omdbLookup(key, title, year) {
  const exact = await omdbFetch(key, {
    t: title,
    ...(year ? { y: String(year) } : {}),
    type: "movie",
    plot: "short",
  });
  if (exact) return exact;

  // Fall back to search (handles slightly-off titles), then fetch the best hit.
  const search = await omdbFetchRaw(key, { s: title, type: "movie" });
  const first = search?.Search?.[0];
  if (!first?.imdbID) return null;
  return omdbFetch(key, { i: first.imdbID, plot: "short" });
}

async function omdbFetchRaw(key, params) {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.Response === "True" ? data : null;
}

async function omdbFetch(key, params) {
  const data = await omdbFetchRaw(key, params);
  return data && data.Title ? data : null;
}

function applyOmdb(result, hit) {
  const clean = (v) => (v && v !== "N/A" ? String(v) : "");
  result.title = clean(hit.Title) || result.title;
  const year = parseInt(clean(hit.Year), 10);
  if (Number.isFinite(year)) result.year = year;
  result.director = clean(hit.Director).slice(0, 300);
  result.actors = clean(hit.Actors)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 4);
  result.genre = clean(hit.Genre).slice(0, 120);
  result.runtime = clean(hit.Runtime).slice(0, 40);
  result.rated = clean(hit.Rated).slice(0, 20);
  result.plot = clean(hit.Plot).slice(0, 1200);
  result.imdbRating = clean(hit.imdbRating).slice(0, 10);
  result.imdbId = clean(hit.imdbID).slice(0, 20);
  const poster = clean(hit.Poster);
  result.posterUrl = /^https:\/\//.test(poster) ? poster.slice(0, 600) : "";
}
