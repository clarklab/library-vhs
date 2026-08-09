import { usersStore, json, errorResponse, requireAuth } from "../lib/util.mjs";

export const config = { path: "/api/settings" };

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);

  if (req.method === "GET") {
    return json({ settings: publicSettings(auth.user.settings) });
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    const settings = { ...(auth.user.settings || {}) };

    if ("omdbKey" in body) {
      const key = String(body.omdbKey || "").trim().slice(0, 64);
      if (key && !/^[a-zA-Z0-9]+$/.test(key)) {
        return errorResponse("That doesn't look like a valid OMDb API key.");
      }
      settings.omdbKey = key;
    }

    const updated = { ...auth.user, settings };
    await usersStore().setJSON(auth.userId, updated);
    return json({ settings: publicSettings(settings) });
  }

  return errorResponse("Not found", 404);
};

function publicSettings(settings = {}) {
  return { hasOmdbKey: Boolean(settings.omdbKey) };
}
