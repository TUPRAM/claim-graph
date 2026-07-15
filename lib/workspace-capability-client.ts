"use client";

export const WORKSPACE_WRITE_CAPABILITY_HEADER =
  "x-claimgraph-write-capability";

function bytesToBase64Url(bytes: Uint8Array) {
  let value = "";

  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }

  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createClientWorkspaceWriteCapability() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
