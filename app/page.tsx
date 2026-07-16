import Link from "next/link";
import Image from "next/image";
import { getClaimGraphRuntimeConfig, getClaimGraphRuntimeInfo } from "@/lib/claimgraph/config";
import { QuestionComposer } from "@/components/workspace/QuestionComposer";
import { DEFAULT_DEMO_QUESTION } from "@/lib/demo/graph-template";
import { publicBetaPrivacyCopy } from "@/lib/server/public-beta-policy";
import { isHostedFullModeFileIntakeBlocked } from "@/lib/server/provider-file-retention";

export const dynamic = "force-dynamic";

const exampleQuestions = [
  "Should cities ban cars downtown?",
  "Should schools start later?",
  "Should companies require office days?"
];

export default async function HomePage() {
  const runtime = getClaimGraphRuntimeInfo();
  const runtimeConfig = getClaimGraphRuntimeConfig();
  const supportsFileIntake = !isHostedFullModeFileIntakeBlocked({
    mode: runtime.mode
  });
  const manualSourceLabel = runtime.supportsUrlIntake
    ? supportsFileIntake ? "links or files" : "public links"
    : supportsFileIntake ? "files" : null;
  const intakeDescription = manualSourceLabel
    ? `Ask a contested question. Add ${manualSourceLabel} when you want stronger grounding.`
    : runtime.supportsWebSearch
      ? "Ask a contested question. ClaimGraph can search the public web for grounding."
      : "Ask a contested question to create an argument map you can inspect.";

  return (
    <main className="landing-shell landing-shell--minimal">
      <aside className="minimal-public-rail" aria-label="ClaimGraph navigation">
        <Link href="/" className="minimal-rail__brand" aria-label="ClaimGraph home">
          <Image
            src="/brand/claimgraph-mark.svg"
            alt=""
            width={34}
            height={34}
            priority
          />
        </Link>
      </aside>

      <Link href="/workspace/demo" className="minimal-home__demo-link">
        Open demo
      </Link>

      <section className="minimal-home" aria-labelledby="minimal-home-title">
        <div className="minimal-home__center" id="map-question">
          <p className="minimal-home__brand">ClaimGraph</p>
          <h1 id="minimal-home-title">What disagreement should we map?</h1>
          <p className="minimal-home__lede">{intakeDescription}</p>
          <QuestionComposer
            variant="command"
            defaultQuestion={DEFAULT_DEMO_QUESTION}
            runtime={{
              supportsUrlIntake: runtime.supportsUrlIntake,
              supportsWebSearch: runtime.supportsWebSearch,
              supportsFileIntake
            }}
            defaultSettings={runtimeConfig.defaultWorkspaceSettings}
            exampleQuestions={exampleQuestions}
            privacyNotice={publicBetaPrivacyCopy()}
          />
        </div>
      </section>
    </main>
  );
}
