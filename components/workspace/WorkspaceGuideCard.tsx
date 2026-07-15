export function WorkspaceGuideCard({
  starterMode
}: {
  starterMode: boolean;
}) {
  return (
    <section className="content-card workspace-guide-card">
      <div className="section-header">
        <div>
          <p className="eyebrow">How to read this graph</p>
          <h2>Interpretation guide</h2>
        </div>
      </div>

      <div className="workspace-guide-card__grid">
        <article>
          <h3>Claim</h3>
          <p>A claim is one contestable proposition the evidence can support directly.</p>
        </article>
        <article>
          <h3>Counterclaim</h3>
          <p>A counterclaim is meaningful opposition, not just a softer wording of the same branch.</p>
        </article>
        <article>
          <h3>Gap</h3>
          <p>A gap marks what still blocks a stronger conclusion, such as missing context or mixed evidence.</p>
        </article>
        <article>
          <h3>Confidence</h3>
          <p>Confidence is grounding and placement confidence, not a truth label.</p>
        </article>
      </div>

      <div className="workspace-guide-card__callout">
        <p className="muted">
          {starterMode
            ? "This workspace is currently showing the curated safe path. Treat it as a graph shell and honesty fallback, not as proof that a live run succeeded."
            : "Start with the strongest disagreement, then inspect citations and gaps before trusting the graph as decision support."}
        </p>
      </div>
    </section>
  );
}
