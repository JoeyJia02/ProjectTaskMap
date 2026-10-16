import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { MCP_SCOPE } from '../src/server/auth.js';
import { REFRESH_LIFETIME } from '../src/server/oauth-store.js';
import type { Config } from '../src/server/config.js';

const redirect = 'https://chatgpt.com/connector/oauth/callback';
let folder: string, config: Config, base: string;
let active: ReturnType<typeof createApp> | undefined, server: Server | undefined;
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
});

async function start(overrides: Partial<Config> = {}) {
  active = createApp({ ...config, ...overrides });
  server = active.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
async function stop() {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  active?.close(); active = undefined;
}
async function register(uri = redirect): Promise<string> {
  const response = await request('/register', { redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.grant_types).toContain('refresh_token');
  return body.client_id;
}
function authorizationQuery(clientId: string, uri = redirect) {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, query: new URLSearchParams({ client_id: clientId, redirect_uri: uri, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: `${config.publicUrl}/mcp`, scope: MCP_SCOPE, state: 'state-for-this-browser' }) };
}
async function authorize(clientId: string, uri = redirect) {
  const { verifier, query } = authorizationQuery(clientId, uri);
  const consent = await request(`/authorize?${query}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const intent = html.match(/name="intent" value="([^"]+)"/)![1];
  const cookie = consent.headers.get('set-cookie')!.split(';')[0];
  const approved = await request('/authorize', { intent, ownerSecret: config.ownerSecret }, { Cookie: cookie });
  expect(approved.status).toBe(303);
  const callback = new URL(approved.headers.get('location')!);
  expect(callback.searchParams.get('iss')).toBe(config.publicUrl);
  expect(callback.searchParams.get('state')).toBe('state-for-this-browser');
  const body = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), client_id: clientId, redirect_uri: uri, resource: `${config.publicUrl}/mcp`, code_verifier: verifier };
  expect((await request('/token', { ...body, redirect_uri: `${uri}/wrong` })).status).toBe(400);
  const token = await request('/token', body);
  expect(token.status).toBe(200);
  expect(token.headers.get('cache-control')).toBe('no-store');
  const value = await token.json();
  expect(active!.auth.verify(value.access_token, 'mcp').kind).toBe('oauth');
  return value as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}
const refresh = (clientId: string, token: string, extra: Record<string, unknown> = {}) => request('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...extra });

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'taskmap-oauth-'));
  config = { ownerSecret: 'test-owner-secret-'.repeat(3), signingSecret: 'test-signing-secret-'.repeat(3), publicUrl: 'http://127.0.0.1:3000', widgetOrigin: 'https://web-sandbox.oaiusercontent.com', allowedOrigins: ['http://127.0.0.1:3000'], dbPath: join(folder, 'task-map.sqlite'), host: '127.0.0.1', port: 3000 };
  await start();
});
afterEach(async () => { vi.restoreAllMocks(); await stop(); rmSync(folder, { recursive: true, force: true }); });

describe('durable OAuth refresh grants', () => {
  it('advertises refresh and issuer support, stores only refresh hashes, and rotates without widening scope', async () => {
    const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
    expect(metadata.grant_types_supported).toContain('refresh_token');
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    const clientId = await register(); const token = await authorize(clientId);
    expect(token.expires_in).toBe(3600);
    const response = await refresh(clientId, token.refresh_token, { resource: `${config.publicUrl}/mcp`, scope: 'projects:write projects:read' });
    expect(response.status).toBe(200);
    const next = await response.json();
    expect(next.refresh_token).not.toBe(token.refresh_token);
    expect(next.scope).toBe(MCP_SCOPE);
    expect(active!.auth.verify(next.access_token, 'mcp').kind).toBe('oauth');
    const db = new DatabaseSync(config.dbPath);
    try {
      const rows = db.prepare('SELECT * FROM oauth_refresh_tokens').all();
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.token_hash)).toContain(createHash('sha256').update(token.refresh_token).digest('hex'));
      expect(JSON.stringify(rows)).not.toContain(token.refresh_token);
      expect(JSON.stringify(rows)).not.toContain(next.refresh_token);
    } finally { db.close(); }
  });

  it('preserves registered clients and refresh grants through restart, including beyond the old 24-hour cutoff', async () => {
    const clientId = await register(); const token = await authorize(clientId);
    const original = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(original + 2 * 86400 * 1000);
    await stop(); await start();
    const renewed = await refresh(clientId, token.refresh_token);
    expect(renewed.status).toBe(200);
    expect(active!.auth.verify((await renewed.json()).access_token, 'mcp').kind).toBe('oauth');
    expect((await authorize(clientId)).refresh_token).toBeTruthy();
  });

  it('recovers registration capacity by pruning abandoned clients without removing an authorized client', async () => {
    const clientId = await register(); const token = await authorize(clientId);
    const at = Math.floor(Date.now() / 1000);
    for (let count = 0; count < 499; count++) active!.oauth.register([redirect], at - 86401);
    expect(active!.oauth.clientCount()).toBe(500);
    await register();
    expect(active!.oauth.clientCount()).toBe(2);
    expect((await refresh(clientId, token.refresh_token)).status).toBe(200);
  });

  it('revokes the whole family and its access tokens when a spent token is replayed after restart', async () => {
    const clientId = await register(); const token = await authorize(clientId);
    const next = await (await refresh(clientId, token.refresh_token)).json();
    await stop(); await start();
    expect((await refresh(clientId, token.refresh_token)).status).toBe(400);
    expect((await refresh(clientId, next.refresh_token)).status).toBe(400);
    expect(() => active!.auth.verify(next.access_token, 'mcp')).toThrow();
    expect(() => active!.auth.verify(token.access_token, 'mcp')).toThrow();
    // A new explicit authorization is a separate, still-valid family.
    const fresh = await authorize(clientId);
    expect((await refresh(clientId, fresh.refresh_token)).status).toBe(200);
  });

  it('atomically permits one of two racing refreshes and revokes their replayed family', async () => {
    const clientId = await register(); const token = await authorize(clientId);
    const responses = await Promise.all([refresh(clientId, token.refresh_token), refresh(clientId, token.refresh_token)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const next = await responses.find(response => response.status === 200)!.json();
    expect((await refresh(clientId, next.refresh_token)).status).toBe(400);
    expect(() => active!.auth.verify(next.access_token, 'mcp')).toThrow();
  });

  it('also revokes cached widget API tokens derived from a replayed MCP grant', async () => {
    const clientId = await register(); const token = await authorize(clientId);
    const client = new Client({ name: 'oauth-widget-test', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }));
      const bound = await client.callTool({ name: 'bind_project', arguments: { bindingKey: 'oauth-widget-test', name: 'Widget token verification' } });
      const projectId = (bound.structuredContent as { state: { projectId: string } }).state.projectId;
      const headers = { Authorization: `Bearer ${String(bound._meta!.projectToken)}` };
      expect((await request(`/api/projects/${projectId}`, undefined, headers)).status).toBe(200);
      expect((await refresh(clientId, token.refresh_token)).status).toBe(200);
      expect((await refresh(clientId, token.refresh_token)).status).toBe(400);
      expect((await request(`/api/projects/${projectId}`, undefined, headers)).status).toBe(401);
      expect((await request(`/api/projects/${projectId}/manual`, {}, headers)).status).toBe(401);
      const ownerProjectToken = active!.auth.issue('project', projectId);
      expect((await request(`/api/projects/${projectId}`, undefined, { Authorization: `Bearer ${ownerProjectToken}` })).status).toBe(200);
    } finally { await client.close(); }
  });

  it('recovers a two-hour-old card using renewed host OAuth while rejecting revoked and different grants', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const clientId = await register(); const token = await authorize(clientId);
    const family = active!.auth.verify(token.access_token, 'mcp').familyId;
    const bound = active!.store.bind('personal-owner', { bindingKey: 'old-card', name: '旧卡片' });
    const projectId = bound.state.projectId;
    const projectToken = active!.auth.issue('project', projectId, 3600, family);
    clock.mockReturnValue(Date.now() + 7200 * 1000);
    expect(() => active!.auth.verify(token.access_token, 'mcp')).toThrow();
    expect((await request(`/api/projects/${projectId}`, undefined, { Authorization: `Bearer ${projectToken}` })).status).toBe(401);
    const renewed = await (await refresh(clientId, token.refresh_token)).json();
    const client = new Client({ name: 'old-card', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${renewed.access_token}` } } }));
      const args = { projectId, projectToken };
      expect((await client.callTool({ name: 'read_project_view', arguments: { ...args, view: 'state' } })).structuredContent).toHaveProperty('data.state.version', 0);
      const change = { action: 'manual', delta: { projectId, expectedVersion: 0, idempotencyKey: 'old-card-write', timestamp: new Date(Date.now()).toISOString(), source: 'manual', confidence: 1, evidence: [], operations: [{ type: 'ADD_NODE', node: { id: 'idea', title: '恢复后的想法', status: 'parking' } }] } };
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change } })).structuredContent).toHaveProperty('data.outcome', 'applied');
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change } })).structuredContent).toHaveProperty('data.outcome', 'duplicate');
      const another = await authorize(clientId);
      expect(() => active!.auth.verifyUiCapability(projectToken, active!.auth.verify(another.access_token, 'mcp'))).toThrow();
      // Replaying a consumed refresh revokes the old grant; the card cannot revive it.
      expect((await refresh(clientId, token.refresh_token)).status).toBe(400);
      expect(() => active!.auth.verifyUiCapability(projectToken, { kind: 'oauth', ownerId: 'personal-owner', familyId: family })).toThrow();
    } finally { await client.close(); clock.mockRestore(); }
  });

  it('rejects wrong clients, resource changes, and partial or wider scopes without consuming the valid token', async () => {
    const clientId = await register(); const other = await register(); const token = await authorize(clientId);
    expect((await refresh(other, token.refresh_token)).status).toBe(400);
    expect((await refresh(clientId, token.refresh_token, { resource: 'https://attacker.example/mcp' })).status).toBe(400);
    for (const scope of ['projects:read', `${MCP_SCOPE} admin`, ['projects:read']]) {
      const response = await refresh(clientId, token.refresh_token, { scope });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_scope' });
    }
    expect((await refresh(clientId, token.refresh_token)).status).toBe(200);
  });

  it('does not extend the absolute 30-day grant expiry during rotation', async () => {
    const original = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(original);
    const clientId = await register(); const token = await authorize(clientId);
    clock.mockReturnValue(original + (REFRESH_LIFETIME - 120) * 1000);
    const response = await refresh(clientId, token.refresh_token);
    expect(response.status).toBe(200);
    const next = await response.json();
    expect(next.expires_in).toBe(120);
    clock.mockReturnValue(original + REFRESH_LIFETIME * 1000);
    expect((await refresh(clientId, next.refresh_token)).status).toBe(400);
    expect(() => active!.auth.verify(next.access_token, 'mcp')).toThrow();
  });

  it.each(['publicUrl', 'signingSecret', 'ownerSecret'] as const)('invalidates old registrations and refresh grants when %s changes', async key => {
    const clientId = await register(); const token = await authorize(clientId);
    await stop(); await start({ [key]: key === 'publicUrl' ? 'http://localhost:3000' : 'changed-secret-'.repeat(4) });
    expect((await refresh(clientId, token.refresh_token)).status).toBe(400);
    expect(() => active!.auth.verify(token.access_token, 'mcp')).toThrow();
  });
});

describe('native OAuth loopback callbacks', () => {
  it.each(['127.0.0.1', '[::1]'])('allows an ephemeral port for %s while requiring the exact redirect at exchange', async host => {
    const clientId = await register(`http://${host}/callback`);
    await authorize(clientId, `http://${host}:45123/callback`);
  });
  it('rejects changed callback paths, hosts, queries, non-loopback ports, and localhost port changes', async () => {
    const clientId = await register('http://127.0.0.1:1234/callback?client=codex');
    for (const uri of ['http://127.0.0.1:4567/other?client=codex', 'http://127.0.0.2:4567/callback?client=codex', 'http://127.0.0.1:4567/callback?client=other', 'http://127.0.0.1:4567/callback?client=codex#fragment']) {
      expect((await request(`/authorize?${authorizationQuery(clientId, uri).query}`)).status).toBe(400);
    }
    const webClient = await register('https://example.com:1234/callback');
    expect((await request(`/authorize?${authorizationQuery(webClient, 'https://example.com:4567/callback').query}`)).status).toBe(400);
    const localClient = await register('http://localhost:1234/callback');
    expect((await request(`/authorize?${authorizationQuery(localClient, 'http://localhost:4567/callback').query}`)).status).toBe(400);
  });
});
