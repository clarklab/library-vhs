import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const PASSWORD_BYTES_MAX = 4096;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export class AccountError extends Error {
  constructor(message, status = 400, code = "ACCOUNT_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateNewPassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new AccountError(`Use a password between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`, 400, "INVALID_PASSWORD");
  }
  return password;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString("hex");
  return `scrypt-v2$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 1024 || Buffer.byteLength(password) > PASSWORD_BYTES_MAX || typeof stored !== "string") return false;
  let salt, hash, options;
  if (stored.startsWith("scrypt-v2$")) {
    [, salt, hash] = stored.split("$");
    options = SCRYPT_OPTIONS;
  } else {
    [salt, hash] = stored.split(":");
  }
  if (!/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(hash || "")) return false;
  const candidate = scryptSync(password, salt, 64, options);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

export function makeRecoveryCode() {
  const data = randomBytes(20).toString("hex").toUpperCase();
  return `VHS-${data.match(/.{1,5}/g).join("-")}`;
}

function normalizeRecoveryCode(code) {
  if (typeof code !== "string" || code.length > 100) return null;
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^VHS[A-F0-9]{40}$/.test(normalized) ? normalized : null;
}

export function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new AccountError("Enter your full recovery code.", 400, "INVALID_RECOVERY_CODE");
  return createHash("sha256").update(`vhs-recovery-v1:${normalized}`).digest("hex");
}

export function verifyRecoveryCode(code, stored) {
  if (!normalizeRecoveryCode(code) || !/^[a-f0-9]{64}$/.test(stored || "")) return false;
  return timingSafeEqual(Buffer.from(hashRecoveryCode(code), "hex"), Buffer.from(stored, "hex"));
}

export function displayName(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.trim().length > 80) throw new AccountError("Keep your display name to 80 characters or fewer.");
  return value.trim();
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || "",
    settings: { hasOmdbKey: Boolean(user.settings?.omdbKey) },
    createdAt: user.createdAt,
    hasRecoveryCode: Boolean(user.recoveryHash),
  };
}

export function sessionVersion(user) {
  return Number.isSafeInteger(user?.sessionVersion) && user.sessionVersion >= 0 ? user.sessionVersion : 0;
}

/**
 * Merge account changes against a strong, fresh version. Conditional writes are
 * always confirmed: the installed Blobs SDK can report false success on CAS.
 * Operation markers survive an immediately-following settings/profile write.
 */
export async function updateUserRecord({ store, userId, change }) {
  const operation = randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(userId, { type: "json", consistency: "strong" });
    if (!existing?.data || existing.data.id !== userId) throw new AccountError("This account is unavailable. Sign in again.", 401, "AUTH_REQUIRED");
    if (!existing.etag) throw new AccountError("The account could not be safely updated. Try again.", 503, "ACCOUNT_CONFLICT");
    const next = await change(existing.data);
    if (next.id !== userId || next.email !== existing.data.email) throw new AccountError("Account identity cannot be changed here.", 400);
    next.accountOperations = [...(existing.data.accountOperations || []).slice(-15), operation];
    next.updatedAt = new Date().toISOString();
    let writeError;
    try { await store.setJSON(userId, next, { onlyIfMatch: existing.etag }); }
    catch (error) { writeError = error; }
    const confirmed = await store.get(userId, { type: "json", consistency: "strong" });
    if (confirmed?.accountOperations?.includes(operation)) return next;
    if (writeError && !confirmed) throw new AccountError("Your account update could not be confirmed. Try again.", 503, "ACCOUNT_UNAVAILABLE");
  }
  throw new AccountError("Your account changed in another tab. Please try again.", 409, "ACCOUNT_CONFLICT");
}
