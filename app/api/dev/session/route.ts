import { NextResponse } from "next/server";
import {
  DEV_SESSION_COOKIE_NAME,
  createDevSessionCookieValue,
  getDevSessionClearCookieOptions,
  getDevSessionCookieOptions,
  hasDevSessionFromRequest,
  isDevAuthConfigured,
  verifyDevPasswordAsync
} from "@/lib/server/dev-auth";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";
import {
  consumePublicBetaRateLimit,
  getPublicClientAddress
} from "@/lib/server/public-beta-control-store";
import { getPublicBetaPolicy } from "@/lib/server/public-beta-policy";
import { requireSameOriginMutation } from "@/lib/server/workspace-capability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return NextResponse.json({
    authenticated: hasDevSessionFromRequest(request),
    configured: isDevAuthConfigured()
  });
}

export async function POST(request: Request) {
  const originRejection = requireSameOriginMutation(request);

  if (originRejection) {
    return originRejection;
  }

  if (!isDevAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Developer mode is not configured. Set DEV_MODE_PASSWORD_HASH and DEV_MODE_SESSION_SECRET."
      },
      { status: 503 }
    );
  }

  const policy = getPublicBetaPolicy();
  const globalAttempt = await consumePublicBetaRateLimit({
    scope: "dev-login-global",
    subject: "global-dev-login",
    limit: policy.developerLogin.globalLimit,
    windowMs: policy.developerLogin.globalWindowMs
  });

  if (!globalAttempt.allowed) {
    return NextResponse.json(
      { error: "Developer login is temporarily throttled. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(globalAttempt.retryAfterSeconds) }
      }
    );
  }

  const attempt = await consumePublicBetaRateLimit({
    scope: "dev-login",
    subject: getPublicClientAddress(request),
    limit: policy.developerLogin.limit,
    windowMs: policy.developerLogin.windowMs
  });

  if (!attempt.allowed) {
    return NextResponse.json(
      { error: "Too many developer login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfterSeconds) } }
    );
  }

  let body: { password?: unknown };

  try {
    body = (await readBoundedJsonBody({
      request,
      maxBytes: 4 * 1024,
      label: "Developer login request"
    })) as { password?: unknown };
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";

  if (!(await verifyDevPasswordAsync(password))) {
    return NextResponse.json({ error: "Invalid developer password." }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(
    DEV_SESSION_COOKIE_NAME,
    createDevSessionCookieValue(),
    getDevSessionCookieOptions()
  );

  return response;
}

export async function DELETE(request: Request) {
  const originRejection = requireSameOriginMutation(request);

  if (originRejection) {
    return originRejection;
  }

  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(
    DEV_SESSION_COOKIE_NAME,
    "",
    getDevSessionClearCookieOptions()
  );

  return response;
}
