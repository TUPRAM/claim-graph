"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { DevLoginForm } from "@/components/dev/DevLoginForm";

interface DevSessionState {
  authenticated: boolean;
  configured: boolean;
}

export function DevEntry() {
  const pathname = usePathname();
  const [session, setSession] = useState<DevSessionState>({
    authenticated: false,
    configured: true
  });
  const [isOpen, setIsOpen] = useState(false);

  const label = "Dev";

  useEffect(() => {
    let canceled = false;

    async function loadSession() {
      try {
        const response = await fetch("/api/session/dev", { cache: "no-store" });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as DevSessionState;

        if (!canceled) {
          setSession(payload);
        }
      } catch {
        // The button still opens a login form if session probing fails.
      }
    }

    void loadSession();

    return () => {
      canceled = true;
    };
  }, []);

  function onButtonClick() {
    if (session.authenticated) {
      window.location.assign("/dev");
      return;
    }

    setIsOpen(true);
  }

  if (pathname?.startsWith("/dev")) {
    return null;
  }

  const buttonClassName = [
    "dev-entry-button",
    pathname === "/" ? "dev-entry-button--minimal" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        className={buttonClassName}
        type="button"
        onClick={onButtonClick}
        aria-haspopup="dialog"
        aria-label={session.authenticated ? "Open developer panel" : "Open developer login"}
      >
        <span className="dev-entry-button__desktop">{label}</span>
        <span className="dev-entry-button__mobile">Dev</span>
      </button>

      {isOpen ? (
        <div className="dev-entry-dialog-backdrop" role="presentation" onMouseDown={() => setIsOpen(false)}>
          <section
            className="dev-entry-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dev-entry-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="section-header">
              <div>
                <p className="eyebrow">Developer mode</p>
                <h2 id="dev-entry-title">Internal tools</h2>
                <p className="muted">
                  Runtime readiness, alpha feedback, run logs, raw evidence,
                  and cleanup details live in the protected developer lane.
                </p>
              </div>
              <button
                className="button button--ghost button--small"
                type="button"
                onClick={() => setIsOpen(false)}
              >
                Close
              </button>
            </div>
            {session.configured ? (
              <DevLoginForm compact />
            ) : (
              <p className="error-text">
                Developer mode is not configured. Set DEV_MODE_PASSWORD_HASH and
                DEV_MODE_SESSION_SECRET on the server.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
