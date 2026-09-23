export const LEGACY_HOSTSPAN_OAUTH_SCOPE = "hostspan";

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

const granularScopes = new Set<string>(HOSTSPAN_OAUTH_SCOPES);

export function splitOAuthScopes(scope: string): string[] {
  return [...new Set(scope.trim().split(/\s+/).filter(Boolean))];
}

export function isGranularHostSpanOAuthScope(value: string): value is HostSpanOAuthScope {
  return granularScopes.has(value);
}

export function isSupportedHostSpanOAuthScope(value: string): boolean {
  return value === LEGACY_HOSTSPAN_OAUTH_SCOPE || isGranularHostSpanOAuthScope(value);
}

export function oauthScopesGrant(grantedScopes: readonly string[], requiredScope: HostSpanOAuthScope): boolean {
  return grantedScopes.includes(LEGACY_HOSTSPAN_OAUTH_SCOPE) || grantedScopes.includes(requiredScope);
}

export function oauthScopeCanNarrow(grantedScope: string, requestedScope: string): boolean {
  const granted = splitOAuthScopes(grantedScope);
  const requested = splitOAuthScopes(requestedScope);
  if (requested.length === 0) return false;

  if (requested.includes(LEGACY_HOSTSPAN_OAUTH_SCOPE)) {
    return requested.length === 1 && granted.includes(LEGACY_HOSTSPAN_OAUTH_SCOPE);
  }
  if (requested.some((item) => !isGranularHostSpanOAuthScope(item))) return false;
  if (granted.includes(LEGACY_HOSTSPAN_OAUTH_SCOPE)) return true;
  if (granted.some((item) => !isGranularHostSpanOAuthScope(item))) return false;

  const grantedSet = new Set(granted);
  return requested.every((item) => grantedSet.has(item));
}
