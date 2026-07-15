"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Workspace } from "@/types/claimgraph";

type DevWorkspaceListItem = Pick<Workspace, "id" | "question" | "updatedAt" | "sourceUrls">;

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}

export function DevWorkspaceTable({ workspaces }: { workspaces: DevWorkspaceListItem[] }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredWorkspaces = useMemo(() => {
    if (!normalizedQuery) {
      return workspaces;
    }

    return workspaces.filter((workspace) =>
      workspace.question.toLowerCase().includes(normalizedQuery)
    );
  }, [normalizedQuery, workspaces]);

  return (
    <div className="dev-workspace-index">
      <div className="dev-workspace-toolbar">
        <label className="dev-workspace-search">
          <span>Filter by question</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search recent workspaces"
          />
        </label>
        <div className="dev-workspace-toolbar__meta">
          <span>
            {filteredWorkspaces.length} of {workspaces.length}
          </span>
          {query ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setQuery("")}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="dev-workspace-table-shell">
        <table className="dev-workspace-compact-table">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Updated</th>
              <th scope="col">Sources</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {filteredWorkspaces.length ? (
              filteredWorkspaces.map((workspace) => (
                <tr key={workspace.id}>
                  <td>
                    <Link href={`/dev/workspace/${workspace.id}`} className="dev-workspace-question-link">
                      {workspace.question}
                    </Link>
                    <span className="dev-workspace-id">#{shortId(workspace.id)}</span>
                  </td>
                  <td>
                    <time dateTime={workspace.updatedAt}>{formatUpdatedAt(workspace.updatedAt)}</time>
                  </td>
                  <td>{workspace.sourceUrls.length}</td>
                  <td>
                    <div className="dev-workspace-actions">
                      <Link
                        href={`/dev/workspace/${workspace.id}`}
                        className="dev-workspace-action dev-workspace-action--primary"
                      >
                        Diagnostics
                      </Link>
                      <Link
                        href={`/workspace/${workspace.id}`}
                        className="dev-workspace-action"
                      >
                        Public
                      </Link>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>
                  <p className="muted dev-workspace-empty">
                    No recent workspace questions match this filter.
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
