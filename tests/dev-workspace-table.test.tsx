// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevWorkspaceTable } from "@/components/dev/DevWorkspaceTable";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

const workspaces = [
  {
    id: "workspace_cars",
    question: "Should cities ban cars downtown?",
    updatedAt: "2026-05-22T08:00:00.000Z",
    sourceUrls: ["https://example.com/report"]
  },
  {
    id: "workspace_schools",
    question: "Should schools allow AI writing assistants?",
    updatedAt: "2026-05-22T08:30:00.000Z",
    sourceUrls: []
  }
];

afterEach(() => {
  cleanup();
});

describe("DevWorkspaceTable", () => {
  it("filters recent workspaces by question and keeps protected/public links available", () => {
    render(<DevWorkspaceTable workspaces={workspaces} />);

    expect(screen.getByText("Should cities ban cars downtown?")).toBeTruthy();
    expect(screen.getByText("Should schools allow AI writing assistants?")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by question"), {
      target: { value: "schools" }
    });

    expect(screen.queryByText("Should cities ban cars downtown?")).toBeNull();
    const row = screen.getByText("Should schools allow AI writing assistants?").closest("tr");
    expect(row).not.toBeNull();

    const rowQueries = within(row as HTMLTableRowElement);
    expect(rowQueries.getByRole("link", { name: "Diagnostics" }).getAttribute("href")).toBe(
      "/dev/workspace/workspace_schools"
    );
    expect(rowQueries.getByRole("link", { name: "Public" }).getAttribute("href")).toBe(
      "/workspace/workspace_schools"
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText("Should cities ban cars downtown?")).toBeTruthy();
    expect(screen.getByText("Should schools allow AI writing assistants?")).toBeTruthy();
  });
});
