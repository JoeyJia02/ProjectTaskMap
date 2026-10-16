import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OAuthStore, REFRESH_LIFETIME } from '../src/server/oauth-store.js';
import type { Config } from '../src/server/config.js';

const at = Date.parse('2026-09-30T00:00:00Z') / 1000;
const created = at - 2 * 86400;
const scope = 'projects:read projects:write';
const redirects = ['https://client.example.test/callback'];
const legacyToken = Buffer.alloc(32, 1).toString('base64url');
const expiredToken = Buffer.alloc(32, 2).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
let directory: string;
let config: Config;
let store: OAuthStore | undefined;

// Frozen pre-authorized_at schema and synthetic rows. Constructing the fixture
// with today's OAuthStore would never exercise its existing-table migration.
function createLegacyDatabase() {
  const context = createHmac('sha256', config.signingSecret)
    .update(JSON.stringify(['oauth-v1', config.publicUrl, config.ownerSecret])).digest('hex');
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY, redirects_json TEXT NOT NULL, created_at INTEGER NOT NULL, context TEXT NOT NULL);
      CREATE TABLE oauth_families (
        family_id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, context TEXT NOT NULL);
      CREATE TABLE oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES oauth_families(family_id) ON DELETE CASCADE,
        used_at INTEGER);`);
    const client = db.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)');
    for (const id of ['authorized-live', 'authorized-expired', 'abandoned-old']) {
      client.run(id, JSON.stringify(redirects), created, context);
    }
    client.run('fresh-unapproved', JSON.stringify(redirects), at - 30, context);
    const family = db.prepare('INSERT INTO oauth_families VALUES (?, ?, ?, ?, ?, NULL, ?)');
    family.run('live-family', 'authorized-live', `${config.publicUrl}/mcp`, scope, created + REFRESH_LIFETIME, context);
    family.run('expired-family', 'authorized-expired', `${config.publicUrl}/mcp`, scope, at - 1, context);
    const token = db.prepare('INSERT INTO oauth_refresh_tokens VALUES (?, ?, NULL)');
    token.run(hash(legacyToken), 'live-family');
    token.run(hash(expiredToken), 'expired-family');
    expect(db.prepare('PRAGMA table_info(oauth_clients)').all().map(column => column.name)).not.toContain('authorized_at');
  } finally { db.close(); }
}

function snapshot() {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    return {
      columns: db.prepare('PRAGMA table_info(oauth_clients)').all(),
      clients: db.prepare('SELECT * FROM oauth_clients ORDER BY client_id').all(),
      families: db.prepare('SELECT * FROM oauth_families ORDER BY family_id').all(),
      tokens: db.prepare('SELECT * FROM oauth_refresh_tokens ORDER BY token_hash').all(),
      foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally { db.close(); }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'taskmap-oauth-upgrade-'));
  config = {
    ownerSecret: 'synthetic-upgrade-owner-'.repeat(3), signingSecret: 'synthetic-upgrade-signing-'.repeat(3),
    publicUrl: 'https://oauth-upgrade.example.test', widgetOrigin: 'https://widget.example.test',
    allowedOrigins: ['https://widget.example.test'], dbPath: join(directory, 'legacy.sqlite'), host: '127.0.0.1', port: 0,
  };
  createLegacyDatabase();
});

afterEach(() => {
  store?.close(); store = undefined;
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('taskmap-oauth-upgrade-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(target, { recursive: true, force: true });
});

describe('upgrade from the durable OAuth schema before authorized_at', () => {
  it('backfills previously authorized clients without changing grants and reopens without further changes', () => {
    const original = snapshot();
    store = new OAuthStore(config);
    const migrated = snapshot();
    expect(migrated.columns.filter(column => column.name === 'authorized_at')).toHaveLength(1);
    expect(migrated.clients.map(client => [client.client_id, client.authorized_at])).toEqual([
      ['abandoned-old', null], ['authorized-expired', created], ['authorized-live', created], ['fresh-unapproved', null],
    ]);
    expect(migrated.families).toEqual(original.families);
    expect(migrated.tokens).toEqual(original.tokens);
    expect(migrated.foreignKeyErrors).toEqual([]);
    expect(store.getClient('authorized-live')).toEqual({ clientId: 'authorized-live', redirects, created });
    expect(store.clientCount()).toBe(4);
    expect(store.isActive('live-family', at)).toBe(true);
    store.close(); store = new OAuthStore(config);
    expect(snapshot()).toEqual(migrated);
    expect(store.getClient('authorized-live')).toEqual({ clientId: 'authorized-live', redirects, created });
  });

  it('prunes abandoned registrations and expired grants while retaining migrated previously authorized clients', () => {
    store = new OAuthStore(config);
    store.prune(at);
    expect(store.getClient('abandoned-old')).toBeUndefined();
    expect(store.getClient('fresh-unapproved')).toBeDefined();
    expect(store.getClient('authorized-live')).toBeDefined();
    // Its only family has expired, but migration must remember that this client
    // was authorized so a later explicit reconnect can reuse its registration.
    expect(store.getClient('authorized-expired')).toBeDefined();
    expect(store.clientCount()).toBe(3);
    expect(store.isActive('live-family', at)).toBe(true);
    expect(store.isActive('expired-family', at)).toBe(false);
    const pruned = snapshot();
    expect(pruned.families.map(family => family.family_id)).toEqual(['live-family']);
    expect(pruned.tokens.map(token => token.token_hash)).toEqual([hash(legacyToken)]);
    expect(pruned.foreignKeyErrors).toEqual([]);
  });

  it('rotates a migrated refresh grant after pruning and reopening without extending its expiry', () => {
    store = new OAuthStore(config);
    store.prune(at);
    store.close(); store = new OAuthStore(config);
    const renewed = store.rotate(legacyToken, 'authorized-live', `${config.publicUrl}/mcp`, scope, at + 1);
    expect(renewed).toBeDefined();
    expect(renewed!.familyId).toBe('live-family');
    expect(renewed!.expires).toBe(created + REFRESH_LIFETIME);
    expect(renewed!.refreshToken).not.toBe(legacyToken);
    const rotated = snapshot();
    expect(rotated.tokens).toHaveLength(2);
    expect(rotated.tokens.find(token => token.token_hash === hash(legacyToken))?.used_at).toBe(at + 1);
    expect(rotated.tokens.find(token => token.token_hash === hash(renewed!.refreshToken))?.used_at).toBeNull();
    expect(JSON.stringify(rotated)).not.toContain(legacyToken);
    expect(JSON.stringify(rotated)).not.toContain(renewed!.refreshToken);
    store.close(); store = new OAuthStore(config);
    expect(snapshot()).toEqual(rotated);
    const next = store.rotate(renewed!.refreshToken, 'authorized-live', `${config.publicUrl}/mcp`, scope, at + 2);
    expect(next).toBeDefined();
    expect(next!.familyId).toBe('live-family');
    expect(next!.expires).toBe(created + REFRESH_LIFETIME);
    expect(store.isActive('live-family', at + 2)).toBe(true);
    expect(snapshot().foreignKeyErrors).toEqual([]);
  });
});
