"use client";

import { useState } from "react";

export function DevLogoutButton() {
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function logout() {
    setIsLoggingOut(true);

    try {
      await fetch("/api/session/dev", {
        method: "DELETE"
      });
    } finally {
      window.location.assign("/");
    }
  }

  return (
    <button
      type="button"
      className="button button--ghost button--small"
      onClick={() => void logout()}
      disabled={isLoggingOut}
    >
      {isLoggingOut ? "Logging out..." : "Log out"}
    </button>
  );
}
