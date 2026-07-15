import {
  DEV_SESSION_COOKIE_NAME,
  createDevPasswordHash,
  createDevSessionCookieValue
} from "@/lib/server/dev-auth";

const TEST_DEV_PASSWORD = "claimgraph-test-dev-password";
const TEST_DEV_SECRET = "claimgraph-test-dev-session-secret-32-bytes";
const TEST_DEV_SALT = Buffer.from("claimgraph-test-salt");

export function configureDevAuthForTest() {
  process.env.DEV_MODE_PASSWORD_HASH = createDevPasswordHash(TEST_DEV_PASSWORD, TEST_DEV_SALT);
  process.env.DEV_MODE_SESSION_SECRET = TEST_DEV_SECRET;
}

export function getDevSessionCookieHeader() {
  configureDevAuthForTest();
  return `${DEV_SESSION_COOKIE_NAME}=${createDevSessionCookieValue()}`;
}

export function withDevSession(request: Request) {
  const headers = new Headers(request.headers);
  headers.set("cookie", getDevSessionCookieHeader());

  return new Request(request, { headers });
}

export function resetDevAuthForTest(input: {
  passwordHash?: string;
  sessionSecret?: string;
}) {
  if (input.passwordHash === undefined) {
    delete process.env.DEV_MODE_PASSWORD_HASH;
  } else {
    process.env.DEV_MODE_PASSWORD_HASH = input.passwordHash;
  }

  if (input.sessionSecret === undefined) {
    delete process.env.DEV_MODE_SESSION_SECRET;
  } else {
    process.env.DEV_MODE_SESSION_SECRET = input.sessionSecret;
  }
}
