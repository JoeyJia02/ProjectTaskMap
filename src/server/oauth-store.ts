import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';

export const REFRESH_LIFETIME = 30 * 24 * 60 * 60;
const opaque = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface OAuthClient { clientId: string; redirects: string[]; created: number }
export interface RefreshGrant { refreshToken: string; familyId: string; expires: number }
type RefreshRow = { family_id: string; client_id: string; resource: string; scope: string; expires_at: number; revoked_at: number | null; used_at: number | null };

/** Durable grants share the project database, so a normal SQLite backup includes them. */
export class OAuthStore {
  private readonly db: DatabaseSync;
  private readonly context: string;
  private closed = false;

  constructor(config: Config) {
    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    // An issuer or credential change must never revive grants from the old deployment.
    this.context = createHmac('sha256', config.signingSecret).update(JSON.stringify(['oauth-v1', config.publicUrl, config.ownerSecret])).digest('hex');
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, redirects_json TEXT NOT NULL, created_at INTEGER NOT NULL, context TEXT NOT NULL, authorized_at INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_families (
        family_id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES oauth_families(family_id) ON DELETE CASCADE,
        used_at INTEGER);
      CREATE INDEX IF NOT EXISTS oauth_family_expiry ON oauth_families(expires_at);
      CREATE INDEX IF NOT EXISTS oauth_refresh_family ON oauth_refresh_tokens(family_id);`);
    if (!this.db.prepare('PRAGMA table_info(oauth_clients)').all().some(column => column.name === 'authorized_at')) {
      this.db.exec('ALTER TABLE oauth_clients ADD COLUMN authorized_at INTEGER');
      this.db.exec('UPDATE oauth_clients SET authorized_at = created_at WHERE client_id IN (SELECT client_id FROM oauth_families)');
    }
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  prune(at: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM oauth_families WHERE expires_at <= ?').run(at);
      // Abandoned unauthenticated registrations cannot permanently exhaust the DCR limit.
      // Previously authorized clients remain usable for a later explicit reconnect.
      this.db.prepare('DELETE FROM oauth_clients WHERE authorized_at IS NULL AND created_at <= ? AND NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.client_id = oauth_clients.client_id)').run(at - 86400);
    });
  }

  clientCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM oauth_clients WHERE context = ?').get(this.context) as { count: number }).count;
  }

  register(redirects: string[], at: number): OAuthClient {
    const client = { clientId: opaque(), redirects, created: at };
    this.db.prepare('INSERT INTO oauth_clients (client_id, redirects_json, created_at, context) VALUES (?, ?, ?, ?)').run(client.clientId, JSON.stringify(redirects), at, this.context);
    return client;
  }

  getClient(clientId: string): OAuthClient | undefined {
    const row = this.db.prepare('SELECT redirects_json, created_at FROM oauth_clients WHERE client_id = ? AND context = ?').get(clientId, this.context) as { redirects_json: string; created_at: number } | undefined;
    return row ? { clientId, redirects: JSON.parse(row.redirects_json) as string[], created: row.created_at } : undefined;
  }

  createGrant(clientId: string, resource: string, scope: string, at: number): RefreshGrant {
    return this.transaction(() => {
      if (!this.getClient(clientId)) throw new Error('OAuth client is no longer registered.');
      this.db.prepare('UPDATE oauth_clients SET authorized_at = ? WHERE client_id = ?').run(at, clientId);
      const grant = { refreshToken: opaque(), familyId: opaque(), expires: at + REFRESH_LIFETIME };
      this.db.prepare('INSERT INTO oauth_families VALUES (?, ?, ?, ?, ?, NULL, ?)').run(grant.familyId, clientId, resource, scope, grant.expires, this.context);
      this.db.prepare('INSERT INTO oauth_refresh_tokens VALUES (?, ?, NULL)').run(hash(grant.refreshToken), grant.familyId);
      return grant;
    });
  }

  rotate(token: string, clientId: string, resource: string, scope: string, at: number): RefreshGrant | undefined {
    return this.transaction(() => {
      const tokenHash = hash(token);
      const row = this.db.prepare(`SELECT f.family_id, f.client_id, f.resource, f.scope, f.expires_at, f.revoked_at, t.used_at
        FROM oauth_refresh_tokens t JOIN oauth_families f ON f.family_id = t.family_id
        WHERE t.token_hash = ? AND f.context = ?`).get(tokenHash, this.context) as RefreshRow | undefined;
      if (!row || row.client_id !== clientId || row.resource !== resource || row.scope !== scope || row.expires_at <= at || row.revoked_at !== null) return undefined;
      if (row.used_at !== null) {
        // Keep spent hashes until absolute expiry to detect replay across process restarts.
        this.db.prepare('UPDATE oauth_families SET revoked_at = ? WHERE family_id = ?').run(at, row.family_id);
        return undefined;
      }
      const refreshToken = opaque();
      this.db.prepare('UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?').run(at, tokenHash);
      this.db.prepare('INSERT INTO oauth_refresh_tokens VALUES (?, ?, NULL)').run(hash(refreshToken), row.family_id);
      return { refreshToken, familyId: row.family_id, expires: row.expires_at };
    });
  }

  isActive(familyId: string, at: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM oauth_families WHERE family_id = ? AND context = ? AND revoked_at IS NULL AND expires_at > ?').get(familyId, this.context, at);
  }
}
