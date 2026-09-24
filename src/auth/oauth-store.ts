export interface OAuthClientRecord {
  client_id: string;
  metadata_json: string;
  created_at: number;
}

export interface OAuthAuthorizationRequestRecord {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  expires_at: number;
}

export interface OAuthAuthorizationCodeRecord {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string;
  expires_at: number;
  used_at: number | null;
}

export interface OAuthTokenRecord {
  token_hash: string;
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
  revoked_at: number | null;
}

export interface OAuthStore {
  pruneExpired(now: number): void;
  pruneOldestInactiveClient(): boolean;
  clientCount(): number;
  saveClient(clientId: string, metadata: unknown, now: number): void;
  getClient(clientId: string): OAuthClientRecord | undefined;
  saveAuthorizationRequest(record: OAuthAuthorizationRequestRecord): void;
  getAuthorizationRequest(requestId: string, now: number): OAuthAuthorizationRequestRecord | undefined;
  consumeAuthorizationRequest(requestId: string, now: number): OAuthAuthorizationRequestRecord | undefined;
  saveAuthorizationCode(record: OAuthAuthorizationCodeRecord): void;
  getAuthorizationCode(codeHash: string, now: number): OAuthAuthorizationCodeRecord | undefined;
  markAuthorizationCodeUsed(codeHash: string, now: number): boolean;
  saveAccessToken(record: OAuthTokenRecord): void;
  getAccessToken(tokenHash: string, now: number): OAuthTokenRecord | undefined;
  saveRefreshToken(record: OAuthTokenRecord): void;
  getRefreshToken(tokenHash: string, now: number): OAuthTokenRecord | undefined;
  rotateRefreshToken(oldHash: string, replacement: OAuthTokenRecord, now: number): boolean;
  revokeToken(tokenHash: string, now: number): void;
}
