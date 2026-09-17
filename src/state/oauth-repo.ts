import type { HostSpanDatabase } from "./database.js";

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

export class OAuthRepo {
  constructor(private readonly db: HostSpanDatabase) {}

  pruneExpired(now: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM oauth_authorization_requests WHERE expires_at<=?").run(now);
      this.db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at<=? OR used_at IS NOT NULL").run(now);
      this.db.prepare("DELETE FROM oauth_access_tokens WHERE expires_at<=? OR revoked_at IS NOT NULL").run(now);
      this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at<=? OR revoked_at IS NOT NULL").run(now);
    })();
  }

  pruneOldestInactiveClient(): boolean {
    const row = this.db
      .prepare(
        `SELECT c.client_id
         FROM oauth_clients c
         WHERE NOT EXISTS (SELECT 1 FROM oauth_authorization_requests r WHERE r.client_id=c.client_id)
           AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes a WHERE a.client_id=c.client_id)
           AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id=c.client_id)
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id=c.client_id)
         ORDER BY c.created_at ASC
         LIMIT 1`,
      )
      .get() as { client_id: string } | undefined;
    if (!row) return false;
    return this.db.prepare("DELETE FROM oauth_clients WHERE client_id=?").run(row.client_id).changes === 1;
  }

  clientCount(): number {
    return (this.db.prepare("SELECT count(*) AS count FROM oauth_clients").get() as { count: number }).count;
  }

  saveClient(clientId: string, metadata: unknown, now: number): void {
    this.db
      .prepare("INSERT INTO oauth_clients(client_id,metadata_json,created_at) VALUES(?,?,?)")
      .run(clientId, JSON.stringify(metadata), now);
  }

  getClient(clientId: string): OAuthClientRecord | undefined {
    return this.db.prepare("SELECT * FROM oauth_clients WHERE client_id=?").get(clientId) as OAuthClientRecord | undefined;
  }

  saveAuthorizationRequest(record: OAuthAuthorizationRequestRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO oauth_authorization_requests(request_id,client_id,redirect_uri,scope,state,code_challenge,resource,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          record.request_id,
          record.client_id,
          record.redirect_uri,
          record.scope,
          record.state,
          record.code_challenge,
          record.resource,
          record.expires_at,
        );
      this.db
        .prepare(
          `DELETE FROM oauth_authorization_requests
           WHERE client_id=?
             AND request_id NOT IN (
               SELECT request_id
               FROM oauth_authorization_requests
               WHERE client_id=?
               ORDER BY expires_at DESC, request_id DESC
               LIMIT 8
             )`,
        )
        .run(record.client_id, record.client_id);
    })();
  }

  getAuthorizationRequest(requestId: string, now: number): OAuthAuthorizationRequestRecord | undefined {
    return this.db
      .prepare("SELECT * FROM oauth_authorization_requests WHERE request_id=? AND expires_at>?")
      .get(requestId, now) as OAuthAuthorizationRequestRecord | undefined;
  }

  saveAuthorizationCode(record: OAuthAuthorizationCodeRecord): void {
    this.db
      .prepare(
        "INSERT INTO oauth_authorization_codes(code_hash,client_id,redirect_uri,scope,code_challenge,resource,expires_at,used_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        record.code_hash,
        record.client_id,
        record.redirect_uri,
        record.scope,
        record.code_challenge,
        record.resource,
        record.expires_at,
        record.used_at,
      );
  }

  getAuthorizationCode(codeHash: string, now: number): OAuthAuthorizationCodeRecord | undefined {
    return this.db
      .prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?")
      .get(codeHash, now) as OAuthAuthorizationCodeRecord | undefined;
  }

  markAuthorizationCodeUsed(codeHash: string, now: number): boolean {
    return (
      this.db
        .prepare("UPDATE oauth_authorization_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?")
        .run(now, codeHash, now).changes === 1
    );
  }

  saveAccessToken(record: OAuthTokenRecord): void {
    this.db
      .prepare(
        "INSERT INTO oauth_access_tokens(token_hash,client_id,scope,resource,expires_at,revoked_at) VALUES(?,?,?,?,?,?)",
      )
      .run(record.token_hash, record.client_id, record.scope, record.resource, record.expires_at, record.revoked_at);
  }

  getAccessToken(tokenHash: string, now: number): OAuthTokenRecord | undefined {
    return this.db
      .prepare("SELECT * FROM oauth_access_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?")
      .get(tokenHash, now) as OAuthTokenRecord | undefined;
  }

  saveRefreshToken(record: OAuthTokenRecord): void {
    this.db
      .prepare(
        "INSERT INTO oauth_refresh_tokens(token_hash,client_id,scope,resource,expires_at,revoked_at) VALUES(?,?,?,?,?,?)",
      )
      .run(record.token_hash, record.client_id, record.scope, record.resource, record.expires_at, record.revoked_at);
  }

  getRefreshToken(tokenHash: string, now: number): OAuthTokenRecord | undefined {
    return this.db
      .prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?")
      .get(tokenHash, now) as OAuthTokenRecord | undefined;
  }

  rotateRefreshToken(oldHash: string, replacement: OAuthTokenRecord, now: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare("UPDATE oauth_refresh_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?")
        .run(now, oldHash, now).changes;
      if (changed !== 1) return false;
      this.saveRefreshToken(replacement);
      return true;
    })();
  }

  revokeToken(tokenHash: string, now: number): void {
    this.db.prepare("UPDATE oauth_access_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now, tokenHash);
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now, tokenHash);
  }

  revokeAll(now: number): void {
    this.db.prepare("UPDATE oauth_access_tokens SET revoked_at=? WHERE revoked_at IS NULL").run(now);
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at=? WHERE revoked_at IS NULL").run(now);
    this.db.prepare("DELETE FROM oauth_authorization_requests").run();
    this.db.prepare("DELETE FROM oauth_authorization_codes").run();
  }
}
