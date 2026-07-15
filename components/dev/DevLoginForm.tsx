"use client";

import { useState, type FormEvent } from "react";

export function DevLoginForm({
  redirectTo = "/dev",
  compact = false
}: {
  redirectTo?: string;
  compact?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/session/dev", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Unable to start developer session.");
      }

      window.location.assign(redirectTo);
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : "Unable to start developer session."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className={`dev-login-form${compact ? " dev-login-form--compact" : ""}`} onSubmit={onSubmit}>
      <label className="field">
        <span className="field__label">Developer password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          placeholder="Enter password"
          disabled={isSubmitting}
        />
      </label>
      {error ? <p className="error-text">{error}</p> : null}
      <button
        type="submit"
        className="button button--primary button--small"
        disabled={isSubmitting || !password}
      >
        {isSubmitting ? "Checking..." : "Open dev lane"}
      </button>
    </form>
  );
}
