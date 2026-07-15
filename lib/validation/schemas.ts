import { z } from "zod";

export const workspaceSettingsSchema = z.object({
  maxWebSources: z.number().int().min(0).max(8).default(8),
  maxFiles: z.number().int().min(0).max(5).default(5),
  freshnessBias: z.enum(["low", "medium", "high"]).default("high"),
  preferPrimarySources: z.boolean().default(true),
  includeOpposingEvidence: z.boolean().default(true)
}).strict();

export const workspaceCreateRequestSchema = z.object({
  question: z.string().trim().min(8).max(240),
  sourceUrls: z.array(z.string().trim().url()).max(3).default([]),
  settings: workspaceSettingsSchema.partial().strict().optional()
}).strict();

export const workspaceAlphaAssessmentSchema = z.object({
  reviewerRole: z.enum(["product", "policy", "research", "technical", "other"]),
  verdict: z.enum(["ready_to_share", "useful_with_notes", "not_ready"]),
  wouldRevisit: z.boolean(),
  wouldShareExport: z.boolean(),
  strongestDisagreementRating: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5)
  ]),
  provenanceTrustRating: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5)
  ]),
  confusionPoints: z.string().trim().max(1200),
  blockerNotes: z.string().trim().max(1200),
  followUpQuestion: z.string().trim().max(400)
}).strict();
