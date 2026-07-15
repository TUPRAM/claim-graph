import { NextResponse } from "next/server";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import { workspaceAlphaAssessmentSchema } from "@/lib/validation/schemas";
import { requireSameOriginMutation } from "@/lib/server/workspace-capability";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();

  if (!(await store.getWorkspace(workspaceId))) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  return NextResponse.json({
    assessment: await store.getWorkspaceAlphaAssessment(workspaceId)
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const originRejection = requireSameOriginMutation(request);

  if (originRejection) {
    return originRejection;
  }

  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();

  if (!(await store.getWorkspace(workspaceId))) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = workspaceAlphaAssessmentSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid assessment payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  const assessment = await store.saveWorkspaceAlphaAssessment(workspaceId, parsed.data);
  return NextResponse.json({ assessment });
}
