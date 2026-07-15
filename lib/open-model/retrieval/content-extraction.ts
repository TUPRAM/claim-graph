import type {
  ContentExtractionAdapter,
  ExtractedTextBlock
} from "@/lib/open-model/retrieval/types";

export const MAX_EXTRACTED_URL_TEXT_CHARS = 24_000;

const HTML_SCAN_LIMITS = {
  maxMarkupTokens: 100_000,
  maxRetainedTextChars: MAX_EXTRACTED_URL_TEXT_CHARS * 4,
  maxTagNameChars: 128,
  maxAttributesPerTag: 256,
  maxAttributeNameChars: 128,
  maxMetadataValueChars: MAX_EXTRACTED_URL_TEXT_CHARS
} as const;

const HTML_SUPPRESSED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "header",
  "footer",
  "nav",
  "aside",
  "form",
  "button",
  "dialog",
  "iframe",
  "svg"
]);

const HTML_BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "td"
]);

export function normalizeWhitespace(value: string) {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasUsableReadableText(value: string) {
  const normalized = normalizeWhitespace(value);
  const words = normalized.match(/[A-Za-z0-9][A-Za-z0-9'/-]{1,}/g) ?? [];
  const letters = (normalized.match(/[A-Za-z]/g) ?? []).length;

  return normalized.length >= 50 && words.length >= 6 && letters >= 24;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d{2,7});/g, (_match, codepoint: string) => {
      const parsed = Number.parseInt(codepoint, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    })
    .replace(/&#x([0-9a-f]{2,6});/gi, (_match, codepoint: string) => {
      const parsed = Number.parseInt(codepoint, 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : "";
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

interface ScannedHtmlTag {
  end: number;
  name: string;
  attributesStart: number;
  closing: boolean;
  selfClosing: boolean;
  complete: boolean;
}

function isHtmlTagNameCharacter(value: string | undefined) {
  if (!value) {
    return false;
  }

  const code = value.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    value === ":" ||
    value === "_" ||
    value === "-"
  );
}

function isHtmlTagWhitespace(value: string | undefined) {
  return (
    value === " " ||
    value === "\t" ||
    value === "\r" ||
    value === "\n" ||
    value === "\f"
  );
}

function scanHtmlTag(input: string, start: number): ScannedHtmlTag {
  let end = start + 1;

  while (end < input.length && input[end] !== ">") {
    end += 1;
  }

  if (end >= input.length) {
    return {
      end: input.length,
      name: "",
      attributesStart: input.length,
      closing: false,
      selfClosing: false,
      complete: false
    };
  }

  let cursor = start + 1;

  while (cursor < end && isHtmlTagWhitespace(input[cursor])) {
    cursor += 1;
  }

  const closing = input[cursor] === "/";

  if (closing) {
    cursor += 1;
    while (cursor < end && isHtmlTagWhitespace(input[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  const nameLimit = Math.min(
    end,
    nameStart + HTML_SCAN_LIMITS.maxTagNameChars
  );

  while (cursor < nameLimit && isHtmlTagNameCharacter(input[cursor])) {
    cursor += 1;
  }

  const overlongName =
    cursor === nameLimit &&
    cursor < end &&
    isHtmlTagNameCharacter(input[cursor]);
  let suffix = end - 1;

  while (suffix > start && isHtmlTagWhitespace(input[suffix])) {
    suffix -= 1;
  }

  return {
    end: end + 1,
    name: overlongName ? "" : input.slice(nameStart, cursor).toLowerCase(),
    attributesStart: cursor,
    closing,
    selfClosing: input[suffix] === "/",
    complete: true
  };
}

function stripHtml(html: string) {
  const retainedParts: string[] = [];
  let retainedChars = 0;
  let cursor = 0;
  let markupTokens = 0;
  let suppressedElement: string | null = null;

  const retain = (value: string) => {
    if (!value || retainedChars >= HTML_SCAN_LIMITS.maxRetainedTextChars) {
      return;
    }

    const retained = value.slice(
      0,
      HTML_SCAN_LIMITS.maxRetainedTextChars - retainedChars
    );
    retainedParts.push(retained);
    retainedChars += retained.length;
  };

  while (
    cursor < html.length &&
    markupTokens < HTML_SCAN_LIMITS.maxMarkupTokens &&
    retainedChars < HTML_SCAN_LIMITS.maxRetainedTextChars
  ) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;

    if (textEnd > cursor && !suppressedElement) {
      retain(html.slice(cursor, textEnd));
    }

    if (tagStart === -1) {
      break;
    }

    const tag = scanHtmlTag(html, tagStart);
    markupTokens += 1;

    if (!tag.complete) {
      // Treat an unclosed markup suffix as markup and consume it once. This
      // prevents both content leakage and suffix-by-suffix regex retries.
      break;
    }

    if (suppressedElement) {
      if (tag.closing && tag.name === suppressedElement) {
        suppressedElement = null;
        retain(" ");
      }
    } else if (
      !tag.closing &&
      !tag.selfClosing &&
      HTML_SUPPRESSED_ELEMENTS.has(tag.name)
    ) {
      suppressedElement = tag.name;
      retain(" ");
    } else if (tag.closing && HTML_BLOCK_ELEMENTS.has(tag.name)) {
      retain("\n\n");
    } else if (!tag.closing && tag.name === "br") {
      retain("\n");
    } else {
      retain(" ");
    }

    cursor = tag.end;
  }

  return normalizeWhitespace(decodeHtmlEntities(retainedParts.join(""))).slice(
    0,
    MAX_EXTRACTED_URL_TEXT_CHARS
  );
}

interface SelectedHtmlAttributes {
  property?: string;
  name?: string;
  itemprop?: string;
  content?: string;
  datetime?: string;
}

const HTML_METADATA_ATTRIBUTE_NAMES = new Set<keyof SelectedHtmlAttributes>([
  "property",
  "name",
  "itemprop",
  "content",
  "datetime"
]);

const HTML_TITLE_METADATA_NAMES = new Set(["og:title", "twitter:title"]);
const HTML_PUBLISHED_METADATA_NAMES = new Set([
  "article:published_time",
  "og:published_time",
  "publishdate",
  "pubdate",
  "datepublished",
  "article:modified_time",
  "date"
]);

function scanSelectedHtmlAttributes(
  input: string,
  tag: ScannedHtmlTag
): SelectedHtmlAttributes {
  const attributes: SelectedHtmlAttributes = {};
  const tagEnd = tag.end - 1;
  let cursor = tag.attributesStart;
  let scannedAttributes = 0;

  while (
    cursor < tagEnd &&
    scannedAttributes < HTML_SCAN_LIMITS.maxAttributesPerTag
  ) {
    while (
      cursor < tagEnd &&
      (isHtmlTagWhitespace(input[cursor]) || input[cursor] === "/")
    ) {
      cursor += 1;
    }

    if (cursor >= tagEnd) {
      break;
    }

    const nameStart = cursor;

    while (
      cursor < tagEnd &&
      !isHtmlTagWhitespace(input[cursor]) &&
      input[cursor] !== "=" &&
      input[cursor] !== "/"
    ) {
      cursor += 1;
    }

    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }

    scannedAttributes += 1;
    const nameLength = cursor - nameStart;
    const attributeName =
      nameLength <= HTML_SCAN_LIMITS.maxAttributeNameChars
        ? input.slice(nameStart, cursor).toLowerCase()
        : "";

    while (cursor < tagEnd && isHtmlTagWhitespace(input[cursor])) {
      cursor += 1;
    }

    if (input[cursor] !== "=") {
      continue;
    }

    cursor += 1;
    while (cursor < tagEnd && isHtmlTagWhitespace(input[cursor])) {
      cursor += 1;
    }

    const quote = input[cursor];

    if (quote !== "\"" && quote !== "'") {
      while (cursor < tagEnd && !isHtmlTagWhitespace(input[cursor])) {
        cursor += 1;
      }
      continue;
    }

    const valueStart = cursor + 1;
    cursor = valueStart;

    while (cursor < tagEnd && input[cursor] !== quote) {
      cursor += 1;
    }

    if (cursor >= tagEnd) {
      break;
    }

    if (
      HTML_METADATA_ATTRIBUTE_NAMES.has(
        attributeName as keyof SelectedHtmlAttributes
      ) &&
      attributes[attributeName as keyof SelectedHtmlAttributes] === undefined
    ) {
      attributes[attributeName as keyof SelectedHtmlAttributes] = input.slice(
        valueStart,
        Math.min(
          cursor,
          valueStart + HTML_SCAN_LIMITS.maxMetadataValueChars
        )
      );
    }

    cursor += 1;
  }

  return attributes;
}

function extractHtmlMetadata(html: string) {
  let cursor = 0;
  let markupTokens = 0;
  let pendingTitleStart: number | null = null;
  let documentTitle: string | undefined;
  let metadataTitle: string | undefined;
  let metadataPublishedAt: string | undefined;
  let timePublishedAt: string | undefined;

  while (
    cursor < html.length &&
    markupTokens < HTML_SCAN_LIMITS.maxMarkupTokens
  ) {
    const tagStart = html.indexOf("<", cursor);

    if (tagStart === -1) {
      break;
    }

    const tag = scanHtmlTag(html, tagStart);
    markupTokens += 1;

    if (!tag.complete) {
      break;
    }

    if (
      pendingTitleStart !== null &&
      tag.closing &&
      tag.name === "title"
    ) {
      documentTitle = normalizeWhitespace(
        decodeHtmlEntities(
          html.slice(
            pendingTitleStart,
            Math.min(
              tagStart,
              pendingTitleStart + HTML_SCAN_LIMITS.maxMetadataValueChars
            )
          )
        )
      );
      pendingTitleStart = null;
    } else if (
      !tag.closing &&
      tag.name === "title" &&
      documentTitle === undefined
    ) {
      pendingTitleStart ??= tag.end;
    }

    if (!tag.closing && (tag.name === "meta" || tag.name === "time")) {
      const attributes = scanSelectedHtmlAttributes(html, tag);

      if (tag.name === "meta") {
        const titleMetadataName = [attributes.property, attributes.name]
          .map((value) => value?.toLowerCase())
          .find((value) => value && HTML_TITLE_METADATA_NAMES.has(value));

        if (
          metadataTitle === undefined &&
          titleMetadataName &&
          attributes.content !== undefined
        ) {
          metadataTitle = normalizeWhitespace(
            decodeHtmlEntities(attributes.content)
          );
        }

        const publishedMetadataName = [
          attributes.property,
          attributes.name,
          attributes.itemprop
        ]
          .map((value) => value?.toLowerCase())
          .find((value) => value && HTML_PUBLISHED_METADATA_NAMES.has(value));

        if (
          metadataPublishedAt === undefined &&
          publishedMetadataName &&
          attributes.content !== undefined
        ) {
          metadataPublishedAt = normalizeWhitespace(attributes.content);
        }
      } else if (
        timePublishedAt === undefined &&
        attributes.datetime !== undefined
      ) {
        timePublishedAt = normalizeWhitespace(attributes.datetime);
      }
    }

    cursor = tag.end;
  }

  return {
    title: metadataTitle || documentTitle,
    publishedAt: metadataPublishedAt || timePublishedAt
  };
}

function isHtmlContent(contentType?: string) {
  return contentType?.toLowerCase().includes("html") ?? false;
}

function isSupportedTextContent(contentType?: string) {
  if (!contentType) {
    return true;
  }

  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

export function buildTextBlocks(
  text: string,
  locationLabel?: string
): ExtractedTextBlock[] {
  const normalized = normalizeWhitespace(text);

  if (!normalized) {
    return [];
  }

  const rawSegments = normalized
    .split(/\n{2,}/)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);
  const segments = rawSegments.length ? rawSegments : [normalized];
  const blocks: ExtractedTextBlock[] = [];
  let searchOffset = 0;

  for (const segment of segments) {
    const offsetStart = normalized.indexOf(segment, searchOffset);
    const safeOffsetStart = offsetStart === -1 ? searchOffset : offsetStart;
    const offsetEnd = safeOffsetStart + segment.length;

    blocks.push({
      text: segment,
      offsetStart: safeOffsetStart,
      offsetEnd,
      ...(locationLabel ? { locationLabel } : {})
    });

    searchOffset = offsetEnd;
  }

  return blocks;
}

function tokenizeQuestion(value: string) {
  return new Set(
    normalizeWhitespace(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
}

function countWords(value: string) {
  return value.match(/[A-Za-z0-9][A-Za-z0-9'/-]{1,}/g)?.length ?? 0;
}

function isSourcePackMetadataBlock(value: string) {
  return /^(?:#{1,3}\s+)?(?:eval source pack\b|purpose:|question:|source basis:)/i.test(
    normalizeWhitespace(value)
  );
}

function isSourcePackEvidenceNote(value: string) {
  return /^evidence note \d+:/i.test(normalizeWhitespace(value));
}

function hasSourcePackOppositionSignal(value: string) {
  if (!isSourcePackEvidenceNote(value)) {
    return false;
  }

  return /\b(strongest disagreement|counterclaim|trade-?off|opposing branch|risk|barrier|challenge|downside|hinder|weaken|coordination|siloed|disruption)\b/i.test(
    value
  );
}

function hasSourcePackGapSignal(value: string) {
  if (!isSourcePackEvidenceNote(value)) {
    return false;
  }

  return /\b(unresolved gap|key unresolved|key gap|gap is|missing context|does not settle|not settle|organizational fit|implementation readiness|local implementation)\b/i.test(
    value
  );
}

function promoteCandidate(
  selected: Array<{
    text: string;
    offsetStart: number;
  }>,
  candidate:
    | {
        text: string;
        offsetStart: number;
        isMetadataBlock: boolean;
      }
    | undefined,
  protectedPredicates: Array<(candidate: { text: string }) => boolean>
) {
  if (!candidate) {
    return;
  }

  if (!selected.length) {
    return;
  }

  if (
    selected.some(
      (selectedCandidate) =>
        selectedCandidate.offsetStart === candidate.offsetStart &&
        selectedCandidate.text === candidate.text
    )
  ) {
    return;
  }

  let replacementIndex = -1;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const selectedCandidate = selected[index];
    if (!protectedPredicates.some((predicate) => predicate(selectedCandidate))) {
      replacementIndex = index;
      break;
    }
  }

  selected[replacementIndex === -1 ? selected.length - 1 : replacementIndex] =
    candidate;
}

export function selectRelevantTextBlockPassages(input: {
  question: string;
  blocks: ExtractedTextBlock[];
  maxPassages?: number;
  maxCharsPerPassage?: number;
}) {
  const questionTokens = tokenizeQuestion(input.question);
  const maxPassages = Math.max(1, input.maxPassages ?? 3);
  const maxCharsPerPassage = Math.max(120, input.maxCharsPerPassage ?? 320);
  const seen = new Set<string>();

  const candidates = input.blocks
    .map((block) => {
      const trimmedText = block.text.slice(0, maxCharsPerPassage);
      const segmentTokens = new Set(
        trimmedText
          .toLowerCase()
          .split(/[^a-z0-9]+/i)
          .filter((token) => token.length >= 4)
      );
      let overlap = 0;

      for (const token of questionTokens) {
        if (segmentTokens.has(token)) {
          overlap += 1;
        }
      }

      return {
        ...block,
        text: trimmedText,
        offsetEnd: block.offsetStart + trimmedText.length,
        overlap,
        lengthScore: Math.min(block.text.length, maxCharsPerPassage),
        wordCount: countWords(trimmedText),
        isMetadataBlock: isSourcePackMetadataBlock(trimmedText),
        hasSourcePackOppositionSignal: hasSourcePackOppositionSignal(trimmedText),
        hasSourcePackGapSignal: hasSourcePackGapSignal(trimmedText)
      };
    });
  const isSubstantiveCandidate = (candidate: (typeof candidates)[number]) =>
    candidate.text.length >= 80 &&
    candidate.wordCount >= 12 &&
    !candidate.isMetadataBlock;

  const sortedCandidates = candidates
    .filter((candidate) => candidate.text.length >= 40)
    .sort(
      (left, right) =>
        Number(isSubstantiveCandidate(right)) - Number(isSubstantiveCandidate(left)) ||
        Number(left.isMetadataBlock) - Number(right.isMetadataBlock) ||
        right.overlap - left.overlap ||
        right.lengthScore - left.lengthScore ||
        left.offsetStart - right.offsetStart
    )
    .filter((candidate) => {
      const key = `${candidate.offsetStart}:${candidate.text}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  const selectedCandidates = sortedCandidates.slice(0, maxPassages);

  if (maxPassages >= 3) {
    promoteCandidate(
      selectedCandidates,
      sortedCandidates.find((candidate) => candidate.hasSourcePackOppositionSignal),
      [(candidate) => hasSourcePackGapSignal(candidate.text)]
    );
    promoteCandidate(
      selectedCandidates,
      sortedCandidates.find((candidate) => candidate.hasSourcePackGapSignal),
      [(candidate) => hasSourcePackOppositionSignal(candidate.text)]
    );
  }

  return selectedCandidates
    .map((candidate) => ({
      text: candidate.text,
      offsetStart: candidate.offsetStart,
      offsetEnd: candidate.offsetEnd,
      ...(candidate.locationLabel ? { locationLabel: candidate.locationLabel } : {})
    }));
}

export class DefaultContentExtractionAdapter
  implements ContentExtractionAdapter
{
  readonly kind = "content-extraction" as const;

  extract(input: {
    url: string;
    contentType?: string;
    title?: string;
    bodyText: string;
  }) {
    if (isHtmlContent(input.contentType)) {
      const metadata = extractHtmlMetadata(input.bodyText);
      const title = metadata.title || input.title || input.url;
      const text = stripHtml(input.bodyText).slice(0, MAX_EXTRACTED_URL_TEXT_CHARS);
      const publishedAt = metadata.publishedAt;

      if (!hasUsableReadableText(text)) {
        return {
          title,
          text: "",
          blocks: [],
          warnings: [
            "The fetched page did not yield enough readable text for deterministic open-model grounding."
          ],
          ...(publishedAt ? { publishedAt } : {})
        };
      }

      return {
        title,
        text,
        blocks: buildTextBlocks(text),
        warnings: [],
        ...(publishedAt ? { publishedAt } : {})
      };
    }

    if (isSupportedTextContent(input.contentType)) {
      const text = normalizeWhitespace(input.bodyText).slice(
        0,
        MAX_EXTRACTED_URL_TEXT_CHARS
      );

      if (!hasUsableReadableText(text)) {
        return {
          title: input.title || input.url,
          text: "",
          blocks: [],
          warnings: ["The fetched document did not contain enough readable text content."]
        };
      }

      return {
        title: input.title || input.url,
        text,
        blocks: buildTextBlocks(text),
        warnings: []
      };
    }

    return {
      title: input.title || input.url,
      text: "",
      blocks: [],
      warnings: [
        `The fetched URL returned unsupported content type "${input.contentType || "unknown"}" for deterministic open-model extraction.`
      ]
    };
  }
}

export function selectRelevantPassages(input: {
  question: string;
  text: string;
  maxPassages?: number;
  maxCharsPerPassage?: number;
}) {
  const maxPassages = Math.max(1, input.maxPassages ?? 3);
  const maxCharsPerPassage = Math.max(120, input.maxCharsPerPassage ?? 320);
  const questionTokens = new Set(
    normalizeWhitespace(input.question)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
  const candidatePassages = normalizeWhitespace(input.text)
    .split(/\n{2,}/)
    .map((segment) => normalizeWhitespace(segment))
    .filter((segment) => segment.length >= 60);

  const rankedPassages = candidatePassages
    .map((segment) => {
      const segmentTokens = new Set(
        segment
          .toLowerCase()
          .split(/[^a-z0-9]+/i)
          .filter((token) => token.length >= 4)
      );
      let overlap = 0;

      for (const token of questionTokens) {
        if (segmentTokens.has(token)) {
          overlap += 1;
        }
      }

      return {
        text: segment.slice(0, maxCharsPerPassage),
        overlap,
        lengthScore: Math.min(segment.length, maxCharsPerPassage)
      };
    })
    .sort(
      (left, right) =>
        right.overlap - left.overlap || right.lengthScore - left.lengthScore
    );

  const selected = (rankedPassages.length ? rankedPassages : [
    {
      text: normalizeWhitespace(input.text).slice(0, maxCharsPerPassage),
      overlap: 0,
      lengthScore: Math.min(normalizeWhitespace(input.text).length, maxCharsPerPassage)
    }
  ])
    .filter((item) => item.text.length >= 40)
    .slice(0, maxPassages)
    .map((item) => item.text);

  return Array.from(new Set(selected));
}
