import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  HOSTSPAN_OAUTH_SCOPES,
  isSupportedHostSpanOAuthScope,
  splitOAuthScopes,
  type HostSpanOAuthScope,
} from "./oauth-scopes.js";
import { protectWindowsFile } from "../security/windows-acl.js";

const TOKEN_PREFIX = "hsp_";
const TOKEN_PATTERN = /^Bearer (hsp_[A-Za-z0-9_-]{43})$/;

type TokenRow = {
  token_id: string;
  name: string;
  scopes: string;
  secret_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type PrivateTokenRecord = Omit<TokenRow, "scopes" | "secret_hash"> & {
  scopes: HostSpanOAuthScope[];
};

export type VerifiedPrivateToken = {
  token_id: string;
  scopes: HostSpanOAuthScope[];
};

function publicRecord(row: TokenRow): PrivateTokenRecord {
  return {
    token_id: row.token_id,
    name: row.name,
    scopes: splitOAuthScopes(row.scopes) as HostSpanOAuthScope[],
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

export function parsePrivateTokenScopes(value: string): HostSpanOAuthScope[] {
  const names = value.split(",").map((part) => part.trim());
  if (names.length === 0 || names.some((name) => !isSupportedHostSpanOAuthScope(name))) {
    throw new Error("--scopes must be a nonempty comma-separated set of supported HostSpan scopes.");
  }
  const selected = new Set(names);
  return HOSTSPAN_OAUTH_SCOPES.filter((scope) => selected.has(scope));
}

function validateName(name: string): void {
  if (name.trim() !== name || name.length < 1 || name.length > 100 ||
      [...name].some((character) => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; })) {
    throw new Error("Token name must be 1..100 printable characters without surrounding whitespace.");
  }
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Separate from state.db to preserve the existing strict core DB v5 contract. */
export class PrivateTokenStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, "private-access.db");
    try {
      const fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Private token database must be a regular file.");
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
    protectWindowsFile(this.path);
    this.db = new Database(this.path, { fileMustExist: true });
    this.db.pragma("busy_timeout = 3000");
    this.db.pragma("journal_mode = DELETE");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS private_tokens (
        token_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
    `);
  }

  list(): PrivateTokenRecord[] {
    const rows = this.db.prepare("SELECT * FROM private_tokens ORDER BY created_at,token_id").all() as TokenRow[];
    return rows.map(publicRecord);
  }

  issue(name: string, scopes: readonly HostSpanOAuthScope[], deliver: (secret: string) => void): PrivateTokenRecord {
    validateName(name);
    if (!scopes.length || scopes.some((scope) => !isSupportedHostSpanOAuthScope(scope))) {
      throw new Error("At least one valid HostSpan scope is required.");
    }
    const tokenId = `pt_${randomBytes(16).toString("hex")}`;
    const secret = newSecret();
    const now = Math.floor(Date.now() / 1000);
    const granted = HOSTSPAN_OAUTH_SCOPES.filter((scope) => scopes.includes(scope));
    this.db.transaction(() => {
      deliver(secret);
      this.db.prepare("INSERT INTO private_tokens(token_id,name,scopes,secret_hash,created_at) VALUES(?,?,?,?,?)")
        .run(tokenId, name, granted.join(" "), digest(secret), now);
    })();
    return { token_id: tokenId, name, scopes: granted, created_at: now, last_used_at: null, revoked_at: null };
  }

  revoke(tokenId: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    return this.db.prepare("UPDATE private_tokens SET revoked_at=? WHERE token_id=? AND revoked_at IS NULL")
      .run(now, tokenId).changes === 1;
  }

  rotate(tokenId: string, deliver: (secret: string) => void): PrivateTokenRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM private_tokens WHERE token_id=? AND revoked_at IS NULL")
        .get(tokenId) as TokenRow | undefined;
      if (!row) return undefined;
      const secret = newSecret();
      deliver(secret);
      const updated = this.db.prepare("UPDATE private_tokens SET secret_hash=?,last_used_at=NULL WHERE token_id=? AND revoked_at IS NULL")
        .run(digest(secret), tokenId).changes;
      if (updated !== 1) throw new Error("Token rotation lost its active record.");
      return { ...publicRecord(row), last_used_at: null };
    })();
  }

  verifyAuthorizationHeader(header: string | undefined): VerifiedPrivateToken | undefined {
    const secret = header?.match(TOKEN_PATTERN)?.[1];
    if (!secret) return undefined;
    const secretHash = digest(secret);
    const row = this.db.prepare("SELECT * FROM private_tokens WHERE secret_hash=? AND revoked_at IS NULL")
      .get(secretHash) as TokenRow | undefined;
    if (!row) return undefined;
    const expected = Buffer.from(row.secret_hash, "hex");
    const actual = Buffer.from(secretHash, "hex");
    if (expected.length !== 32 || !timingSafeEqual(expected, actual)) return undefined;
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("UPDATE private_tokens SET last_used_at=? WHERE token_id=? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<=?)")
      .run(now, row.token_id, now - 60);
    return { token_id: row.token_id, scopes: publicRecord(row).scopes };
  }

  close(): void {
    this.db.close();
  }
}
