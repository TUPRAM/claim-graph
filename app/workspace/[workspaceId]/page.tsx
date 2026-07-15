import { WorkspaceScreen } from "@/components/workspace/WorkspaceScreen";

interface WorkspacePageProps {
  params: Promise<{
    workspaceId: string;
  }>;
}

export default async function WorkspacePage({
  params
}: WorkspacePageProps) {
  const { workspaceId } = await params;

  if (!workspaceId) {
    return (
      <main className="workspace-shell">
        <div className="content-card">
          <h1>Workspace not found</h1>
          <p>The route did not include a workspace id.</p>
        </div>
      </main>
    );
  }

  return <WorkspaceScreen workspaceId={workspaceId} />;
}
