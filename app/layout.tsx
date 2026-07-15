import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { DevEntry } from "@/components/dev/DevEntry";
import { ensureAnalysisRuntimeBootstrapped } from "@/lib/server/analyze-runner";
import { isHostedStorageDriverSelected } from "@/lib/server/storage/config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://claim-graph.vercel.app"),
  applicationName: "ClaimGraph",
  title: "ClaimGraph | Visual argument mapping",
  description:
    "Graph-first analysis workspace for claims, counterclaims, evidence, gaps, and auditable provenance.",
  icons: {
    icon: "/icon.svg"
  },
  openGraph: {
    type: "website",
    siteName: "ClaimGraph",
    title: "ClaimGraph | Map the disagreement",
    description:
      "Turn difficult questions and source material into an inspectable map of claims, counterclaims, evidence, and unresolved gaps.",
    images: [
      {
        url: "/brand/github-social-preview.png",
        width: 1280,
        height: 640,
        alt: "ClaimGraph visual argument mapping"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "ClaimGraph | Map the disagreement",
    description:
      "Visual argument mapping with inspectable claims, counterclaims, evidence, provenance, and gaps.",
    images: ["/brand/github-social-preview.png"]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!isHostedStorageDriverSelected()) {
    ensureAnalysisRuntimeBootstrapped();
  }

  const showDevEntry = process.env.CLAIMGRAPH_SHOW_DEV_ENTRY === "true";

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        {showDevEntry ? <DevEntry /> : null}
      </body>
    </html>
  );
}
