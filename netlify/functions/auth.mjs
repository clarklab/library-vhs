import {
  usersStore,
  json,
  errorResponse,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  newId,
  normalizeEmail,
  EMAIL_RE,
  readBody,
} from "../lib/util.mjs";

export const config = { path: "/api/auth/:action" };

export default async (req, context) => {
  const action = context.params.action;

  try {
    if (req.method === "POST" && action === "signup") return await signup(req);
    if (req.method === "POST" && action === "login") return await login(req);
    if (req.method === "POST" && action === "logout") return await logout(req);
    if (req.method === "GET" && action === "me") return await me(req);
    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("auth error:", err);
    return errorResponse("Something went wrong. Please try again.", 500);
  }
};

async function signup(req) {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!EMAIL_RE.test(email)) return errorResponse("Enter a valid email address.");
  if (password.length < 8) return errorResponse("Password must be at least 8 characters.");

  const users = usersStore();
  const userId = newId();
  const user = {
    id: userId,
    email,
    passHash: hashPassword(password),
    settings: {},
    createdAt: new Date().toISOString(),
  };
  await users.setJSON(userId, user);
  // Conditional write closes the duplicate-signup race: only one concurrent
  // request can claim the email index entry.
  const claim = await users.setJSON(`email/${email}`, { userId }, { onlyIfNew: true });
  if (claim?.modified === false) {
    await users.delete(userId);
    return errorResponse("An account with that email already exists.", 409);
  }

  const token = await createSession(userId);
  return json({ token, user: publicUser(user) }, 201);
}

async function login(req) {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  const users = usersStore();
  const index = await users.get(`email/${email}`, { type: "json" });
  const user = index ? await users.get(index.userId, { type: "json" }) : null;

  if (!user || !verifyPassword(password, user.passHash)) {
    return errorResponse("Incorrect email or password.", 401);
  }

  const token = await createSession(user.id);
  return json({ token, user: publicUser(user) });
}

async function logout(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  await destroySession(token);
  return json({ ok: true });
}

async function me(req) {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);
  return json({ user: publicUser(auth.user) });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    settings: { hasOmdbKey: Boolean(user.settings?.omdbKey) },
    createdAt: user.createdAt,
  };
}
