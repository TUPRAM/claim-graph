import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { hasStrongPublicBetaSecret } from "@/lib/server/public-beta-policy";

export const DEV_SESSION_COOKIE_NAME = "claimgraph_dev_session";

const PASSWORD_HASH_PREFIX = "scrypt";
const PASSWORD_KEY_LENGTH = 32;
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  version: 1;
  issuedAt: number;
  expiresAt: number;
}

function getPasswordHash() {
  return process.env.DEV_MODE_PASSWORD_HASH?.trim() ?? "";
}

function getSessionSecret() {
  const value = process.env.DEV_MODE_SESSION_SECRET?.trim() ?? "";
  return hasStrongPublicBetaSecret(value) ? value : "";
}

function encodeBase64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url");
}

function sign(value: string) {
  const secret = getSessionSecret();

  if (!secret) {
    throw new Error("DEV_MODE_SESSION_SECRET is required for developer sessions.");
  }

  return createHmac("sha256", secret).update(value).digest("base64url");
}

function parsePasswordHash(hash: string) {
  const [prefix, salt, digest] = hash.split(":");

  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !digest) {
    return null;
  }

  return {
    salt: decodeBase64Url(salt),
    digest: decodeBase64Url(digest)
  };
}

export function createDevPasswordHash(password: string, salt = randomBytes(16)) {
  const digest = scryptSync(password, salt, PASSWORD_KEY_LENGTH);

  return [
    PASSWORD_HASH_PREFIX,
    encodeBase64Url(salt),
    encodeBase64Url(digest)
  ].join(":");
}

export function isDevAuthConfigured() {
  return Boolean(parsePasswordHash(getPasswordHash()) && getSessionSecret());
}

export function verifyDevPassword(password: string) {
  if (!password) {
    return false;
  }

  const parsedHash = parsePasswordHash(getPasswordHash());

  if (!parsedHash) {
    return false;
  }

  const candidate = scryptSync(password, parsedHash.salt, parsedHash.digest.length);

  return (
    candidate.length === parsedHash.digest.length &&
    timingSafeEqual(candidate, parsedHash.digest)
  );
}

export async function verifyDevPasswordAsync(password: string) {
  if (!password) {
    return false;
  }

  const parsedHash = parsePasswordHash(getPasswordHash());

  if (!parsedHash) {
    return false;
  }

  const candidate = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, parsedHash.salt, parsedHash.digest.length, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });

  return candidate.length === parsedHash.digest.length &&
    timingSafeEqual(candidate, parsedHash.digest);
}

export function createDevSessionCookieValue(now = Date.now()) {
  const payload: SessionPayload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));

  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyDevSessionCookieValue(value: string | undefined | null, now = Date.now()) {
  if (!value || !getSessionSecret()) {
    return false;
  }

  const [encodedPayload, signature] = value.split(".");

  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = sign(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as Partial<SessionPayload>;

    return payload.version === 1 &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > now;
  } catch {
    return false;
  }
}

function parseCookieHeader(cookieHeader: string | null | undefined) {
  const values = new Map<string, string>();

  for (const pair of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValueParts] = pair.trim().split("=");

    if (!rawName || !rawValueParts.length) {
      continue;
    }

    values.set(rawName, rawValueParts.join("="));
  }

  return values;
}

export function getDevSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  };
}

export function getDevSessionClearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  };
}

export function hasDevSessionFromRequest(request: Request) {
  const value = parseCookieHeader(request.headers.get("cookie")).get(DEV_SESSION_COOKIE_NAME);

  return verifyDevSessionCookieValue(value);
}

export async function hasDevSessionFromCookies() {
  const cookieStore = await cookies();
  const value = cookieStore.get(DEV_SESSION_COOKIE_NAME)?.value;

  return verifyDevSessionCookieValue(value);
}

export function requireDevApiSession(request: Request) {
  if (hasDevSessionFromRequest(request)) {
    return null;
  }

  return NextResponse.json(
    {
      error: "Developer session required."
    },
    { status: 401 }
  );
}
