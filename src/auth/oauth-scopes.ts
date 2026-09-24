export const HOSTSPAN_OAUTH_SCOPE_READ = "hostspan.read";
export const HOSTSPAN_OAUTH_SCOPE_WRITE = "hostspan.write";
export const HOSTSPAN_OAUTH_SCOPE_EXEC = "hostspan.exec";
export const HOSTSPAN_OAUTH_SCOPE_TERMINAL = "hostspan.terminal";

export const HOSTSPAN_OAUTH_SCOPES = [
  HOSTSPAN_OAUTH_SCOPE_READ,
  HOSTSPAN_OAUTH_SCOPE_WRITE,
  HOSTSPAN_OAUTH_SCOPE_EXEC,
  HOSTSPAN_OAUTH_SCOPE_TERMINAL,
] as const;

export type HostSpanOAuthScope = (typeof HOSTSPAN_OAUTH_SCOPES)[number];

const supportedScopes = new Set<string>(HOSTSPAN_OAUTH_SCOPES);

export function splitOAuthScopes(scope: string): string[] {
  return [...new Set(scope.trim().split(/\s+/).filter(Boolean))];
}

export function isSupportedHostSpanOAuthScope(value: string): boolean {
  return supportedScopes.has(value);
}

export function oauthScopesGrant(grantedScopes: readonly string[], requiredScope: HostSpanOAuthScope): boolean {
  return grantedScopes.includes(requiredScope);
}

export function oauthScopeCanNarrow(grantedScope: string, requestedScope: string): boolean {
  const granted = splitOAuthScopes(grantedScope);
  const requested = splitOAuthScopes(requestedScope);
  if (requested.length === 0) return false;
  if (requested.some((item) => !isSupportedHostSpanOAuthScope(item))) return false;
  if (granted.some((item) => !isSupportedHostSpanOAuthScope(item))) return false;

  const grantedSet = new Set(granted);
  return requested.every((item) => grantedSet.has(item));
}
