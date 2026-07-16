// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionComposer } from "@/components/workspace/QuestionComposer";
import type { WorkspaceSettings } from "@/types/claimgraph";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock
  })
}));

const defaultSettings: WorkspaceSettings = {
  maxWebSources: 6,
  maxFiles: 5,
  freshnessBias: "high",
  preferPrimarySources: true,
  includeOpposingEvidence: true
};

function renderComposer(runtime: {
  supportsUrlIntake: boolean;
  supportsFileIntake: boolean;
  supportsWebSearch: boolean;
}) {
  return render(
    <QuestionComposer
      variant="command"
      defaultQuestion="Should cities ban cars downtown?"
      runtime={runtime}
      defaultSettings={defaultSettings}
    />
  );
}

describe("QuestionComposer source capabilities", () => {
  beforeEach(() => {
    pushMock.mockReset();

    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id)
    );
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens truthful web-search settings when manual intake is unavailable", async () => {
    renderComposer({
      supportsUrlIntake: false,
      supportsFileIntake: false,
      supportsWebSearch: true
    });

    expect(screen.getByText("Web search available")).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Add link")).toBeNull();
    expect(screen.queryByText("Add files")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Configure web source search" })
    );

    const panel = await screen.findByRole("region", {
      name: "Web source settings"
    });

    expect(within(panel).getByLabelText("Max web sources")).not.toBeNull();
    expect(within(panel).getByLabelText("Freshness bias")).not.toBeNull();
    expect(within(panel).queryByText("Source links")).toBeNull();
    expect(within(panel).queryByRole("group", { name: "File sources" })).toBeNull();
  });

  it("offers only link intake when URLs are the supported manual source", async () => {
    renderComposer({
      supportsUrlIntake: true,
      supportsFileIntake: false,
      supportsWebSearch: false
    });

    fireEvent.click(screen.getByRole("button", { name: "Add source links" }));

    const menu = screen.getByRole("menu", { name: "Choose source type" });
    const linkOption = within(menu).getByRole("menuitem", { name: "Add link" });

    expect(within(menu).queryByRole("menuitem", { name: "Add files" })).toBeNull();
    fireEvent.click(linkOption);

    const panel = await screen.findByRole("region", { name: "Add source links" });
    expect(within(panel).getByText("Source links")).not.toBeNull();
    expect(panel.querySelector("textarea")?.getAttribute("placeholder")).toContain(
      "https://example.com/report"
    );
    expect(within(panel).queryByRole("group", { name: "File sources" })).toBeNull();
  });

  it("offers only file intake when files are the supported manual source", async () => {
    renderComposer({
      supportsUrlIntake: false,
      supportsFileIntake: true,
      supportsWebSearch: false
    });

    fireEvent.click(screen.getByRole("button", { name: "Add source files" }));

    const menu = screen.getByRole("menu", { name: "Choose source type" });
    const fileOption = within(menu).getByRole("menuitem", { name: "Add files" });

    expect(within(menu).queryByRole("menuitem", { name: "Add link" })).toBeNull();
    fireEvent.click(fileOption);

    const panel = await screen.findByRole("region", { name: "Add source files" });
    expect(within(panel).getByRole("group", { name: "File sources" })).not.toBeNull();
    expect(within(panel).queryByText("Source links")).toBeNull();
  });

  it("keeps a question-only runtime usable without rendering source controls", () => {
    renderComposer({
      supportsUrlIntake: false,
      supportsFileIntake: false,
      supportsWebSearch: false
    });

    expect(screen.getByText("Question-only")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /source/i })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Create map" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});
