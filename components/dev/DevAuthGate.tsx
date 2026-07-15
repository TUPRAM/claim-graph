import Link from "next/link";
import { DevLoginForm } from "@/components/dev/DevLoginForm";

export function DevAuthGate() {
  return (
    <main className="workspace-shell dev-shell">
      <section className="content-card dev-auth-card">
        <p className="eyebrow">Developer mode</p>
        <h1>Internal tools require a session.</h1>
        <p className="muted">
          Use the developer password to open runtime readiness, alpha feedback,
          run diagnostics, raw evidence packs, claim inventory, hosted health,
          and cleanup details.
        </p>
        <DevLoginForm />
        <div className="hero-actions">
          <Link href="/" className="button button--ghost button--small">
            Back to public site
          </Link>
        </div>
      </section>
    </main>
  );
}
