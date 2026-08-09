import { usersStore, json, errorResponse, requireAuth, readBody, getOmdbKey } from "../lib/util.mjs";

export const config = { path: "/api/settings" };

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);

  if (req.method === "GET") {
    return json({ settings: publicSettings(auth.user.settings, auth) });
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    const body = await readBody(req);
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
    return json({ settings: publicSettings(settings, { user: updated }) });
  }

  return errorResponse("Not found", 404);
};

function publicSettings(settings = {}, auth = null) {
  return {
    hasOmdbKey: Boolean(settings.omdbKey),
    // True when OMDb lookups will run — via the user's key or a site-wide env var.
    omdbActive: Boolean(getOmdbKey(auth)),
  };
}
