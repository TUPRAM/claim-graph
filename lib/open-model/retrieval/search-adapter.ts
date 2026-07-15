import type { DeterministicRetrievalResult, SearchAdapter } from "@/lib/open-model/retrieval/types";

export class SearxngSearchAdapter implements SearchAdapter {
  readonly kind = "search" as const;

  async search(_query: string): Promise<DeterministicRetrievalResult> {
    throw new Error(
      "Deterministic search scaffolding exists, but general search is not enabled in open-model mode for this block."
    );
  }
}
