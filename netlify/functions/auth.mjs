import {
  usersStore, sessionsStore, json, requireAuth, readBody, createSession, destroySession,
  requestSession, sessionCookie, sessionMarker, sameOriginMutation, newId, normalizeEmail, EMAIL_RE,
} from "../lib/util.mjs";
import {
  AccountError, displayName, validateNewPassword, hashPassword, verifyPassword,
  makeRecoveryCode, hashRecoveryCode, verifyRecoveryCode, publicUser, sessionVersion, updateUserRecord,
} from "../lib/account.mjs";

export const config = {
  path: "/api/auth/:action",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
const DUMMY_HASH = `scrypt-v2$${"0".repeat(32)}$${"0".repeat(128)}`;
const reply = (body, status = 200, headers = {}) => json(body, status, { "cache-control": "no-store", ...headers });

export function createAuthHandler({ getUsers = usersStore, getSessions = sessionsStore } = {}) {
  return async (req, context = {}) => {
    const action = context.params?.action || new URL(req.url).pathname.split("/").pop();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (mutation && !sameOriginMutation(req, { requireOrigin: requestSession(req)?.source === "cookie" })) {
        throw new AccountError("Open this action from your vault and try again.", 403, "ORIGIN_REJECTED");
      }
      if (mutation && !/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "")) {
        throw new AccountError("Send this request as JSON.", 415, "INVALID_CONTENT_TYPE");
      }
      const users = getUsers();
      const sessions = getSessions();
      const authenticate = async ({ optional = false } = {}) => {
        const auth = await requireAuth(req, { users, sessions });
        if (auth) return auth;
        const credential = requestSession(req);
        const expected = req.headers.get("x-vhs-session");
        if (credential && expected) {
          const actual = await sessions.get(credential.token, { type: "json", consistency: "strong" });
          if (actual && expected !== sessionMarker(credential.token, actual)) {
            throw new AccountError("The signed-in account changed in another tab. Reload before continuing.", 409, "SESSION_CHANGED");
          }
        }
        if (optional) return null;
        throw new AccountError("Not signed in.", 401, "AUTH_REQUIRED");
      };
      const establishSession = async (user, extra = {}, status = 200) => {
        const session = await createSession(user.id, sessionVersion(user), sessions);
        return reply({ user: publicUser(user), sessionId: session.sessionId, ...extra }, status, { "set-cookie": sessionCookie(req, session.token) });
      };

      if (req.method === "GET" && action === "me") {
        const auth = await authenticate();
        return reply({ user: publicUser(auth.user), sessionId: auth.sessionId }, 200,
          auth.authSource === "bearer" ? { "set-cookie": sessionCookie(req, auth.token) } : {});
      }
      if (req.method === "POST" && action === "logout") {
        const auth = await authenticate({ optional: true });
        if (auth) await destroySession(auth.token, sessions);
        return reply({ ok: true }, 200, { "set-cookie": sessionCookie(req, "", { clear: true }) });
      }
      if (!["POST", "PATCH"].includes(req.method)) throw new AccountError("Not found", 404);
      if (Number(req.headers.get("content-length")) > 16384) throw new AccountError("This account request is too large.", 413);
      const body = await readBody(req);

      if (req.method === "POST" && action === "signup") {
        const email = normalizeEmail(body.email);
        if (email.length > 254 || !EMAIL_RE.test(email)) throw new AccountError("Enter a valid email address.", 400, "INVALID_EMAIL");
        const password = validateNewPassword(body.password);
        const name = displayName(body.displayName);
        if (await users.get(`email/${email}`, { type: "json", consistency: "strong" })) {
          throw new AccountError("An account with that email already exists. Sign in or use your recovery code.", 409, "EMAIL_EXISTS");
        }
        const recoveryCode = makeRecoveryCode();
        const user = {
          id: newId(), email, displayName: name, passHash: hashPassword(password),
          recoveryHash: hashRecoveryCode(recoveryCode), recoveryCreatedAt: new Date().toISOString(),
          sessionVersion: 0, settings: {}, createdAt: new Date().toISOString(),
        };
        let userWriteError;
        try { await users.setJSON(user.id, user, { onlyIfNew: true }); } catch (error) { userWriteError = error; }
        const saved = await users.get(user.id, { type: "json", consistency: "strong" });
        if (saved?.passHash !== user.passHash) throw userWriteError || new AccountError("Your account could not be created. Try again.", 503);
        // Confirm the index owner instead of trusting the SDK's modified flag.
        let indexWriteError;
        try { await users.setJSON(`email/${email}`, { userId: user.id }, { onlyIfNew: true }); } catch (error) { indexWriteError = error; }
        const owner = await users.get(`email/${email}`, { type: "json", consistency: "strong" });
        if (owner?.userId !== user.id) {
          if (owner?.userId) {
            await users.delete(user.id);
            throw new AccountError("An account with that email already exists. Sign in or use your recovery code.", 409, "EMAIL_EXISTS");
          }
          throw indexWriteError || new AccountError("Your account could not be confirmed. Try signing in, or try again.", 503);
        }
        return establishSession(user, { recoveryCode }, 201);
      }

      if (req.method === "POST" && action === "login") {
        const email = normalizeEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        const index = email.length <= 254 && EMAIL_RE.test(email) ? await users.get(`email/${email}`, { type: "json", consistency: "strong" }) : null;
        const user = index ? await users.get(index.userId, { type: "json", consistency: "strong" }) : null;
        const valid = verifyPassword(password, user?.passHash || DUMMY_HASH);
        if (!user || !valid) throw new AccountError("Incorrect email or password.", 401, "INVALID_CREDENTIALS");
        return establishSession(user);
      }

      if (req.method === "POST" && action === "reset") {
        const password = validateNewPassword(body.newPassword);
        const email = normalizeEmail(body.email);
        const index = email.length <= 254 && EMAIL_RE.test(email) ? await users.get(`email/${email}`, { type: "json", consistency: "strong" }) : null;
        if (!index) throw new AccountError("The email or recovery code is incorrect.", 403, "INVALID_RECOVERY_CODE");
        const recoveryCode = makeRecoveryCode();
        const newHash = hashPassword(password);
        const user = await updateUserRecord({ store: users, userId: index.userId, change(current) {
          if (!verifyRecoveryCode(body.recoveryCode, current.recoveryHash)) throw new AccountError("The email or recovery code is incorrect.", 403, "INVALID_RECOVERY_CODE");
          return { ...current, passHash: newHash, recoveryHash: hashRecoveryCode(recoveryCode), recoveryCreatedAt: new Date().toISOString(), sessionVersion: sessionVersion(current) + 1, passwordChangedAt: new Date().toISOString() };
        } });
        return establishSession(user, { recoveryCode });
      }

      const auth = await authenticate();
      const assertCurrentPassword = (current) => {
        if (sessionVersion(current) !== sessionVersion(auth.user)) throw new AccountError("Your session has changed. Sign in again.", 401, "AUTH_REQUIRED");
        if (!verifyPassword(body.currentPassword, current.passHash)) throw new AccountError("Your current password is incorrect.", 403, "CURRENT_PASSWORD_INCORRECT");
      };
      if (req.method === "PATCH" && action === "profile") {
        const name = displayName(body.displayName);
        const user = await updateUserRecord({ store: users, userId: auth.userId, change(current) {
          if (sessionVersion(current) !== sessionVersion(auth.user)) throw new AccountError("Sign in again before editing your profile.", 401, "AUTH_REQUIRED");
          return { ...current, displayName: name };
        } });
        return reply({ user: publicUser(user) });
      }
      if (req.method === "POST" && action === "password") {
        const newHash = hashPassword(validateNewPassword(body.newPassword));
        const user = await updateUserRecord({ store: users, userId: auth.userId, change(current) {
          assertCurrentPassword(current);
          return { ...current, passHash: newHash, sessionVersion: sessionVersion(current) + 1, passwordChangedAt: new Date().toISOString() };
        } });
        return establishSession(user);
      }
      if (req.method === "POST" && action === "recovery") {
        const recoveryCode = makeRecoveryCode();
        const user = await updateUserRecord({ store: users, userId: auth.userId, change(current) {
          assertCurrentPassword(current);
          return { ...current, recoveryHash: hashRecoveryCode(recoveryCode), recoveryCreatedAt: new Date().toISOString() };
        } });
        return reply({ user: publicUser(user), recoveryCode });
      }
      if (req.method === "POST" && action === "logout-all") {
        await updateUserRecord({ store: users, userId: auth.userId, change(current) {
          assertCurrentPassword(current);
          return { ...current, sessionVersion: sessionVersion(current) + 1 };
        } });
        return reply({ ok: true }, 200, { "set-cookie": sessionCookie(req, "", { clear: true }) });
      }
      throw new AccountError("Not found", 404);
    } catch (error) {
      if (error instanceof AccountError) return reply({ error: error.message, code: error.code }, error.status);
      console.error("Account request failed", { name: error?.name });
      return reply({ error: "Your account request could not be completed. Try again.", code: "ACCOUNT_UNAVAILABLE" }, 503);
    }
  };
}

export default createAuthHandler();
