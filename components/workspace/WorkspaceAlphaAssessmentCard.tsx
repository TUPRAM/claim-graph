"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useWorkspaceAlphaAssessment } from "@/components/workspace/hooks/useWorkspaceAlphaAssessment";
import type {
  AlphaAssessmentVerdict,
  AlphaReviewerRole,
  WorkspaceAlphaAssessment
} from "@/types/claimgraph";

type AssessmentDraft = Omit<WorkspaceAlphaAssessment, "workspaceId" | "createdAt" | "updatedAt">;

const DEFAULT_DRAFT: AssessmentDraft = {
  reviewerRole: "product",
  verdict: "useful_with_notes",
  wouldRevisit: true,
  wouldShareExport: false,
  strongestDisagreementRating: 3,
  provenanceTrustRating: 3,
  confusionPoints: "",
  blockerNotes: "",
  followUpQuestion: ""
};

function toDraft(assessment: WorkspaceAlphaAssessment | null): AssessmentDraft {
  if (!assessment) {
    return { ...DEFAULT_DRAFT };
  }

  return {
    reviewerRole: assessment.reviewerRole,
    verdict: assessment.verdict,
    wouldRevisit: assessment.wouldRevisit,
    wouldShareExport: assessment.wouldShareExport,
    strongestDisagreementRating: assessment.strongestDisagreementRating,
    provenanceTrustRating: assessment.provenanceTrustRating,
    confusionPoints: assessment.confusionPoints,
    blockerNotes: assessment.blockerNotes,
    followUpQuestion: assessment.followUpQuestion
  };
}

export function WorkspaceAlphaAssessmentCard({
  workspaceId
}: {
  workspaceId: string;
}) {
  const {
    assessment,
    isLoading,
    isSaving,
    error,
    notice,
    saveAssessment
  } = useWorkspaceAlphaAssessment(workspaceId, workspaceId !== "demo");
  const [draft, setDraft] = useState<AssessmentDraft>(DEFAULT_DRAFT);

  useEffect(() => {
    setDraft(toDraft(assessment));
  }, [assessment]);

  function updateBooleanField(
    field: "wouldRevisit" | "wouldShareExport",
    value: boolean
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateStringField(
    field:
      | "confusionPoints"
      | "blockerNotes"
      | "followUpQuestion"
      | "reviewerRole"
      | "verdict",
    value: string
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateNumberField(
    field: "strongestDisagreementRating" | "provenanceTrustRating",
    value: number
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value as AssessmentDraft[typeof field]
    }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveAssessment(draft);
  }

  return (
    <section className="content-card workspace-assessment-card">
      <div className="section-header">
        <div>
          <p className="eyebrow">Alpha feedback</p>
          <h2>Workspace assessment</h2>
          <p className="muted">
            Tie first-user feedback to the saved workspace instead of keeping launch
            notes in a separate document.
          </p>
        </div>
      </div>

      {workspaceId === "demo" ? (
        <p className="muted">
          The demo workspace stays read-only. Save alpha assessments on real
          workspaces so the feedback is tied to live capture and export artifacts.
        </p>
      ) : (
        <form className="workspace-assessment-card__form" onSubmit={onSubmit}>
          <div className="settings-grid">
            <label className="field">
              <span className="field__label">Reviewer role</span>
              <select
                className="input"
                value={draft.reviewerRole}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  updateStringField("reviewerRole", event.target.value as AlphaReviewerRole)
                }
                disabled={isLoading || isSaving}
              >
                <option value="product">product</option>
                <option value="policy">policy</option>
                <option value="research">research</option>
                <option value="technical">technical</option>
                <option value="other">other</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">Verdict</span>
              <select
                className="input"
                value={draft.verdict}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  updateStringField("verdict", event.target.value as AlphaAssessmentVerdict)
                }
                disabled={isLoading || isSaving}
              >
                <option value="ready_to_share">ready to share</option>
                <option value="useful_with_notes">useful with notes</option>
                <option value="not_ready">not ready</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">Strongest disagreement clarity</span>
              <input
                className="input"
                type="number"
                min={1}
                max={5}
                value={draft.strongestDisagreementRating}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateNumberField("strongestDisagreementRating", Number(event.target.value))
                }
                disabled={isLoading || isSaving}
              />
            </label>

            <label className="field">
              <span className="field__label">Provenance trust</span>
              <input
                className="input"
                type="number"
                min={1}
                max={5}
                value={draft.provenanceTrustRating}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateNumberField("provenanceTrustRating", Number(event.target.value))
                }
                disabled={isLoading || isSaving}
              />
            </label>
          </div>

          <div className="settings-grid">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.wouldRevisit}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateBooleanField("wouldRevisit", event.target.checked)
                }
                disabled={isLoading || isSaving}
              />
              Would revisit this workspace
            </label>

            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.wouldShareExport}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateBooleanField("wouldShareExport", event.target.checked)
                }
                disabled={isLoading || isSaving}
              />
              Would share the markdown export
            </label>
          </div>

          <label className="field">
            <span className="field__label">Confusion points</span>
            <textarea
              className="textarea"
              rows={3}
              value={draft.confusionPoints}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                updateStringField("confusionPoints", event.target.value)
              }
              placeholder="What needed explanation before the graph became useful?"
              disabled={isLoading || isSaving}
            />
          </label>

          <label className="field">
            <span className="field__label">Blockers</span>
            <textarea
              className="textarea"
              rows={3}
              value={draft.blockerNotes}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                updateStringField("blockerNotes", event.target.value)
              }
              placeholder="What still prevents this workspace from feeling ready to share?"
              disabled={isLoading || isSaving}
            />
          </label>

          <label className="field">
            <span className="field__label">Follow-up question</span>
            <textarea
              className="textarea"
              rows={2}
              value={draft.followUpQuestion}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                updateStringField("followUpQuestion", event.target.value)
              }
              placeholder="What should the next honest capture or iteration investigate?"
              disabled={isLoading || isSaving}
            />
          </label>

          {error ? <p className="error-text">{error}</p> : null}
          {notice ? <p className="muted">{notice}</p> : null}
          {assessment?.updatedAt ? (
            <p className="muted">Last saved {new Date(assessment.updatedAt).toLocaleString()}</p>
          ) : null}

          <div className="hero-actions">
            <button
              type="submit"
              className="button button--primary button--small"
              disabled={isLoading || isSaving}
            >
              {isSaving ? "Saving..." : "Save alpha assessment"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
