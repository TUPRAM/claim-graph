import { z } from "zod";
import type {
  ClaimInventory,
  ClaimUnit,
  EvidencePack,
  GapUnit,
  ContradictionPair
} from "@/types/claimgraph";

export interface ClaimInventorySchemaLimits {
  maxClaims: number;
  maxContradictionPairs: number;
  maxGaps: number;
}

export const FULL_CLAIM_INVENTORY_LIMITS: ClaimInventorySchemaLimits = {
  maxClaims: 12,
  maxContradictionPairs: 10,
  maxGaps: 6
};

export const OPEN_MODEL_CLAIM_INVENTORY_LIMITS: ClaimInventorySchemaLimits = {
  maxClaims: 8,
  maxContradictionPairs: 8,
  maxGaps: 4
};

const claimUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    kind: z.enum(["claim", "counterclaim"]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(480),
    topic: z.string().trim().min(1).max(120),
    stance: z.enum(["pro", "con", "mixed", "unknown"]),
    confidence: z.number().min(0).max(1),
    evidenceQuality: z.enum(["high", "medium", "low"]),
    sourceIds: z.array(z.string().trim().min(1).max(80)).max(10),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(12),
    qualifiers: z.array(z.string().trim().min(1).max(160)).max(6),
    dependsOnGapIds: z.array(z.string().trim().min(1).max(80)).max(6)
  })
  .strict();

const contradictionPairSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    leftClaimId: z.string().trim().min(1).max(80),
    rightClaimId: z.string().trim().min(1).max(80),
    contradictionStrength: z.number().min(0).max(1),
    explanation: z.string().trim().min(1).max(320)
  })
  .strict();

const gapUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(320),
    gapType: z.enum([
      "missing_context",
      "insufficient_evidence",
      "mixed_evidence",
      "stale_evidence",
      "assumption_dependency"
    ]),
    sourceIds: z.array(z.string().trim().min(1).max(80)).max(10),
    snippetIds: z.array(z.string().trim().min(1).max(80)).max(12),
    importance: z.number().min(0).max(1)
  })
  .strict();

export function createRawClaimInventorySchema(
  limits: ClaimInventorySchemaLimits
) {
  return z
    .object({
      question: z.string().trim().min(1).max(600),
      claims: z.array(claimUnitSchema).max(limits.maxClaims),
      contradictionPairs: z
        .array(contradictionPairSchema)
        .max(limits.maxContradictionPairs),
      unresolvedGaps: z.array(gapUnitSchema).max(limits.maxGaps)
    })
    .strict();
}

export type RawClaimInventory = z.infer<
  ReturnType<typeof createRawClaimInventorySchema>
>;

interface CoordinatedClaimPair {
  connector: "and" | "but" | "while";
  primaryTitle: string;
  secondaryTitle: string;
}

interface ClaimTitleFeatures {
  title: string;
  qualifiers: string[];
  coordinatedPair: CoordinatedClaimPair | null;
}

interface SummaryFeatures {
  qualifiers: string[];
  coordinatedPair: CoordinatedClaimPair | null;
}

interface NormalizedClaimCandidate extends ClaimUnit {
  rawClaimId: string;
  splitGroupId?: string;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))
  );
}

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function wordCount(value: string) {
  return normalizeWhitespace(value).split(/\s+/).filter(Boolean).length;
}

function normalizeTitleLead(value: string) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return normalized;
  }

  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function cleanWord(value: string) {
  return value.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function stripFragmentLeadIns(value: string) {
  let normalized = normalizeWhitespace(value);

  normalized = normalized.replace(/^(?:and|but|while)\b\s*/i, "");
  normalized = normalized.replace(/^(?:also|still)\b\s*/i, "");

  return normalizeWhitespace(normalized);
}

const SHARED_PREDICATE_STARTERS = new Set([
  "improve",
  "improves",
  "improved",
  "increase",
  "increases",
  "increased",
  "reduce",
  "reduces",
  "reduced",
  "lower",
  "lowers",
  "lowered",
  "raise",
  "raises",
  "raised",
  "boost",
  "boosts",
  "boosted",
  "cut",
  "cuts",
  "help",
  "helps",
  "helped",
  "hurt",
  "hurts",
  "limit",
  "limits",
  "limited",
  "support",
  "supports",
  "supported",
  "preserve",
  "preserves",
  "preserved",
  "weaken",
  "weakens",
  "weakened",
  "strengthen",
  "strengthens",
  "strengthened",
  "expand",
  "expands",
  "expanded",
  "shrink",
  "shrinks",
  "shrank",
  "stabilize",
  "stabilizes",
  "stabilized",
  "speed",
  "speeds",
  "sped",
  "slow",
  "slows",
  "slowed",
  "shift",
  "shifts",
  "shifted",
  "block",
  "blocks",
  "blocked",
  "enable",
  "enables",
  "enabled",
  "undermine",
  "undermines",
  "undermined",
  "protect",
  "protects",
  "protected",
  "worsen",
  "worsens",
  "worsened",
  "ease",
  "eases",
  "eased",
  "lift",
  "lifts",
  "lifted",
  "delay",
  "delays",
  "delayed",
  "require",
  "requires",
  "required"
]);

const MODAL_STARTERS = new Set([
  "can",
  "could",
  "may",
  "might",
  "should",
  "would",
  "will",
  "must"
]);

const QUALIFIER_FRAGMENT_STARTERS = new Set([
  "especially",
  "particularly",
  "mainly",
  "mostly",
  "only",
  "when",
  "if",
  "unless",
  "where",
  "while",
  "provided",
  "assuming",
  "because",
  "since",
  "although",
  "despite",
  "except",
  "including",
  "with",
  "without",
  "under",
  "across",
  "near"
]);

function tokenizeForSimilarity(value: string) {
  return uniqueIds(
    normalizeWhitespace(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3)
  );
}

function findLastIndex<T>(
  values: T[],
  predicate: (value: T, index: number) => boolean
) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!, index)) {
      return index;
    }
  }

  return -1;
}

function titlesLikelyMatch(left: string, right: string) {
  const leftTokens = tokenizeForSimilarity(left);
  const rightTokens = tokenizeForSimilarity(right);

  return (
    jaccardSimilarity(leftTokens, rightTokens) >= 0.6 ||
    overlapScore(leftTokens, rightTokens) >= 0.75
  );
}

function startsWithPredicateStarter(value: string) {
  const tokens = stripFragmentLeadIns(value).split(/\s+/);
  const firstWord = cleanWord(tokens[0] ?? "");

  return SHARED_PREDICATE_STARTERS.has(firstWord);
}

function startsWithQualifierFragment(value: string) {
  const tokens = stripFragmentLeadIns(value).split(/\s+/);
  const firstWord = cleanWord(tokens[0] ?? "");

  return QUALIFIER_FRAGMENT_STARTERS.has(firstWord);
}

function extractSharedClausePrefix(input: string) {
  const tokens = normalizeWhitespace(input).split(/\s+/);
  const firstPredicateIndex = tokens.findIndex((token) =>
    SHARED_PREDICATE_STARTERS.has(cleanWord(token))
  );

  if (firstPredicateIndex < 1) {
    return null;
  }

  return normalizeWhitespace(tokens.slice(0, firstPredicateIndex).join(" "));
}

function materializeStandaloneSummaryClause(input: {
  fragment: string;
  sharedPrefix: string;
}) {
  let normalized = stripFragmentLeadIns(input.fragment);

  if (!normalized || startsWithQualifierFragment(normalized)) {
    return null;
  }

  const modalFragmentMatch = normalized.match(
    /^(?<modal>can|could|may|might|should|would|will|must)\s+(?<rest>.+)$/i
  );

  if (
    modalFragmentMatch?.groups?.rest &&
    MODAL_STARTERS.has(cleanWord(modalFragmentMatch.groups.modal)) &&
    startsWithPredicateStarter(modalFragmentMatch.groups.rest)
  ) {
    normalized = modalFragmentMatch.groups.rest;
  }

  const pronounFragmentMatch = normalized.match(
    /^(?:it|they|this|that|these|those)\s+(?:can|could|may|might|should|would|will|must)\s+(?<rest>.+)$/i
  );

  if (
    pronounFragmentMatch?.groups?.rest &&
    startsWithPredicateStarter(pronounFragmentMatch.groups.rest)
  ) {
    normalized = pronounFragmentMatch.groups.rest;
  }

  if (startsWithPredicateStarter(normalized)) {
    return normalizeTitleLead(`${input.sharedPrefix} ${normalized}`);
  }

  const tokens = normalized.split(/\s+/);
  const firstPredicateIndex = tokens.findIndex((token) =>
    SHARED_PREDICATE_STARTERS.has(cleanWord(token))
  );

  if (firstPredicateIndex >= 1 && firstPredicateIndex <= 3) {
    return normalizeTitleLead(normalized);
  }

  return null;
}

function extractSummaryStandaloneClauses(summary: string) {
  const normalized = normalizeWhitespace(summary).replace(/[.!?]+$/, "");

  if (!normalized) {
    return [];
  }

  const fragments = normalized
    .split(/\s*(?:,|;|\band\b|\bbut\b|\bwhile\b)\s*/i)
    .map((fragment) => normalizeWhitespace(fragment))
    .filter(Boolean);

  if (fragments.length < 2) {
    return [];
  }

  const sharedPrefix = extractSharedClausePrefix(fragments[0] ?? "");

  if (!sharedPrefix) {
    return [];
  }

  const standaloneClauses = uniqueStrings(
    fragments
      .map((fragment, index) => {
        if (index === 0) {
          return normalizeTitleLead(fragment);
        }

        return materializeStandaloneSummaryClause({
          fragment,
          sharedPrefix
        });
      })
      .filter((clause): clause is string => Boolean(clause))
  ).filter((clause) => wordCount(clause) >= 4 && wordCount(clause) <= 14);

  return standaloneClauses.length >= 2 ? standaloneClauses : [];
}

function isBroadSummaryWrapperTitle(title: string) {
  const normalized = normalizeWhitespace(title).toLowerCase();

  if (!normalized) {
    return false;
  }

  if (
    /\b(mixed\s+(effects|outcomes|results|impact|impacts)|benefits?\s+and\s+drawbacks?|pros?\s+and\s+cons?|trade[- ]?offs?)\b/i.test(
      normalized
    )
  ) {
    return true;
  }

  const titleTokens = tokenizeForSimilarity(normalized);
  const hasPredicate = normalizeWhitespace(title)
    .split(/\s+/)
    .some((token) => SHARED_PREDICATE_STARTERS.has(cleanWord(token)));

  return (
    !hasPredicate &&
    titleTokens.some((token) =>
      ["effects", "outcomes", "impact", "impacts", "tradeoff", "tradeoffs"].includes(
        token
      )
    )
  );
}

function isUsefulCoordinatedClaimPair(pair: CoordinatedClaimPair | null) {
  if (!pair) {
    return false;
  }

  return pair.primaryTitle !== pair.secondaryTitle;
}

function getLeadingObjectRelation(value: string) {
  return (
    normalizeWhitespace(value).match(
      /^(by|through|with|via|from|for|against|because of|due to)\b/i
    )?.[0] ?? null
  );
}

function normalizeCoordinatedRightObject(input: {
  firstObject: string;
  right: string;
}) {
  const relation = getLeadingObjectRelation(input.firstObject);

  if (!relation || getLeadingObjectRelation(input.right)) {
    return input.right;
  }

  return normalizeWhitespace(`${relation} ${input.right}`);
}

function extractCoordinatedClaimPair(input: string): CoordinatedClaimPair | null {
  const normalized = normalizeWhitespace(input).replace(/[.!?]+$/, "");
  const coordinatedMatch = normalized.match(
    /^(?<left>.+)\s+(?<connector>and|but|while)\s+(?<right>.+)$/i
  );

  if (!coordinatedMatch?.groups?.left || !coordinatedMatch?.groups?.right) {
    return null;
  }

  const left = normalizeWhitespace(coordinatedMatch.groups.left);
  const right = normalizeWhitespace(coordinatedMatch.groups.right);
  const connector = coordinatedMatch.groups.connector.toLowerCase() as CoordinatedClaimPair["connector"];
  const rightFirstWord = cleanWord(right.split(/\s+/)[0] ?? "");

  if (
    wordCount(left) < 4 ||
    wordCount(right) < 1 ||
    wordCount(right) > 8
  ) {
    return null;
  }

  const sharedModalMatch = left.match(
    /^(?<shared>.+?\b(?:can|could|may|might|should|would|will|must)\b)\s+(?<first>.+)$/i
  );

  if (
    sharedModalMatch?.groups?.shared &&
    sharedModalMatch.groups.first &&
    SHARED_PREDICATE_STARTERS.has(rightFirstWord)
  ) {
    const shared = normalizeWhitespace(sharedModalMatch.groups.shared);
    const first = normalizeWhitespace(sharedModalMatch.groups.first);

    if (wordCount(first) >= 2) {
      return {
        connector,
        primaryTitle: normalizeTitleLead(`${shared} ${first}`),
        secondaryTitle: normalizeTitleLead(`${shared} ${right}`)
      };
    }
  }

  const leftTokens = left.split(/\s+/);
  const firstPredicateIndex = leftTokens.findIndex((token) =>
    SHARED_PREDICATE_STARTERS.has(cleanWord(token))
  );
  const lastPredicateIndex = findLastIndex(leftTokens, (token) =>
    SHARED_PREDICATE_STARTERS.has(cleanWord(token))
  );
  const rightStartsWithPredicate = SHARED_PREDICATE_STARTERS.has(rightFirstWord);

  if (firstPredicateIndex >= 1 && rightStartsWithPredicate) {
    const subject = normalizeWhitespace(
      leftTokens.slice(0, firstPredicateIndex).join(" ")
    );

    if (wordCount(subject) >= 1) {
      return {
        connector,
        primaryTitle: normalizeTitleLead(left),
        secondaryTitle: normalizeTitleLead(`${subject} ${right}`)
      };
    }
  }

  if (lastPredicateIndex >= 2 && !rightStartsWithPredicate) {
    const sharedPrefix = normalizeWhitespace(
      leftTokens.slice(0, lastPredicateIndex + 1).join(" ")
    );
    const firstObject = normalizeWhitespace(
      leftTokens.slice(lastPredicateIndex + 1).join(" ")
    );

    if (
      wordCount(firstObject) >= 1 &&
      wordCount(firstObject) <= 6 &&
      wordCount(sharedPrefix) >= 3
    ) {
      const secondaryObject = normalizeCoordinatedRightObject({
        firstObject,
        right
      });

      return {
        connector,
        primaryTitle: normalizeTitleLead(`${sharedPrefix} ${firstObject}`),
        secondaryTitle: normalizeTitleLead(`${sharedPrefix} ${secondaryObject}`)
      };
    }
  }

  return null;
}

function extractClaimTitleFeatures(input: string): ClaimTitleFeatures {
  const normalized = normalizeWhitespace(input);
  const qualifiers: string[] = [];

  const leadingMatch = normalized.match(
    /^(?<qualifier>(?:in|for|among|across|under|with|without|near|outside)\b[^,;:]+),\s*(?<title>.+)$/i
  );

  let candidateTitle = normalized;

  if (leadingMatch?.groups?.title && leadingMatch?.groups?.qualifier) {
    const leadingTitle = normalizeWhitespace(leadingMatch.groups.title);
    const leadingQualifier = normalizeWhitespace(leadingMatch.groups.qualifier);

    if (wordCount(leadingTitle) >= 3 && wordCount(leadingQualifier) >= 2) {
      candidateTitle = leadingTitle;
      qualifiers.push(leadingQualifier);
    }
  }

  const candidatePatterns = [
    /^(?<title>.+?)\s*\((?<qualifier>[^()]+)\)$/i,
    /^(?<title>.+?),\s*(?<qualifier>(especially|particularly|mainly|mostly|provided|assuming|except|unless|when|if|where|while)\b.+)$/i,
    /^(?<title>.+?)\s+(?<qualifier>(when|if|unless|where|while|provided|assuming)\b.+)$/i,
    /^(?<title>.+?)\s+(?:and|but)\s+(?<qualifier>(especially|particularly|mainly|mostly|only|modest|limited|mixed|uneven|partial|conditional)\b.+)$/i
  ];

  for (const pattern of candidatePatterns) {
    const match = candidateTitle.match(pattern);
    const title = normalizeWhitespace(match?.groups?.title ?? "");
    const qualifier = normalizeWhitespace(match?.groups?.qualifier ?? "");

    if (!title || !qualifier) {
      continue;
    }

    if (wordCount(title) < 3 || wordCount(qualifier) < 2) {
      continue;
    }

    candidateTitle = title;
    qualifiers.push(qualifier);
    break;
  }

  const coordinatedPair = extractCoordinatedClaimPair(candidateTitle);

  return {
    title: coordinatedPair?.primaryTitle ?? normalizeTitleLead(candidateTitle),
    qualifiers,
    coordinatedPair: isUsefulCoordinatedClaimPair(coordinatedPair)
      ? coordinatedPair
      : null
  };
}

function extractSummaryFeatures(summary: string): SummaryFeatures {
  const normalized = normalizeWhitespace(summary);
  const summaryWithoutTerminalPunctuation = normalized.replace(/[.!?]+$/, "");
  const qualifiers: string[] = [];
  const inlineQualifierPattern =
    /(?:,|;)\s*(?<qualifier>(especially|particularly|mainly|mostly|provided|assuming|unless|when|if|where|while)\b[^.;]+)/gi;

  for (const match of summaryWithoutTerminalPunctuation.matchAll(
    inlineQualifierPattern
  )) {
    const qualifier = normalizeWhitespace(match.groups?.qualifier ?? "");

    if (wordCount(qualifier) >= 2) {
      qualifiers.push(qualifier);
    }
  }

  const trailingMatch = summaryWithoutTerminalPunctuation.match(
    /(?<qualifier>(when|if|unless|where|while|provided|assuming)\b[^.;]+)$/i
  );
  const trailingQualifier = normalizeWhitespace(
    trailingMatch?.groups?.qualifier ?? ""
  );

  if (trailingQualifier && wordCount(trailingQualifier) >= 2) {
    qualifiers.push(trailingQualifier);
  }

  const coordinatedPair = extractCoordinatedClaimPair(
    summaryWithoutTerminalPunctuation
  );

  return {
    qualifiers: uniqueStrings(qualifiers),
    coordinatedPair: isUsefulCoordinatedClaimPair(coordinatedPair)
      ? coordinatedPair
      : null
  };
}

function overlapScore(left: string[], right: string[]) {
  if (!left.length || !right.length) {
    return 0;
  }

  const rightSet = new Set(right);
  const sharedCount = left.filter((value) => rightSet.has(value)).length;

  return sharedCount / Math.min(left.length, right.length);
}

function jaccardSimilarity(left: string[], right: string[]) {
  if (!left.length || !right.length) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let sharedCount = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      sharedCount += 1;
    }
  }

  const unionSize = new Set([...leftSet, ...rightSet]).size;

  return unionSize ? sharedCount / unionSize : 0;
}

function claimAtomicityPenalty(value: string) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  let penalty = 0;

  if (/[;,/:]/.test(normalized)) {
    penalty += 1;
  }

  if (
    /\b(and|or|while|but|because|although|whereas|when|if|unless|where)\b/.test(
      normalized
    )
  ) {
    penalty += 1;
  }

  penalty += Math.max(0, tokenizeForSimilarity(normalized).length - 8) * 0.1;

  return penalty;
}

function pickMoreAtomicTitle(left: string, right: string) {
  const leftPenalty = claimAtomicityPenalty(left);
  const rightPenalty = claimAtomicityPenalty(right);

  if (leftPenalty !== rightPenalty) {
    return leftPenalty < rightPenalty ? left : right;
  }

  return left.length <= right.length ? left : right;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function evidenceQualityRank(value: ClaimUnit["evidenceQuality"]) {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

const TRADEOFF_QUESTION_STOPWORDS = new Set([
  "should",
  "could",
  "would",
  "companies",
  "company",
  "teams",
  "team",
  "people",
  "prioritize",
  "choose",
  "between",
  "default",
  "favor"
]);

const TRADEOFF_COUNTERCLAIM_MARKERS = [
  /\bno universal\b/i,
  /\bno single (?:priority|winner|answer)\b/i,
  /\bnot (?:universally|always|inherently)\b/i,
  /\bcontext[- ]dependent\b/i,
  /\bdepends on\b/i,
  /\bcase[- ]by[- ]case\b/i,
  /\bregulation[- ]conditional\b/i,
  /\btrade[- ]off\b/i,
  /\bcontext matters\b/i
];

function isTradeoffQuestion(question: string) {
  return /\b(or|vs\.?|versus)\b/i.test(question);
}

function extractTradeoffQuestionTokens(question: string) {
  return tokenizeForSimilarity(question).filter(
    (token) => !TRADEOFF_QUESTION_STOPWORDS.has(token)
  );
}

function buildClaimQuestionOverlapScore(
  claim: ClaimUnit,
  questionTokens: string[]
) {
  if (!questionTokens.length) {
    return 0;
  }

  const claimTokens = tokenizeForSimilarity(
    [
      claim.title,
      claim.summary,
      claim.topic,
      ...claim.qualifiers
    ].join(" ")
  );

  return clamp01(
    overlapScore(claimTokens, questionTokens) * 0.75 +
      jaccardSimilarity(claimTokens, questionTokens) * 0.25
  );
}

function countTradeoffMetaMarkers(claim: ClaimUnit) {
  const text = normalizeWhitespace(
    [claim.title, claim.summary, ...claim.qualifiers].join(" ")
  ).toLowerCase();

  return TRADEOFF_COUNTERCLAIM_MARKERS.filter((pattern) => pattern.test(text))
    .length;
}

function isTradeoffMetaCounterclaim(claim: ClaimUnit) {
  if (
    claim.kind !== "counterclaim" ||
    !["mixed", "unknown"].includes(claim.stance)
  ) {
    return false;
  }

  return countTradeoffMetaMarkers(claim) > 0;
}

function buildTradeoffMetaCounterclaimScore(claim: ClaimUnit) {
  return clamp01(
    countTradeoffMetaMarkers(claim) * 0.24 +
      clamp01(claim.confidence) * 0.34 +
      Math.min(0.22, claim.snippetIds.length * 0.11) +
      Math.min(0.2, claim.sourceIds.length * 0.1)
  );
}

function buildTradeoffSideClaimScore(
  claim: ClaimUnit,
  questionTokens: string[]
) {
  return clamp01(
    buildClaimQuestionOverlapScore(claim, questionTokens) * 0.42 +
      clamp01(claim.confidence) * 0.24 +
      (evidenceQualityRank(claim.evidenceQuality) / 3) * 0.18 +
      Math.min(0.1, claim.snippetIds.length * 0.05) +
      Math.min(0.06, claim.sourceIds.length * 0.03)
  );
}

function makeInferredContradictionPairId(leftClaimId: string, rightClaimId: string) {
  const normalized = `pair_inferred_${leftClaimId}_${rightClaimId}`
    .replace(/[^a-z0-9_]+/gi, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length <= 80
    ? normalized
    : normalized.slice(0, 80).replace(/_+$/g, "");
}

function inferTradeoffCounterclaimPair(input: {
  question: string;
  claims: ClaimUnit[];
}): ContradictionPair | null {
  if (!isTradeoffQuestion(input.question)) {
    return null;
  }

  const questionTokens = extractTradeoffQuestionTokens(input.question);

  if (!questionTokens.length) {
    return null;
  }

  const metaCounterclaims = input.claims.filter(isTradeoffMetaCounterclaim);

  if (!metaCounterclaims.length) {
    return null;
  }

  let bestPair:
    | {
        leftClaim: ClaimUnit;
        rightClaim: ClaimUnit;
        score: number;
        contradictionStrength: number;
      }
    | null = null;

  for (const rightClaim of metaCounterclaims) {
    const metaScore = buildTradeoffMetaCounterclaimScore(rightClaim);

    for (const leftClaim of input.claims) {
      if (
        leftClaim.id === rightClaim.id ||
        leftClaim.kind !== "claim" ||
        !["pro", "con"].includes(leftClaim.stance)
      ) {
        continue;
      }

      const questionOverlap = buildClaimQuestionOverlapScore(
        leftClaim,
        questionTokens
      );

      if (questionOverlap < 0.12) {
        continue;
      }

      const sideClaimScore = buildTradeoffSideClaimScore(
        leftClaim,
        questionTokens
      );
      const topicAlignment = overlapScore(
        tokenizeForSimilarity(leftClaim.topic),
        tokenizeForSimilarity(rightClaim.topic)
      );
      const gapAlignment = overlapScore(
        uniqueIds(leftClaim.dependsOnGapIds),
        uniqueIds(rightClaim.dependsOnGapIds)
      );
      const pairScore = clamp01(
        questionOverlap * 0.36 +
          metaScore * 0.3 +
          sideClaimScore * 0.26 +
          topicAlignment * 0.05 +
          gapAlignment * 0.03
      );

      if (pairScore < 0.45) {
        continue;
      }

      const contradictionStrength = clamp01(
        0.46 +
          questionOverlap * 0.18 +
          metaScore * 0.14 +
          sideClaimScore * 0.1 +
          topicAlignment * 0.05 +
          gapAlignment * 0.03
      );

      if (!bestPair || pairScore > bestPair.score) {
        bestPair = {
          leftClaim,
          rightClaim,
          score: pairScore,
          contradictionStrength
        };
      }
    }
  }

  if (!bestPair) {
    return null;
  }

  return {
    id: makeInferredContradictionPairId(
      bestPair.leftClaim.id,
      bestPair.rightClaim.id
    ),
    leftClaimId: bestPair.leftClaim.id,
    rightClaimId: bestPair.rightClaim.id,
    contradictionStrength: bestPair.contradictionStrength,
    explanation: normalizeWhitespace(
      `${bestPair.leftClaim.title} argues for one side of the tradeoff, while ${bestPair.rightClaim.title} keeps the answer context-dependent rather than universal.`
    )
  };
}

export function stabilizeClaimInventory(
  claimInventory: ClaimInventory
): ClaimInventory {
  if (claimInventory.contradictionPairs.length > 0) {
    return claimInventory;
  }

  const inferredPair = inferTradeoffCounterclaimPair({
    question: claimInventory.question,
    claims: claimInventory.claims
  });

  if (!inferredPair) {
    return claimInventory;
  }

  return {
    ...claimInventory,
    contradictionPairs: [inferredPair]
  };
}

function mergeEvidenceQuality(
  left: ClaimUnit["evidenceQuality"],
  right: ClaimUnit["evidenceQuality"]
) {
  return evidenceQualityRank(left) >= evidenceQualityRank(right) ? left : right;
}

function pickLongerText(left: string, right: string) {
  return left.length >= right.length ? left : right;
}

function normalizeDerivedClaimSummary(value: string) {
  const normalized = normalizeWhitespace(value).replace(/[.!?]+$/, "");

  return normalizeTitleLead(normalized);
}

function normalizeClaimTitleKey(value: string) {
  return extractClaimTitleFeatures(value).title.toLowerCase();
}

function shouldSplitTitleCoordinatedPair(pair: CoordinatedClaimPair | null) {
  return Boolean(
    pair &&
      wordCount(pair.primaryTitle) >= 4 &&
      wordCount(pair.secondaryTitle) >= 4
  );
}

function shouldSplitSummaryCoordinatedPair(input: {
  title: string;
  pair: CoordinatedClaimPair | null;
}) {
  if (!input.pair) {
    return false;
  }

  if (input.pair.connector === "and") {
    return false;
  }

  return titlesLikelyMatch(input.title, input.pair.primaryTitle);
}

function shouldSplitSummaryStandaloneClauses(input: {
  title: string;
  clauses: string[];
}) {
  if (input.clauses.length < 2 || input.clauses.length > 3) {
    return false;
  }

  if (input.clauses.some((clause) => wordCount(clause) < 4)) {
    return false;
  }

  const broadWrapperTitle = isBroadSummaryWrapperTitle(input.title);

  if (broadWrapperTitle) {
    return true;
  }

  if (input.clauses.length === 2) {
    return false;
  }

  return titlesLikelyMatch(input.title, input.clauses[0] ?? "");
}

function makeSplitClaimId(claimId: string, suffix: string) {
  const normalizedSuffix =
    suffix.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() ||
    "split";
  const availablePrefixLength = Math.max(1, 80 - normalizedSuffix.length - 2);

  return `${claimId.slice(0, availablePrefixLength)}__${normalizedSuffix}`;
}

function buildClaimKey(claim: Pick<ClaimUnit, "kind" | "stance" | "title" | "topic">) {
  const normalizedTitle = extractClaimTitleFeatures(claim.title).title;

  return [
    claim.kind,
    claim.stance,
    normalizedTitle.toLowerCase(),
    normalizeWhitespace(claim.topic).toLowerCase()
  ].join("|");
}

function normalizeClaimKind(rawClaim: RawClaimInventory["claims"][number]) {
  if (rawClaim.kind === "counterclaim" || rawClaim.stance === "con") {
    return "counterclaim" as const;
  }

  return "claim" as const;
}

function createNormalizedClaimCandidates(input: {
  rawClaim: RawClaimInventory["claims"][number];
  snippetIds: string[];
  sourceIds: string[];
  canonicalGapIds: string[];
}) {
  const claimId = input.rawClaim.id.trim();
  const normalizedSummary = normalizeWhitespace(input.rawClaim.summary);
  const normalizedTopic = normalizeWhitespace(input.rawClaim.topic);
  const titleFeatures = extractClaimTitleFeatures(input.rawClaim.title);
  const summaryFeatures = extractSummaryFeatures(normalizedSummary);
  const summaryStandaloneClauses = extractSummaryStandaloneClauses(
    normalizedSummary
  );
  const titleSplitPair = shouldSplitTitleCoordinatedPair(titleFeatures.coordinatedPair)
    ? titleFeatures.coordinatedPair
    : null;
  const summaryStandaloneSplitTitles =
    !titleSplitPair &&
    shouldSplitSummaryStandaloneClauses({
      title: titleFeatures.title,
      clauses: summaryStandaloneClauses
    })
      ? summaryStandaloneClauses
      : [];
  const summarySplitPair = shouldSplitSummaryCoordinatedPair({
    title: titleFeatures.title,
    pair: summaryFeatures.coordinatedPair
  })
    && !summaryStandaloneSplitTitles.length
    ? summaryFeatures.coordinatedPair
    : null;
  const primarySplitTitle =
    titleSplitPair?.primaryTitle ??
    summaryStandaloneSplitTitles[0] ??
    summarySplitPair?.primaryTitle;
  const secondarySplitTitles = titleSplitPair
    ? [titleSplitPair.secondaryTitle]
    : summaryStandaloneSplitTitles.length
      ? summaryStandaloneSplitTitles.slice(1)
      : summarySplitPair?.secondaryTitle
        ? [summarySplitPair.secondaryTitle]
        : [];
  const coordinatedQualifiers = uniqueStrings([
    ...(titleFeatures.coordinatedPair && !titleSplitPair
      ? [titleFeatures.coordinatedPair.secondaryTitle]
      : []),
    ...(summaryFeatures.coordinatedPair &&
    !summarySplitPair &&
    !titleSplitPair &&
    !summaryStandaloneSplitTitles.length
      ? [summaryFeatures.coordinatedPair.secondaryTitle]
      : [])
  ]);
  const sharedQualifiers = uniqueStrings([
    ...input.rawClaim.qualifiers,
    ...titleFeatures.qualifiers,
    ...summaryFeatures.qualifiers,
    ...coordinatedQualifiers
  ]);
  const splitGroupId =
    titleSplitPair || summarySplitPair || summaryStandaloneSplitTitles.length
      ? claimId
      : undefined;
  const normalizedKind = normalizeClaimKind(input.rawClaim);
  let primarySummary = normalizedSummary;
  const primaryTitle =
    summaryStandaloneSplitTitles.length && isBroadSummaryWrapperTitle(titleFeatures.title)
      ? primarySplitTitle ?? titleFeatures.title
      : titleFeatures.title;

  if (
    primarySplitTitle &&
    (summaryStandaloneSplitTitles.length > 0 ||
      (summarySplitPair &&
        titlesLikelyMatch(titleFeatures.title, summarySplitPair.primaryTitle)))
  ) {
    primarySummary = normalizeDerivedClaimSummary(primarySplitTitle);
  }

  const candidates: NormalizedClaimCandidate[] = [
    {
      id: claimId,
      rawClaimId: claimId,
      splitGroupId,
      kind: normalizedKind,
      title: primaryTitle,
      summary: primarySummary,
      topic: normalizedTopic,
      stance: input.rawClaim.stance,
      confidence: clamp01(input.rawClaim.confidence),
      evidenceQuality: input.rawClaim.evidenceQuality,
      sourceIds: input.sourceIds,
      snippetIds: input.snippetIds,
      qualifiers: sharedQualifiers,
      dependsOnGapIds: input.canonicalGapIds
    }
  ];
  if (!secondarySplitTitles.length) {
    return candidates;
  }

  secondarySplitTitles.forEach((secondaryTitle, index) => {
    const alignedSummarySecondary =
      summarySplitPair &&
      titlesLikelyMatch(secondaryTitle, summarySplitPair.secondaryTitle)
        ? normalizeDerivedClaimSummary(summarySplitPair.secondaryTitle)
        : normalizeDerivedClaimSummary(secondaryTitle);

    candidates.push({
      id: makeSplitClaimId(
        claimId,
        titleSplitPair
          ? "split_secondary"
          : summaryStandaloneSplitTitles.length
            ? `split_summary_${index + 1}`
            : "split_summary"
      ),
      rawClaimId: claimId,
      splitGroupId,
      kind: normalizedKind,
      title: secondaryTitle,
      summary: alignedSummarySecondary,
      topic: normalizedTopic,
      stance: input.rawClaim.stance,
      confidence: clamp01(input.rawClaim.confidence),
      evidenceQuality: input.rawClaim.evidenceQuality,
      sourceIds: input.sourceIds,
      snippetIds: input.snippetIds,
      qualifiers: sharedQualifiers,
      dependsOnGapIds: input.canonicalGapIds
    });
  });

  return candidates;
}

function isMergeableClaim(input: {
  existingClaim: ClaimUnit;
  existingSplitGroupId?: string;
  nextClaim: Pick<
    ClaimUnit,
    "kind" | "stance" | "title" | "summary" | "topic" | "snippetIds" | "sourceIds"
  >;
  nextSplitGroupId?: string;
}) {
  if (
    input.existingClaim.kind !== input.nextClaim.kind ||
    input.existingClaim.stance !== input.nextClaim.stance
  ) {
    return false;
  }

  if (
    (input.existingSplitGroupId || input.nextSplitGroupId) &&
    normalizeClaimTitleKey(input.existingClaim.title) !==
      normalizeClaimTitleKey(input.nextClaim.title)
  ) {
    return false;
  }

  const topicSimilarity = overlapScore(
    tokenizeForSimilarity(input.existingClaim.topic),
    tokenizeForSimilarity(input.nextClaim.topic)
  );
  const titleSimilarity = jaccardSimilarity(
    tokenizeForSimilarity(extractClaimTitleFeatures(input.existingClaim.title).title),
    tokenizeForSimilarity(extractClaimTitleFeatures(input.nextClaim.title).title)
  );
  const propositionSimilarity = jaccardSimilarity(
    tokenizeForSimilarity(
      `${extractClaimTitleFeatures(input.existingClaim.title).title} ${input.existingClaim.summary}`
    ),
    tokenizeForSimilarity(
      `${extractClaimTitleFeatures(input.nextClaim.title).title} ${input.nextClaim.summary}`
    )
  );
  const snippetSimilarity = overlapScore(
    input.existingClaim.snippetIds,
    input.nextClaim.snippetIds
  );
  const sourceSimilarity = overlapScore(
    input.existingClaim.sourceIds,
    input.nextClaim.sourceIds
  );

  if (topicSimilarity < 0.8) {
    return false;
  }

  return (
    titleSimilarity >= 0.8 ||
    propositionSimilarity >= 0.75 ||
    (snippetSimilarity >= 0.5 && propositionSimilarity >= 0.7) ||
    (titleSimilarity >= 0.65 && sourceSimilarity >= 0.5)
  );
}

function buildGapKey(gap: RawClaimInventory["unresolvedGaps"][number]) {
  return [gap.gapType, normalizeWhitespace(gap.title).toLowerCase()].join("|");
}

function normalizeSnippetIds(
  snippetIds: string[],
  snippetById: Map<string, EvidencePack["snippets"][number]>
) {
  return uniqueIds(snippetIds).filter((snippetId) => snippetById.has(snippetId));
}

function normalizeSourceIds(input: {
  sourceIds: string[];
  snippetIds: string[];
  sourceById: Map<string, EvidencePack["sources"][number]>;
  snippetById: Map<string, EvidencePack["snippets"][number]>;
}) {
  const directSourceIds = uniqueIds(input.sourceIds).filter((sourceId) =>
    input.sourceById.has(sourceId)
  );
  const derivedSourceIds = input.snippetIds
    .map((snippetId) => input.snippetById.get(snippetId)?.sourceId ?? "")
    .filter(Boolean);

  return uniqueIds([...directSourceIds, ...derivedSourceIds]);
}

function pruneQualifiersRepresentedByPeerClaims(claims: ClaimUnit[]) {
  return claims.map((claim) => ({
    ...claim,
    qualifiers: claim.qualifiers.filter((qualifier) => {
      const qualifierTokens = tokenizeForSimilarity(qualifier);

      if (qualifierTokens.length < 3) {
        return true;
      }

      return !claims.some((peer) => {
        if (
          peer.id === claim.id ||
          peer.kind !== claim.kind ||
          peer.stance !== claim.stance
        ) {
          return false;
        }

        const peerTitle = extractClaimTitleFeatures(peer.title).title;
        const peerTitleTokens = tokenizeForSimilarity(peerTitle);
        const topicSimilarity = overlapScore(
          tokenizeForSimilarity(claim.topic),
          tokenizeForSimilarity(peer.topic)
        );
        const titleSimilarity = jaccardSimilarity(qualifierTokens, peerTitleTokens);
        const titleContainment = overlapScore(qualifierTokens, peerTitleTokens);

        return (
          topicSimilarity >= 0.75 &&
          (titleSimilarity >= 0.8 || titleContainment >= 1)
        );
      });
    })
  }));
}

export function buildClaimExtractionPrompt(question: string, evidencePack: EvidencePack) {
  return [
    `Question: ${question}`,
    "",
    "EvidencePack:",
    JSON.stringify(evidencePack, null, 2),
    "",
    "Generate a ClaimInventory.",
    "Focus on the strongest, most decision-relevant claims.",
    "Keep the inventory compact enough to become a readable graph."
  ].join("\n");
}

export function buildClaimExtractionInstructions(input?: {
  maxClaims?: number;
  maxGaps?: number;
}) {
  const maxClaimsText = input?.maxClaims ?? FULL_CLAIM_INVENTORY_LIMITS.maxClaims;
  const maxGapsText = input?.maxGaps ?? FULL_CLAIM_INVENTORY_LIMITS.maxGaps;

  return [
    "You are the contradiction analyst for ClaimGraph.",
    "You will be given an EvidencePack containing sources and snippets.",
    "Your job is to infer the smallest useful set of atomic claims, counterclaims, contradiction pairs, and unresolved gaps.",
    "Hard rules:",
    "1. Every claim must be grounded in one or more snippetIds from the EvidencePack.",
    "2. Do not create a claim if the evidence is too weak to justify it.",
    "3. Split broad umbrella statements into atomic claims.",
    "4. Claim titles should contain only the core debatable proposition. If a sentence contains multiple outcomes or effects, emit separate claims when they can stand on their own.",
    "5. When a claim says one intervention both helps and hurts different outcomes, emit separate claims for those outcomes instead of burying one side in a qualifier.",
    "6. When two coordinated effects share the same subject but answer different evaluation axes, prefer two sibling claims over one broad title with 'and', 'but', or 'while'.",
    "7. If you need to keep one node compact, keep the title to one proposition and move scope limits, secondary implementation caveats, and context conditions into qualifiers.",
    "8. Do not let a summary re-bundle multiple top-level outcomes after you already split them into separate claims.",
    "9. Distinguish 'refutes' from 'qualifies'. A qualifier narrows or conditions another claim without fully opposing it.",
    "10. Emit contradiction pairs only when two grounded claims answer the same decision axis with genuinely opposing implications.",
    "11. If a point mainly adds a condition, downside, implementation constraint, or uncertainty, prefer a qualifier or gap node instead of a contradiction pair.",
    "12. Create gap nodes when resolution depends on missing context, missing evidence, or mixed evidence.",
    "13. Confidence is confidence in graph placement and grounding, not truth.",
    "14. Avoid duplicate claims unless they represent distinct frames.",
    "15. Prefer clarity over completeness. The graph must remain human-readable.",
    "16. Merge wording variants that point to the same grounded proposition instead of emitting near-duplicates.",
    "17. Prefer the shortest title that still preserves one atomic claim.",
    `18. Keep the output compact. Stay within ${maxClaimsText} claims/counterclaims and ${maxGapsText} gaps unless the evidence is too weak to emit that many grounded units.`,
    "19. Return results as JSON only."
  ].join("\n");
}

export function buildClaimInventory(input: {
  question: string;
  evidencePack: EvidencePack;
  rawInventory: RawClaimInventory;
}): ClaimInventory {
  const snippetById = new Map(
    input.evidencePack.snippets.map((snippet) => [snippet.id, snippet])
  );
  const sourceById = new Map(
    input.evidencePack.sources.map((source) => [source.id, source])
  );
  const gapKeyToCanonicalId = new Map<string, string>();
  const gapIdAliases = new Map<string, string>();
  const gapById = new Map<string, GapUnit>();

  for (const rawGap of input.rawInventory.unresolvedGaps) {
    const snippetIds = normalizeSnippetIds(rawGap.snippetIds, snippetById);
    const sourceIds = normalizeSourceIds({
      sourceIds: rawGap.sourceIds,
      snippetIds,
      sourceById,
      snippetById
    });

    if (!snippetIds.length || !sourceIds.length) {
      continue;
    }

    const gapId = rawGap.id.trim();
    const key = buildGapKey(rawGap);
    const existingGapId = gapKeyToCanonicalId.get(key);

    if (existingGapId) {
      const existingGap = gapById.get(existingGapId)!;
      existingGap.summary = pickLongerText(
        existingGap.summary,
        normalizeWhitespace(rawGap.summary)
      );
      existingGap.sourceIds = uniqueIds([...existingGap.sourceIds, ...sourceIds]);
      existingGap.snippetIds = uniqueIds([
        ...existingGap.snippetIds,
        ...snippetIds
      ]);
      existingGap.importance = Math.max(
        existingGap.importance,
        clamp01(rawGap.importance)
      );
      gapById.set(existingGapId, existingGap);
      gapIdAliases.set(gapId, existingGapId);
      continue;
    }

    const nextGap: GapUnit = {
      id: gapId,
      title: normalizeWhitespace(rawGap.title),
      summary: normalizeWhitespace(rawGap.summary),
      gapType: rawGap.gapType,
      sourceIds,
      snippetIds,
      importance: clamp01(rawGap.importance)
    };

    gapKeyToCanonicalId.set(key, gapId);
    gapIdAliases.set(gapId, gapId);
    gapById.set(gapId, nextGap);
  }

  const canonicalGapIds = new Set(gapById.keys());
  const claimKeyToCanonicalId = new Map<string, string>();
  const claimIdAliases = new Map<string, string>();
  const claimById = new Map<string, ClaimUnit>();
  const claimSplitGroupById = new Map<string, string | undefined>();

  for (const rawClaim of input.rawInventory.claims) {
    const snippetIds = normalizeSnippetIds(rawClaim.snippetIds, snippetById);
    const sourceIds = normalizeSourceIds({
      sourceIds: rawClaim.sourceIds,
      snippetIds,
      sourceById,
      snippetById
    });

    if (!snippetIds.length || !sourceIds.length) {
      continue;
    }

    const canonicalGapIdsForClaim = uniqueIds(
      rawClaim.dependsOnGapIds
        .map((gapId) => gapIdAliases.get(gapId.trim()) ?? gapId.trim())
        .filter((gapId) => canonicalGapIds.has(gapId))
    );
    const claimId = rawClaim.id.trim();
    let canonicalRawClaimId: string | null = null;

    for (const candidate of createNormalizedClaimCandidates({
      rawClaim,
      snippetIds,
      sourceIds,
      canonicalGapIds: canonicalGapIdsForClaim
    })) {
      const key = buildClaimKey(candidate);
      const existingClaimId =
        claimKeyToCanonicalId.get(key) ??
        Array.from(claimById.entries()).find(([, existingClaim]) =>
          isMergeableClaim({
            existingClaim,
            existingSplitGroupId: claimSplitGroupById.get(existingClaim.id),
            nextClaim: candidate,
            nextSplitGroupId: candidate.splitGroupId
          })
        )?.[0];

      if (existingClaimId) {
        const existingClaim = claimById.get(existingClaimId)!;
        existingClaim.title = pickMoreAtomicTitle(existingClaim.title, candidate.title);
        existingClaim.summary = pickLongerText(existingClaim.summary, candidate.summary);
        existingClaim.topic = pickLongerText(existingClaim.topic, candidate.topic);
        existingClaim.confidence = Math.max(
          existingClaim.confidence,
          candidate.confidence
        );
        existingClaim.evidenceQuality = mergeEvidenceQuality(
          existingClaim.evidenceQuality,
          candidate.evidenceQuality
        );
        existingClaim.sourceIds = uniqueIds([
          ...existingClaim.sourceIds,
          ...candidate.sourceIds
        ]);
        existingClaim.snippetIds = uniqueIds([
          ...existingClaim.snippetIds,
          ...candidate.snippetIds
        ]);
        existingClaim.qualifiers = uniqueStrings([
          ...existingClaim.qualifiers,
          ...candidate.qualifiers
        ]);
        existingClaim.dependsOnGapIds = uniqueIds([
          ...existingClaim.dependsOnGapIds,
          ...candidate.dependsOnGapIds
        ]);
        claimById.set(existingClaimId, existingClaim);
        claimSplitGroupById.set(
          existingClaimId,
          claimSplitGroupById.get(existingClaimId) ?? candidate.splitGroupId
        );
        claimKeyToCanonicalId.set(key, existingClaimId);
        claimIdAliases.set(candidate.id, existingClaimId);

        if (candidate.id === claimId && !canonicalRawClaimId) {
          canonicalRawClaimId = existingClaimId;
        }

        continue;
      }

      const nextClaim: ClaimUnit = {
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        topic: candidate.topic,
        stance: candidate.stance,
        confidence: candidate.confidence,
        evidenceQuality: candidate.evidenceQuality,
        sourceIds: candidate.sourceIds,
        snippetIds: candidate.snippetIds,
        qualifiers: candidate.qualifiers,
        dependsOnGapIds: candidate.dependsOnGapIds
      };

      claimKeyToCanonicalId.set(key, candidate.id);
      claimIdAliases.set(candidate.id, candidate.id);
      claimById.set(candidate.id, nextClaim);
      claimSplitGroupById.set(candidate.id, candidate.splitGroupId);

      if (candidate.id === claimId && !canonicalRawClaimId) {
        canonicalRawClaimId = candidate.id;
      }
    }

    if (canonicalRawClaimId) {
      claimIdAliases.set(claimId, canonicalRawClaimId);
    }
  }

  const claims = pruneQualifiersRepresentedByPeerClaims(
    Array.from(claimById.values()).map((claim) => ({
      ...claim,
      dependsOnGapIds: uniqueIds(claim.dependsOnGapIds).filter((gapId) =>
        canonicalGapIds.has(gapId)
      )
    }))
  )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.kind.localeCompare(right.kind) ||
        left.title.localeCompare(right.title)
    );
  const canonicalClaimIds = new Set(claims.map((claim) => claim.id));
  const contradictionByKey = new Map<string, ContradictionPair>();

  for (const rawPair of input.rawInventory.contradictionPairs) {
    const leftClaimId = claimIdAliases.get(rawPair.leftClaimId.trim());
    const rightClaimId = claimIdAliases.get(rawPair.rightClaimId.trim());

    if (
      !leftClaimId ||
      !rightClaimId ||
      leftClaimId === rightClaimId ||
      !canonicalClaimIds.has(leftClaimId) ||
      !canonicalClaimIds.has(rightClaimId)
    ) {
      continue;
    }

    const key = [leftClaimId, rightClaimId].sort().join("|");
    const normalizedExplanation = normalizeWhitespace(rawPair.explanation);
    const existingPair = contradictionByKey.get(key);

    if (existingPair) {
      existingPair.contradictionStrength = Math.max(
        existingPair.contradictionStrength,
        clamp01(rawPair.contradictionStrength)
      );
      existingPair.explanation = pickLongerText(
        existingPair.explanation,
        normalizedExplanation
      );
      contradictionByKey.set(key, existingPair);
      continue;
    }

    contradictionByKey.set(key, {
      id: rawPair.id.trim(),
      leftClaimId,
      rightClaimId,
      contradictionStrength: clamp01(rawPair.contradictionStrength),
      explanation: normalizedExplanation
    });
  }

  const contradictionPairs = Array.from(contradictionByKey.values()).sort(
    (left, right) =>
      right.contradictionStrength - left.contradictionStrength ||
      left.id.localeCompare(right.id)
  );
  const unresolvedGaps = Array.from(gapById.values()).sort(
    (left, right) =>
      right.importance - left.importance || left.title.localeCompare(right.title)
  );
  const question =
    normalizeWhitespace(input.rawInventory.question) || input.question;

  return stabilizeClaimInventory({
    question,
    claims,
    contradictionPairs,
    unresolvedGaps
  });
}
