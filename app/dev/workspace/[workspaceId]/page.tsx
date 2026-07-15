import { DevAuthGate } from "@/components/dev/DevAuthGate";
import { DevWorkspaceDiagnostics } from "@/components/dev/DevWorkspaceDiagnostics";
import { hasDevSessionFromCookies } from "@/lib/server/dev-auth";

export const dynamic = "force-dynamic";

export default async function DevWorkspacePage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const authenticated = await hasDevSessionFromCookies();

  if (!authenticated) {
    return <DevAuthGate />;
  }

  const { workspaceId } = await params;

  return <DevWorkspaceDiagnostics workspaceId={workspaceId} />;
}
