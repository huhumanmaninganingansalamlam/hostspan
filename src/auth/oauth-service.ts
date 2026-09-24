import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  HOSTSPAN_OAUTH_SCOPES,
  HOSTSPAN_OAUTH_SCOPE_READ,
  isSupportedHostSpanOAuthScope,
  oauthScopeCanNarrow,
  splitOAuthScopes,
} from "./oauth-scopes.js";
import type { OAuthConfig } from "../config/schema.js";
import type { OAuthAuthorizationRequestRecord, OAuthStore, OAuthTokenRecord } from "./oauth-store.js";


export class OAuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthHttpError";
  }
}

export class OAuthAuthorizationRedirectError extends Error {
  constructor(readonly redirect: string) {
    super("OAuth authorization response redirect");
    this.name = "OAuthAuthorizationRedirectError";
  }
}

export interface OAuthSetupResult {
  config: OAuthConfig;
  approval_secret: string;
}

export interface RegisteredOAuthClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  application_type: string;
  client_name?: string;
}

export interface AuthorizationPrompt {
  request_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scope: string;
  resource: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashApprovalSecret(secret: string, salt: string): Buffer {
  return scryptSync(secret, Buffer.from(salt, "base64url"), 32);
}

function normalizePublicMcpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/mcp" || url.search || url.hash) {
    throw new Error("OAuth public MCP URL must be HTTPS with the path exactly /mcp.");
  }
  return url.toString();
}

function normalizeScope(scope: string | undefined): string {
  if (!scope?.trim()) return HOSTSPAN_OAUTH_SCOPE_READ;
  return normalizeGrantedScope(scope);
}

function normalizeGrantedScope(scope: string): string {
  const unique = splitOAuthScopes(scope);
  if (unique.length === 0) throw new OAuthHttpError(400, "invalid_scope", "At least one HostSpan OAuth scope is required.");
  for (const item of unique) {
    if (!isSupportedHostSpanOAuthScope(item)) throw new OAuthHttpError(400, "invalid_scope", `Unsupported OAuth scope: ${item}`);
  }
  return unique.join(" ");
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function clientMetadata(record: { metadata_json: string }): RegisteredOAuthClient {
  return JSON.parse(record.metadata_json) as RegisteredOAuthClient;
}

function required(value: string | null | undefined, name: string): string {
  if (!value) throw new OAuthHttpError(400, "invalid_request", `Missing ${name}.`);
  return value;
}

function normalizeResource(value: string, expected: string): string {
  try {
    const normalized = new URL(value).toString();
    if (normalized !== expected) throw new Error("mismatch");
    return normalized;
  } catch {
    throw new OAuthHttpError(400, "invalid_target", "OAuth resource does not match this HostSpan MCP server.");
  }
}

export function createOAuthSetup(publicMcpUrl: string): OAuthSetupResult {
  const approvalSecret = randomToken(32);
  const salt = randomToken(16);
  return {
    config: {
      public_mcp_url: normalizePublicMcpUrl(publicMcpUrl),
      approval_secret_salt: salt,
      approval_secret_hash: hashApprovalSecret(approvalSecret, salt).toString("base64url"),
      access_token_ttl_minutes: 15,
      refresh_token_ttl_days: 30,
      authorization_code_ttl_seconds: 300,
      max_registered_clients: 100,
    },
    approval_secret: approvalSecret,
  };
}

export function rotateOAuthApprovalSecret(config: OAuthConfig): { config: OAuthConfig; approval_secret: string } {
  const approvalSecret = randomToken(32);
  const salt = randomToken(16);
  return {
    config: {
      ...config,
      approval_secret_salt: salt,
      approval_secret_hash: hashApprovalSecret(approvalSecret, salt).toString("base64url"),
    },
    approval_secret: approvalSecret,
  };
}

export class OAuthService {
  readonly publicMcpUrl: string;
  readonly issuer: string;
  readonly resourceMetadataUrl: string;

  constructor(
    readonly config: OAuthConfig,
    private readonly repo: OAuthStore,
  ) {
    this.publicMcpUrl = normalizePublicMcpUrl(config.public_mcp_url);
    this.issuer = new URL(`${new URL(this.publicMcpUrl).origin}/`).href;
    this.resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", this.issuer).href;
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: new URL("/authorize", this.issuer).href,
      token_endpoint: new URL("/token", this.issuer).href,
      registration_endpoint: new URL("/register", this.issuer).href,
      revocation_endpoint: new URL("/revoke", this.issuer).href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...HOSTSPAN_OAUTH_SCOPES],
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.publicMcpUrl,
      authorization_servers: [this.issuer],
      scopes_supported: [...HOSTSPAN_OAUTH_SCOPES],
      resource_name: "HostSpan MCP",
    };
  }

  registerClient(input: unknown): RegisteredOAuthClient {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new OAuthHttpError(400, "invalid_client_metadata", "Client metadata must be an object.");
    }
    const raw = input as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    this.repo.pruneExpired(now);
    while (this.repo.clientCount() >= this.config.max_registered_clients && this.repo.pruneOldestInactiveClient()) {
      // Bound public DCR storage without making an inactive-client flood a permanent lockout.
    }
    if (this.repo.clientCount() >= this.config.max_registered_clients) {
      throw new OAuthHttpError(429, "temporarily_unavailable", "OAuth client registration limit reached.");
    }
    const redirects = raw.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 16 || redirects.some((item) => typeof item !== "string" || !validRedirectUri(item))) {
      throw new OAuthHttpError(400, "invalid_client_metadata", "redirect_uris must contain valid HTTPS or loopback HTTP URLs.");
    }
    if (raw.token_endpoint_auth_method !== undefined && raw.token_endpoint_auth_method !== "none") {
      throw new OAuthHttpError(400, "invalid_client_metadata", "Only public OAuth clients using token_endpoint_auth_method=none are supported.");
    }
    const grantTypes = Array.isArray(raw.grant_types) ? raw.grant_types : ["authorization_code", "refresh_token"];
    if (grantTypes.some((item) => !["authorization_code", "refresh_token"].includes(String(item)))) {
      throw new OAuthHttpError(400, "invalid_client_metadata", "Unsupported grant type.");
    }
    const responseTypes = Array.isArray(raw.response_types) ? raw.response_types : ["code"];
    if (responseTypes.some((item) => item !== "code")) {
      throw new OAuthHttpError(400, "invalid_client_metadata", "Only response_type=code is supported.");
    }
    const applicationType = typeof raw.application_type === "string" ? raw.application_type : "web";
    if (!["web", "native"].includes(applicationType)) {
      throw new OAuthHttpError(400, "invalid_client_metadata", "application_type must be web or native.");
    }
    const metadata: RegisteredOAuthClient = {
      client_id: `hostspan-${randomUUID()}`,
      client_id_issued_at: now,
      redirect_uris: redirects as string[],
      token_endpoint_auth_method: "none",
      grant_types: [...new Set(grantTypes.map(String))],
      response_types: ["code"],
      application_type: applicationType,
      ...(typeof raw.client_name === "string" && raw.client_name.length <= 200 ? { client_name: raw.client_name } : {}),
    };
    this.repo.saveClient(metadata.client_id, metadata, now);
    return metadata;
  }

  beginAuthorization(params: URLSearchParams): AuthorizationPrompt {
    const now = Math.floor(Date.now() / 1000);
    this.repo.pruneExpired(now);
    const clientId = required(params.get("client_id"), "client_id");
    const redirectUri = required(params.get("redirect_uri"), "redirect_uri");
    const record = this.repo.getClient(clientId);
    if (!record) throw new OAuthHttpError(400, "unauthorized_client", "Unknown OAuth client.");
    const client = clientMetadata(record);
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthHttpError(400, "invalid_request", "redirect_uri is not registered for this client.");
    }
    let responseType: string;
    let codeChallenge: string;
    let codeChallengeMethod: string;
    let scope: string;
    let resource: string;
    try {
      responseType = required(params.get("response_type"), "response_type");
      codeChallenge = required(params.get("code_challenge"), "code_challenge");
      codeChallengeMethod = required(params.get("code_challenge_method"), "code_challenge_method");
      if (responseType !== "code") {
        throw new OAuthHttpError(400, "unsupported_response_type", "Only response_type=code is supported.");
      }
      if (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
        throw new OAuthHttpError(400, "invalid_request", "PKCE S256 is required.");
      }
      scope = normalizeScope(params.get("scope") ?? undefined);
      resource = normalizeResource(params.get("resource") ?? this.publicMcpUrl, this.publicMcpUrl);
    } catch (error) {
      if (error instanceof OAuthHttpError) {
        throw new OAuthAuthorizationRedirectError(
          this.authorizationErrorRedirect(redirectUri, params.get("state"), error.code, error.message),
        );
      }
      throw error;
    }
    const requestId = `hs_authreq_${randomToken(24)}`;
    const pending: OAuthAuthorizationRequestRecord = {
      request_id: requestId,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: params.get("state"),
      code_challenge: codeChallenge,
      resource,
      expires_at: now + this.config.authorization_code_ttl_seconds,
    };
    this.repo.saveAuthorizationRequest(pending);
    return {
      request_id: requestId,
      client_id: clientId,
      client_name: client.client_name ?? clientId,
      redirect_uri: redirectUri,
      scope,
      resource,
    };
  }

  approveAuthorization(requestId: string, approvalSecret: string): string {
    const now = Math.floor(Date.now() / 1000);
    const pending = this.repo.getAuthorizationRequest(requestId, now);
    if (!pending) throw new OAuthHttpError(400, "invalid_request", "Authorization request expired or does not exist.");
    if (!this.verifyApprovalSecret(approvalSecret)) {
      throw new OAuthAuthorizationRedirectError(
        this.authorizationErrorRedirect(pending.redirect_uri, pending.state, "access_denied", "Approval secret is incorrect."),
      );
    }
    const approved = this.repo.consumeAuthorizationRequest(requestId, now);
    if (!approved) {
      throw new OAuthHttpError(400, "invalid_request", "Authorization request expired, does not exist, or has already been approved.");
    }
    const code = `code-${randomUUID()}`;
    this.repo.saveAuthorizationCode({
      code_hash: tokenHash(code),
      client_id: approved.client_id,
      redirect_uri: approved.redirect_uri,
      scope: approved.scope,
      code_challenge: approved.code_challenge,
      resource: approved.resource,
      expires_at: now + this.config.authorization_code_ttl_seconds,
      used_at: null,
    });
    const redirect = new URL(approved.redirect_uri);
    redirect.searchParams.set("code", code);
    if (approved.state) redirect.searchParams.set("state", approved.state);
    return redirect.toString();
  }

  private authorizationErrorRedirect(
    redirectUri: string,
    state: string | null,
    code: string,
    description: string,
  ): string {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", code);
    redirect.searchParams.set("error_description", description);
    if (state) redirect.searchParams.set("state", state);
    return redirect.toString();
  }

  exchangeToken(form: URLSearchParams): OAuthTokenResponse {
    const grantType = required(form.get("grant_type"), "grant_type");
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(form);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(form);
    throw new OAuthHttpError(400, "unsupported_grant_type", "Unsupported OAuth grant type.");
  }

  revoke(rawToken: string): void {
    this.repo.revokeToken(tokenHash(rawToken), Math.floor(Date.now() / 1000));
  }

  verifyAccessToken(token: string) {
    const now = Math.floor(Date.now() / 1000);
    const record = this.repo.getAccessToken(tokenHash(token), now);
    if (!record || record.resource !== this.publicMcpUrl) return null;
    return {
      token,
      clientId: record.client_id,
      scopes: splitOAuthScopes(record.scope),
      expiresAt: record.expires_at,
      resource: record.resource,
    };
  }

  private verifyApprovalSecret(candidate: string): boolean {
    if (!candidate) return false;
    const actual = hashApprovalSecret(candidate, this.config.approval_secret_salt);
    const expected = Buffer.from(this.config.approval_secret_hash, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private exchangeAuthorizationCode(form: URLSearchParams): OAuthTokenResponse {
    const code = required(form.get("code"), "code");
    const clientId = required(form.get("client_id"), "client_id");
    const redirectUri = required(form.get("redirect_uri"), "redirect_uri");
    const verifier = required(form.get("code_verifier"), "code_verifier");
    const now = Math.floor(Date.now() / 1000);
    const codeHash = tokenHash(code);
    const record = this.repo.getAuthorizationCode(codeHash, now);
    if (!record || record.client_id !== clientId || record.redirect_uri !== redirectUri) {
      throw new OAuthHttpError(400, "invalid_grant", "Authorization code is invalid or expired.");
    }
    const scope = normalizeGrantedScope(record.scope);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== record.code_challenge) {
      throw new OAuthHttpError(400, "invalid_grant", "PKCE verification failed.");
    }
    if (form.get("resource")) normalizeResource(form.get("resource") ?? "", record.resource);
    if (!this.repo.markAuthorizationCodeUsed(codeHash, now)) {
      throw new OAuthHttpError(400, "invalid_grant", "Authorization code has already been used.");
    }
    return this.issueTokenPair(record.client_id, scope, record.resource, now);
  }

  private exchangeRefreshToken(form: URLSearchParams): OAuthTokenResponse {
    const refreshToken = required(form.get("refresh_token"), "refresh_token");
    const clientId = required(form.get("client_id"), "client_id");
    const now = Math.floor(Date.now() / 1000);
    const oldHash = tokenHash(refreshToken);
    const record = this.repo.getRefreshToken(oldHash, now);
    if (!record || record.client_id !== clientId) {
      throw new OAuthHttpError(400, "invalid_grant", "Refresh token is invalid or expired.");
    }
    if (form.get("resource")) normalizeResource(form.get("resource") ?? "", record.resource);
    let scope = normalizeGrantedScope(record.scope);
    if (form.get("scope")) {
      const requested = normalizeScope(form.get("scope") ?? undefined);
      if (!oauthScopeCanNarrow(record.scope, requested)) {
        throw new OAuthHttpError(400, "invalid_scope", "Refresh cannot increase scopes.");
      }
      scope = requested;
    }
    const replacementRaw = `hs_refresh_${randomToken(40)}`;
    const replacement: OAuthTokenRecord = {
      token_hash: tokenHash(replacementRaw),
      client_id: clientId,
      scope,
      resource: record.resource,
      expires_at: now + this.config.refresh_token_ttl_days * 86400,
      revoked_at: null,
    };
    if (!this.repo.rotateRefreshToken(oldHash, replacement, now)) {
      throw new OAuthHttpError(400, "invalid_grant", "Refresh token has already been used.");
    }
    return this.issueAccessToken(clientId, scope, record.resource, now, replacementRaw);
  }

  private issueTokenPair(clientId: string, scope: string, resource: string, now: number): OAuthTokenResponse {
    const refreshRaw = `hs_refresh_${randomToken(40)}`;
    this.repo.saveRefreshToken({
      token_hash: tokenHash(refreshRaw),
      client_id: clientId,
      scope,
      resource,
      expires_at: now + this.config.refresh_token_ttl_days * 86400,
      revoked_at: null,
    });
    return this.issueAccessToken(clientId, scope, resource, now, refreshRaw);
  }

  private issueAccessToken(clientId: string, scope: string, resource: string, now: number, refreshRaw: string): OAuthTokenResponse {
    const accessRaw = `hs_access_${randomToken(32)}`;
    const expiresIn = this.config.access_token_ttl_minutes * 60;
    this.repo.saveAccessToken({
      token_hash: tokenHash(accessRaw),
      client_id: clientId,
      scope,
      resource,
      expires_at: now + expiresIn,
      revoked_at: null,
    });
    return {
      access_token: accessRaw,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshRaw,
      scope,
    };
  }
}
