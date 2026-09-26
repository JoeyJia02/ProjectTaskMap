import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { Auth } from '../src/server/auth.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { ProjectStore } from '../src/store/index.js';

const config: Config = { ownerSecret: 'test-owner-secret-'.repeat(3), signingSecret: 'test-signing-secret-'.repeat(3), publicUrl: 'http://127.0.0.1:3000', widgetOrigin: 'https://web-sandbox.oaiusercontent.com', allowedOrigins: ['http://127.0.0.1:3000', 'https://web-sandbox.oaiusercontent.com'], dbPath: ':memory:', host: '127.0.0.1', port: 3000 };
let base: string, server: Server, store: ProjectStore, auth: Auth;
const request = (path: string, body?: unknown, token = config.ownerSecret, extra: Record<string, string> = {}) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
const timestamp = '2026-09-26T08:00:00.000Z';
const evidence = [{ id: 'turn-1', kind: 'turn', label: '用户确认', timestamp }];
const delta = (projectId: string, version: number, operations: unknown[], key = randomBytes(8).toString('hex')) => ({ projectId, expectedVersion: version, idempotencyKey: key, timestamp, source: 'ai', confidence: 1, evidence, operations });
async function bind(key = randomBytes(8).toString('hex')) { return (await request('/api/bind', { bindingKey: key, name: '测试项目', goal: '可靠地管理当前项目' })).json(); }
beforeEach(async () => {
  const created = createApp(config); store = created.store; auth = created.auth;
  server = created.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });

describe('authenticated HTTP boundary', () => {
  it('keeps owner credentials out of public discovery and checks project capabilities on all routes', async () => {
    expect((await request('/health', undefined, '')).status).toBe(200);
    expect((await request('/api/bind', {}, '')).status).toBe(401);
    const a = await bind('a'); const b = await bind('b');
    expect(a.state.projectId).not.toBe(b.state.projectId);
    expect((await request(`/api/projects/${a.state.projectId}`, undefined, a.projectToken)).status).toBe(200);
    const widgetRead = await request(`/api/projects/${a.state.projectId}`, undefined, a.projectToken, { Origin: config.widgetOrigin });
    expect(widgetRead.status).toBe(200);
    expect(widgetRead.headers.get('access-control-allow-origin')).toBe(config.widgetOrigin);
    for (const suffix of ['', '/history', '/conflicts', '/artifact.md', '/artifact.html']) expect((await request(`/api/projects/${b.state.projectId}${suffix}`, undefined, a.projectToken)).status).toBe(403);
    expect((await request('/api/bind', { bindingKey: 'c', name: 'C' }, a.projectToken)).status).toBe(403);
    expect((await request(`/api/projects/${a.state.projectId}`, undefined, auth.issue('project', a.state.projectId, -1))).status).toBe(401);
    expect((await request(`/api/projects/${a.state.projectId}`, undefined, auth.issue('oauth'))).status).toBe(401);
  });
  it('rejects cross-origin writes, mismatched IDs, malformed JSON and wrong media types', async () => {
    const { state } = await bind();
    expect((await request(`/api/projects/${state.projectId}/deltas`, delta('another', 0, []))).status).toBe(400);
    expect((await request('/api/bind', { bindingKey: 'bad', name: 'X' }, config.ownerSecret, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await fetch(`${base}/api/bind`, { method: 'POST', headers: { Authorization: `Bearer ${config.ownerSecret}`, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await request('/api/bind', { bindingKey: '', name: 'X' })).status).toBe(400);
  });
  it('enforces AI source even when an AI delta claims manual authority', async () => {
    const { state, projectToken } = await bind();
    const path = `/api/projects/${state.projectId}`;
    const created = await (await request(`${path}/manual`, delta(state.projectId, 0, [{ type: 'ADD_NODE', node: { id: 'locked', title: '人工任务' } }]), projectToken)).json();
    expect(created.outcome).toBe('applied');
    const dropped = await (await request(`${path}/manual`, delta(state.projectId, 1, [{ type: 'DROP_NODE', nodeId: 'locked' }]), projectToken)).json();
    expect(dropped.state.nodes[0].status).toBe('dropped');
    const spoofed = { ...delta(state.projectId, 2, [{ type: 'SET_ACTIVE_NODE', nodeId: 'locked' }]), source: 'manual' };
    const rejected = await (await request(`${path}/deltas`, spoofed, projectToken)).json();
    expect(rejected.outcome).toBe('pending');
    expect(rejected.state.nodes[0].status).toBe('dropped');
    expect(rejected.state.version).toBe(2);
    const md = await (await request(`${path}/artifact.md`, undefined, projectToken)).text();
    expect(md).toContain('人工任务'); expect(md).not.toContain(projectToken);
  });
});

describe('OAuth authorization code + PKCE', () => {
  it('requires owner consent, exact redirect/resource, PKCE and single-use code', async () => {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'https://chatgpt.com/connector/oauth/callback';
    const registration = await (await request('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '')).json();
    const q = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, resource: `${config.publicUrl}/mcp`, state: 'state-value' });
    const consent = await request(`/authorize?${q}`, undefined, '');
    expect((await request(`/authorize?${q}&scope=projects:read`, undefined, '')).status).toBe(400);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).not.toContain(config.ownerSecret);
    const intent = html.match(/name="intent" value="([^"]+)"/)![1];
    const cookie = consent.headers.get('set-cookie')!.split(';')[0];
    expect((await request('/authorize', { intent, ownerSecret: config.ownerSecret }, '')).status).toBe(401);
    const allowed = await request('/authorize', { intent, ownerSecret: config.ownerSecret }, '', { Cookie: cookie });
    expect(allowed.status).toBe(303);
    const callback = new URL(allowed.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('state-value');
    const body = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), client_id: registration.client_id, redirect_uri: redirect, resource: `${config.publicUrl}/mcp`, code_verifier: verifier };
    expect((await request('/token', { ...body, code_verifier: 'x'.repeat(64) }, '')).status).toBe(400);
    expect((await request('/token', { ...body, resource: 'https://attacker.example/mcp' }, '')).status).toBe(400);
    const token = await (await request('/token', body, '')).json();
    expect(auth.verify(token.access_token, 'mcp').kind).toBe('oauth');
    expect((await request('/token', body, '')).status).toBe(400);
  });
  it('rejects unsafe registration and insecure deployed configurations', async () => {
    expect((await request('/register', { redirect_uris: ['http://public.example/cb'] }, '')).status).toBe(400);
    expect(() => loadConfig({ TASK_MAP_OWNER_SECRET: config.ownerSecret, TASK_MAP_SIGNING_SECRET: config.signingSecret, TASK_MAP_PUBLIC_URL: 'http://public.example' })).toThrow('HTTPS');
    const token = auth.issue('oauth');
    expect(() => auth.verify(token.slice(0, -4) + 'aaaa', 'mcp')).toThrow();
    expect(() => auth.verify(token, 'api')).toThrow();
  });
});

describe('real MCP protocol', () => {
  it('initializes, discovers annotated tools, binds, changes, deduplicates and exports', async () => {
    const client = new Client({ name: 'integration-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${auth.issue('oauth')}` } } }));
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toContain('assess_project_turn');
    expect(listed.tools.find(t => t.name === 'stage_project_delta')!.annotations!.readOnlyHint).toBe(false);
    const bound = await client.callTool({ name: 'bind_project', arguments: { bindingKey: 'mcp-project', name: 'MCP Project' } });
    const state = (bound.structuredContent as { state: { projectId: string } }).state;
    expect(bound._meta).toHaveProperty('projectToken');
    expect(JSON.stringify(bound.structuredContent)).not.toContain(String(bound._meta!.projectToken));
    const d = delta(state.projectId, 0, [{ type: 'ADD_NODE', node: { id: 'mcp-node', title: '通过 MCP 保存' } }], 'mcp-idempotency');
    const first = await client.callTool({ name: 'apply_project_delta', arguments: { delta: d } });
    expect(first.structuredContent).toHaveProperty('outcome', 'applied');
    const duplicate = await client.callTool({ name: 'apply_project_delta', arguments: { delta: d } });
    expect(duplicate.structuredContent).toHaveProperty('outcome', 'duplicate');
    const exported = await client.callTool({ name: 'export_task_map', arguments: { projectId: state.projectId, format: 'md' } });
    expect(JSON.stringify(exported.content)).toContain('通过 MCP 保存');
    const resources = await client.listResources(); expect(resources.resources[0].uri).toContain('ui://');
    await client.close();
  });
});
