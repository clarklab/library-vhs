import { usersStore, sessionsStore, json, requireAuth, readBody, getOmdbKey } from "../lib/util.mjs";
import { AccountError, sessionVersion, updateUserRecord } from "../lib/account.mjs";

export const config = { path: "/api/settings" };

export function createSettingsHandler({ getUsers = usersStore, getSessions = sessionsStore } = {}) {
  return async (req) => {
    try {
      const users = getUsers();
      const auth = await requireAuth(req, { users, sessions: getSessions() });
      if (!auth) return json({ error: "Not signed in.", code: "AUTH_REQUIRED" }, 401);
      if (req.method === "GET") return json({ settings: publicSettings(auth.user.settings, auth) }, 200, { "cache-control": "no-store" });
      if (req.method !== "PUT" && req.method !== "PATCH") return json({ error: "Not found" }, 404);
      const body = await readBody(req);
      const patch = {};
      if ("omdbKey" in body) {
        if (typeof body.omdbKey !== "string" || body.omdbKey.trim().length > 64 || (body.omdbKey.trim() && !/^[a-zA-Z0-9]+$/.test(body.omdbKey.trim()))) {
          throw new AccountError("That doesn't look like a valid OMDb API key.");
        }
        patch.omdbKey = body.omdbKey.trim();
      }
      const user = await updateUserRecord({ store: users, userId: auth.userId, change(current) {
        if (sessionVersion(current) !== sessionVersion(auth.user)) throw new AccountError("Sign in again before changing settings.", 401, "AUTH_REQUIRED");
        return { ...current, settings: { ...(current.settings || {}), ...patch } };
      } });
      return json({ settings: publicSettings(user.settings, { user }) }, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof AccountError) return json({ error: error.message, code: error.code }, error.status);
      console.error("Settings update failed", { name: error?.name });
      return json({ error: "Settings could not be saved. Try again.", code: "SETTINGS_UNAVAILABLE" }, 503);
    }
  };
}

function publicSettings(settings = {}, auth = null) {
  return { hasOmdbKey: Boolean(settings.omdbKey), omdbActive: Boolean(getOmdbKey(auth)) };
}

export default createSettingsHandler();
