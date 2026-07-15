import type { BrowserFallbackAdapter } from "@/lib/open-model/retrieval/types";

export class PlaywrightBrowserFallbackAdapter
  implements BrowserFallbackAdapter
{
  readonly kind = "browser-fallback" as const;

  async fetchRenderedPage(_url: string): Promise<never> {
    throw new Error(
      "Browser fallback scaffolding exists, but rendered-page retrieval is disabled for this block."
    );
  }
}
