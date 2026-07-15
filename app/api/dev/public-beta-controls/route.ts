import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import {
  getEffectivePublicBetaControls,
  getProviderCapacitySnapshot,
  updatePublicBetaOperatorOverrides
} from "@/lib/server/public-beta-control-store";
import { requireSameOriginMutation } from "@/lib/server/workspace-capability";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  analysisEnabled: z.boolean().optional(),
  workspaceCreationLimit: z.number().int().min(1).max(1_000).optional(),
  workspaceAnalysisLimit: z.number().int().min(1).max(1_000).optional(),
  exportLimit: z.number().int().min(1).max(10_000).optional(),
  dailyPaidAnalysisLimit: z.number().int().min(1).max(10_000).optional(),
  providerConcurrency: z.number().int().min(1).max(100).optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one public-beta control is required."
});

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json({
    controls: await getEffectivePublicBetaControls(),
    providerCapacity: await getProviderCapacitySnapshot()
  });
}

export async function PUT(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const crossOrigin = requireSameOriginMutation(request, {
    errorMessage: "Cross-origin operator control changes are not allowed."
  });

  if (crossOrigin) {
    return crossOrigin;
  }

  let body: unknown;

  try {
    body = await readBoundedJsonBody({
      request,
      maxBytes: 8 * 1024,
      label: "Public-beta operator control request"
    });
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid public-beta controls.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const overrides = await updatePublicBetaOperatorOverrides(parsed.data);

  return NextResponse.json({
    updated: true,
    overrides,
    controls: await getEffectivePublicBetaControls(),
    providerCapacity: await getProviderCapacitySnapshot()
  });
}
