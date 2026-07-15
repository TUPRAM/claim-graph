import type { Snippet, Source, WorkspaceFile } from "@/types/claimgraph";

export interface DeterministicRetrievalResult {
  sources: Source[];
  snippets: Snippet[];
  warnings: string[];
}

export interface ExtractedTextBlock {
  text: string;
  offsetStart: number;
  offsetEnd: number;
  locationLabel?: string;
}

export interface SearchAdapter {
  readonly kind: "search";
  search(_query: string): Promise<DeterministicRetrievalResult>;
}

export interface UrlFetchAdapter {
  readonly kind: "url-fetch";
  fetch(url: string, signal?: AbortSignal): Promise<{
    url: string;
    resolvedUrl?: string;
    contentType?: string;
    title?: string;
    status: number;
    bodyText: string;
  }>;
}

export interface ContentExtractionAdapter {
  readonly kind: "content-extraction";
  extract(input: {
    url: string;
    contentType?: string;
    title?: string;
    bodyText: string;
  }): {
    title: string;
    text: string;
    blocks: ExtractedTextBlock[];
    warnings: string[];
    publishedAt?: string;
  };
}

export interface BrowserFallbackAdapter {
  readonly kind: "browser-fallback";
  fetchRenderedPage(_url: string): Promise<never>;
}

export interface FileIngestionAdapter {
  readonly kind: "file-ingestion";
  ingest(file: WorkspaceFile): Promise<DeterministicRetrievalResult>;
}
