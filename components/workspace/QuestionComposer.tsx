"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import {
  FileDropzone,
  type DraftWorkspaceFile
} from "@/components/workspace/FileDropzone";
import type { ClaimGraphRuntimeInfo, WorkspaceSettings } from "@/types/claimgraph";
import {
  WORKSPACE_WRITE_CAPABILITY_HEADER,
  createClientWorkspaceWriteCapability
} from "@/lib/workspace-capability-client";

const SOURCE_PANEL_ANIMATION_MS = 190;
const FILE_SECTION_EMPHASIS_MS = 1200;

type SourceFocusTarget = "links" | "files" | "panel";

export type QuestionComposerRuntime = Pick<
  ClaimGraphRuntimeInfo,
  "supportsUrlIntake" | "supportsWebSearch"
> & { supportsFileIntake?: boolean };

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

function formatCommandExampleLabel(question: string) {
  const normalized = question.replace(/\?$/, "");

  switch (question) {
    case "Should cities ban cars downtown?":
      return "City car bans";
    case "Should schools start later?":
      return "Later school start times";
    case "Should companies require office days?":
      return "Office days";
    default:
      return normalized.replace(/^Should\s+/i, "");
  }
}

export function QuestionComposer({
  variant = "standard",
  defaultQuestion,
  runtime,
  defaultSettings,
  exampleQuestions = [],
  privacyNotice
}: {
  variant?: "standard" | "command";
  defaultQuestion: string;
  runtime: QuestionComposerRuntime;
  defaultSettings: WorkspaceSettings;
  exampleQuestions?: string[];
  privacyNotice?: string;
}) {
  const router = useRouter();
  const sourcePanelId = useId();
  const sourcePanelTitleId = useId();
  const sourcePanelDescriptionId = useId();
  const sourceToggleRef = useRef<HTMLButtonElement>(null);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const sourcePanelReturnRef = useRef<HTMLButtonElement | null>(null);
  const sourcePanelRef = useRef<HTMLElement>(null);
  const sourceLinksTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileSectionRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pendingWriteCapabilityRef = useRef<string | null>(null);
  const pendingIdempotencyKeyRef = useRef<string | null>(null);
  const [question, setQuestion] = useState(defaultQuestion);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sourcePanelMounted, setSourcePanelMounted] = useState(false);
  const [sourceFocusTarget, setSourceFocusTarget] = useState<SourceFocusTarget>("links");
  const [emphasizeFileSection, setEmphasizeFileSection] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sourceUrlsText, setSourceUrlsText] = useState("");
  const [maxWebSources, setMaxWebSources] = useState(defaultSettings.maxWebSources);
  const [freshnessBias, setFreshnessBias] = useState<"low" | "medium" | "high">(
    defaultSettings.freshnessBias
  );
  const [preferPrimarySources, setPreferPrimarySources] = useState(
    defaultSettings.preferPrimarySources
  );
  const [includeOpposingEvidence, setIncludeOpposingEvidence] = useState(
    defaultSettings.includeOpposingEvidence
  );
  const [files, setFiles] = useState<DraftWorkspaceFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sourceUrls = sourceUrlsText
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3);
  const attachedSourceCount = sourceUrls.length + files.length;
  const supportsFileIntake = runtime.supportsFileIntake !== false;
  const sourceSummary = attachedSourceCount
    ? `${attachedSourceCount} source${attachedSourceCount === 1 ? "" : "s"} added`
    : "Sources optional";

  useEffect(() => {
    if (!sourcePanelMounted || !showSources) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const sourcePanel = sourcePanelRef.current;

      if (sourceFocusTarget === "files") {
        setEmphasizeFileSection(true);
        if (sourcePanel && fileSectionRef.current) {
          sourcePanel.scrollTo({
            top: Math.max(0, fileSectionRef.current.offsetTop - 18),
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth"
          });
        }
        fileSectionRef.current?.focus({ preventScroll: true });
        return;
      }

      sourcePanel?.scrollTo({ top: 0, behavior: "auto" });

      if (sourceFocusTarget === "links" && runtime.supportsUrlIntake) {
        sourceLinksTextareaRef.current?.focus({ preventScroll: true });
        return;
      }

      sourcePanelRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [runtime.supportsUrlIntake, showSources, sourceFocusTarget, sourcePanelMounted]);

  useEffect(() => {
    if (!sourceMenuOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      sourceMenuRef.current
        ?.querySelector<HTMLButtonElement>(".composer-command__source-option")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [sourceMenuOpen]);

  useEffect(() => {
    if (!emphasizeFileSection) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setEmphasizeFileSection(false);
    }, FILE_SECTION_EMPHASIS_MS);

    return () => window.clearTimeout(timerId);
  }, [emphasizeFileSection]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const advancedSettings = showAdvanced && runtime.supportsWebSearch ? (
    <div className="settings-grid">
      <label className="field">
        <span className="field__label">Max web sources</span>
        <input
          className="input"
          type="number"
          min={1}
          max={8}
          value={maxWebSources}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setMaxWebSources(Number(event.target.value))
          }
        />
      </label>

      <label className="field">
        <span className="field__label">Freshness bias</span>
        <select
          className="input"
          value={freshnessBias}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            setFreshnessBias(event.target.value as "low" | "medium" | "high")
          }
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={preferPrimarySources}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setPreferPrimarySources(event.target.checked)
          }
        />
        Prefer primary sources
      </label>

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={includeOpposingEvidence}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setIncludeOpposingEvidence(event.target.checked)
          }
        />
        Include opposing evidence
      </label>
    </div>
  ) : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set("question", question);
      formData.set("sourceUrls", JSON.stringify(sourceUrls));
      formData.set(
        "settings",
        JSON.stringify({
          maxWebSources,
          maxFiles: defaultSettings.maxFiles,
          freshnessBias,
          preferPrimarySources,
          includeOpposingEvidence
        })
      );

      for (const item of files) {
        formData.append("files", item.file);
      }

      const writeCapability =
        pendingWriteCapabilityRef.current ??
        createClientWorkspaceWriteCapability();
      pendingWriteCapabilityRef.current = writeCapability;
      const idempotencyKey =
        pendingIdempotencyKeyRef.current ?? crypto.randomUUID();
      pendingIdempotencyKeyRef.current = idempotencyKey;
      const createResponse = await fetch("/api/workspaces", {
        method: "POST",
        headers: {
          [WORKSPACE_WRITE_CAPABILITY_HEADER]: writeCapability,
          "Idempotency-Key": idempotencyKey
        },
        body: formData
      });

      if (!createResponse.ok) {
        throw new Error(
          await readErrorMessage(createResponse, "Failed to create workspace.")
        );
      }

      const createJson = (await createResponse.json()) as { workspaceId: string };
      pendingWriteCapabilityRef.current = null;
      pendingIdempotencyKeyRef.current = null;
      router.push(`/workspace/${createJson.workspaceId}`);
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : "An unexpected error occurred.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openSources(returnTarget: HTMLButtonElement, focusTarget: SourceFocusTarget) {
    clearCloseTimer();
    sourcePanelReturnRef.current = returnTarget;
    setSourceMenuOpen(false);
    setSourceFocusTarget(focusTarget);
    setSourcePanelMounted(true);
    setShowSources(true);
  }

  function closeSources() {
    clearCloseTimer();
    setSourceMenuOpen(false);
    setShowSources(false);
    setEmphasizeFileSection(false);
    const returnTarget = sourcePanelReturnRef.current ?? sourceToggleRef.current;
    window.requestAnimationFrame(() => returnTarget?.focus());
    closeTimerRef.current = window.setTimeout(() => {
      setSourcePanelMounted(false);
      closeTimerRef.current = null;
    }, SOURCE_PANEL_ANIMATION_MS);
  }

  function toggleSourceMenu(returnTarget: HTMLButtonElement) {
    sourcePanelReturnRef.current = returnTarget;

    if (showSources) {
      closeSources();
      return;
    }

    if (sourceMenuOpen) {
      closeSourceMenu();
      return;
    }

    clearCloseTimer();
    setSourcePanelMounted(false);
    setSourceMenuOpen(true);
  }

  function chooseSourceOption(focusTarget: SourceFocusTarget) {
    const returnTarget = sourceToggleRef.current ?? sourcePanelReturnRef.current;

    if (!returnTarget) {
      return;
    }

    openSources(returnTarget, focusTarget);
  }

  function closeSourceMenu() {
    setSourceMenuOpen(false);
    window.requestAnimationFrame(() => sourceToggleRef.current?.focus());
  }

  function onSourceMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeSourceMenu();
  }

  function onSourcePanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeSources();
  }

  if (variant === "command") {
    return (
      <form className="composer composer--command" onSubmit={onSubmit}>
        <div className="composer-command__bar">
          <div className="composer-command__leading-actions">
            <button
              ref={sourceToggleRef}
              type="button"
              className="composer-command__source-toggle"
              aria-label={showSources || sourceMenuOpen ? "Close source options" : "Add source links or files"}
              aria-expanded={showSources || sourceMenuOpen}
              aria-controls={sourceMenuOpen ? `${sourcePanelId}-menu` : sourcePanelId}
              data-state={showSources || sourceMenuOpen ? "open" : "closed"}
              onClick={(event) => toggleSourceMenu(event.currentTarget)}
            >
              <span className="composer-command__source-glyph" aria-hidden="true" />
            </button>
          </div>

          <label className="composer-command__question">
            <span className="sr-only">Question to map</span>
            <textarea
              value={question}
              rows={1}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                setQuestion(event.target.value)
              }
              placeholder="Type a disagreement to map..."
            />
          </label>

          <span className="composer-command__source-summary" aria-live="polite">
            {sourceSummary}
          </span>

          <button
            type="submit"
            className="composer-command__submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create map"}
          </button>
        </div>

        {sourceMenuOpen ? (
          <div
            id={`${sourcePanelId}-menu`}
            ref={sourceMenuRef}
            className="composer-command__source-menu"
            role="menu"
            aria-label="Choose source type"
            onKeyDown={onSourceMenuKeyDown}
          >
            {supportsFileIntake ? <button
              type="button"
              className="composer-command__source-option composer-command__source-option--files"
              role="menuitem"
              onClick={() => chooseSourceOption("files")}
            >
              <span className="composer-command__source-option-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M8 12.5 14.8 5.7a3.4 3.4 0 0 1 4.8 4.8l-8.7 8.7a5 5 0 0 1-7.1-7.1l8-8" />
                </svg>
              </span>
              <span>Add files</span>
            </button> : null}
            <button
              type="button"
              className="composer-command__source-option composer-command__source-option--links"
              role="menuitem"
              onClick={() => chooseSourceOption("links")}
            >
              <span className="composer-command__source-option-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M10 13.5a4 4 0 0 0 5.7.1l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.1 1.1" />
                  <path d="M14 10.5a4 4 0 0 0-5.7-.1L6 12.7a4 4 0 0 0 5.7 5.7l1.1-1.1" />
                </svg>
              </span>
              <span>Add link</span>
            </button>
          </div>
        ) : null}

        {exampleQuestions.length ? (
          <div className="composer-command__examples" aria-label="Example questions">
            {exampleQuestions.map((exampleQuestion) => (
              <button
                key={exampleQuestion}
                type="button"
                className="composer-command__example"
                aria-label={`Use example question: ${exampleQuestion}`}
                title={exampleQuestion}
                onClick={() => setQuestion(exampleQuestion)}
              >
                {formatCommandExampleLabel(exampleQuestion)}
              </button>
            ))}
          </div>
        ) : null}

        {sourcePanelMounted ? (
          <section
            ref={sourcePanelRef}
            id={sourcePanelId}
            className={[
              "composer-command__source-panel",
              showSources ? "composer-command__source-panel--open" : "composer-command__source-panel--closing",
              emphasizeFileSection ? "composer-command__source-panel--file-focus" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            data-state={showSources ? "open" : "closing"}
            tabIndex={-1}
            aria-hidden={!showSources}
            aria-labelledby={sourcePanelTitleId}
            aria-describedby={sourcePanelDescriptionId}
            aria-label="Source links and files"
            onKeyDown={onSourcePanelKeyDown}
          >
            <span className="composer-command__sheet-handle" aria-hidden="true" />
            <div className="composer-command__source-header">
              <div>
                <h2 id={sourcePanelTitleId}>Add sources</h2>
                <p id={sourcePanelDescriptionId}>
                  Links and files keep the argument map tied to inspectable
                  evidence. You can also continue question-only.
                </p>
              </div>
              <button
                type="button"
                className="composer-command__panel-close"
                aria-label="Close source tray"
                onClick={closeSources}
              >
                Close
              </button>
            </div>

            {runtime.supportsUrlIntake ? (
              <label className="field">
                <span className="field__label">Source links</span>
                <textarea
                  ref={sourceLinksTextareaRef}
                  className="textarea"
                  value={sourceUrlsText}
                  rows={3}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                    setSourceUrlsText(event.target.value)
                  }
                  placeholder={"https://example.com/report\nhttps://example.com/article"}
                />
                <span className="field__hint">Paste source links, one per line.</span>
              </label>
            ) : null}

            {supportsFileIntake ? <div
              ref={fileSectionRef}
              className={[
                "composer-command__file-section",
                emphasizeFileSection ? "composer-command__file-section--emphasized" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              role="group"
              aria-label="File sources"
              tabIndex={-1}
            >
              <FileDropzone
                files={files}
                maxFiles={defaultSettings.maxFiles}
                disabled={isSubmitting}
                onChange={setFiles}
              />
            </div> : (
              <p className="field__hint">
                File uploads are temporarily unavailable. Add public source
                links to continue.
              </p>
            )}

            {runtime.supportsWebSearch ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setShowAdvanced((value: boolean) => !value)}
              >
                {showAdvanced ? "Hide source settings" : "Show source settings"}
              </button>
            ) : null}

            {advancedSettings}
          </section>
        ) : null}

        {privacyNotice ? <p className="muted">{privacyNotice}</p> : null}

        {error ? <p className="error-text">{error}</p> : null}
      </form>
    );
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <label className="field">
        <span className="field__label">Question to investigate</span>
        <textarea
          className="textarea"
          value={question}
          rows={4}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setQuestion(event.target.value)
          }
          placeholder="Should cities ban cars downtown?"
        />
        <span className="field__hint">
          Ask one contested tradeoff or policy-style question. ClaimGraph works
          best when there is a meaningful disagreement to map.
        </span>
      </label>

      {exampleQuestions.length ? (
        <div className="composer-examples" aria-label="Example questions">
          <span className="composer-examples__label">Try an example</span>
          <div className="example-chips">
            {exampleQuestions.map((exampleQuestion) => (
              <button
                key={exampleQuestion}
                type="button"
                className="example-chip example-chip--button"
                onClick={() => setQuestion(exampleQuestion)}
              >
                {exampleQuestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {runtime.supportsUrlIntake ? (
        <label className="field">
          <span className="field__label">Source links</span>
          <textarea
            className="textarea"
            value={sourceUrlsText}
            rows={3}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setSourceUrlsText(event.target.value)
            }
            placeholder={"https://example.com/report\nhttps://example.com/article"}
          />
          <span className="field__hint">
            Paste source links, one per line. The graph will stay tied to the
            sources you provide.
          </span>
        </label>
      ) : null}

      {supportsFileIntake ? <FileDropzone
        files={files}
        maxFiles={defaultSettings.maxFiles}
        disabled={isSubmitting}
        onChange={setFiles}
      /> : (
        <p className="field__hint">
          File uploads are temporarily unavailable. Add public source links to
          continue.
        </p>
      )}

      {runtime.supportsWebSearch ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setShowAdvanced((value: boolean) => !value)}
        >
          {showAdvanced ? "Hide source settings" : "Show source settings"}
        </button>
      ) : null}

      {advancedSettings}

      {privacyNotice ? <p className="muted">{privacyNotice}</p> : null}

      {error ? <p className="error-text">{error}</p> : null}

      <div className="composer__footer">
        <p className="muted">
          The workspace opens immediately. Build the graph there, then inspect
          each node through its sources and snippets.
        </p>
        <button
          type="submit"
          className="button button--primary"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Creating map..." : "Create map"}
        </button>
      </div>
    </form>
  );
}
