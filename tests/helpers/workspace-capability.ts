export function getWorkspaceOwnerCookie(createResponse: Response) {
  const setCookie = createResponse.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];

  if (!cookie) {
    throw new Error("Workspace creation did not return an owner capability cookie.");
  }

  return cookie;
}

export function getWorkspaceOwnerMutationHeaders(
  createResponse: Response,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    Origin: new URL(createResponse.url || "http://localhost").origin,
    Cookie: getWorkspaceOwnerCookie(createResponse),
    ...(extra ?? {})
  };
}
