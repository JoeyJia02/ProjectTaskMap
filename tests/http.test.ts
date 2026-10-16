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
let closeApp: () => void;
const request = (path: string, body?: unknown, token = config.ownerSecret, extra: Record<string, string> = {}) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
const timestamp = '2026-09-26T08:00:00.000Z';
const evidence = [{ id: 'turn-1', kind: 'turn', label: '用户确认', timestamp }];
const delta = (projectId: string, version: number, operations: unknown[], key = randomBytes(8).toString('hex')) => ({ projectId, expectedVersion: version, idempotencyKey: key, timestamp, source: 'ai', confidence: 1, evidence, operations });
async function bind(key = randomBytes(8).toString('hex')) { return (await request('/api/bind', { bindingKey: key, name: '测试项目', goal: '可靠地管理当前项目' })).json(); }
beforeEach(async () => {
  const created = createApp(config); store = created.store; auth = created.auth; closeApp = created.close;
  server = created.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeApp(); });

describe('authenticated HTTP boundary', () => {
  it('allows the exact default ChatGPT frame origin while rejecting unrelated sandbox origins', async () => {
    const runtime = loadConfig({ TASK_MAP_OWNER_SECRET: config.ownerSecret, TASK_MAP_SIGNING_SECRET: config.signingSecret, TASK_MAP_DB: ':memory:' });
    const app = createApp(runtime);
    const listener = app.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening', resolve));
    const address = listener.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const frame = 'https://web-sandbox-oaiusercontent-com.web-sandbox.oaiusercontent.com';
    try {
      const bound = await (await fetch(`${origin}/api/bind`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.ownerSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingKey: 'frame-origin-test', name: 'Frame test' }) })).json();
      const path = `${origin}/api/projects/${bound.state.projectId}`;
      const preflight = await fetch(path, { method: 'OPTIONS', headers: { Origin: frame, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(frame);
      const read = await fetch(path, { headers: { Origin: frame, Authorization: `Bearer ${bound.projectToken}` } });
      expect(read.status).toBe(200);
      expect(read.headers.get('access-control-allow-origin')).toBe(frame);
      expect((await fetch(path, { headers: { Origin: frame } })).status).toBe(401);
      for (const denied of ['null', 'https://other.web-sandbox.oaiusercontent.com', `${frame}.attacker.example`]) {
        expect((await fetch(path, { method: 'OPTIONS', headers: { Origin: denied } })).status).toBe(403);
      }
      const custom = loadConfig({ TASK_MAP_OWNER_SECRET: config.ownerSecret, TASK_MAP_SIGNING_SECRET: config.signingSecret, TASK_MAP_WIDGET_ORIGIN: 'https://custom.example' });
      expect(custom.allowedOrigins).not.toContain(frame);
    } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); app.close(); }
  });
  it('challenges unauthenticated MCP probes before checking content type or parsing JSON', async () => {
    const probes: RequestInit[] = [
      { method: 'POST' },
      { method: 'POST', body: '{}' },
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' },
      { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'text/plain' }, body: '{}' },
      { method: 'POST', headers: { Authorization: `Bearer ${auth.issue('oauth', undefined, -1)}` } },
    ];
    for (const probe of probes) {
      const response = await fetch(`${base}/mcp`, probe);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    }
    // Express also accepts these spellings; all matched MCP routes need the gate.
    for (const path of ['/mcp/', '/MCP']) {
      expect((await fetch(`${base}${path}`, { method: 'POST' })).status).toBe(401);
    }
  });
  it('keeps MCP media type, JSON and Origin checks after the authentication challenge', async () => {
    const bearer = { Authorization: `Bearer ${auth.issue('oauth')}` };
    for (const path of ['/mcp', '/mcp/', '/MCP']) {
      expect((await fetch(`${base}${path}`, { method: 'POST', headers: bearer })).status).toBe(415);
      expect((await fetch(`${base}${path}`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    }
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{invalid' })).status).toBe(400);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: config.publicUrl } })).status).toBe(204);
  });
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
  it('allows only the validated callback origin in form-action, preserving exact ports and IPv6', async () => {
    for (const redirect of [
      'https://client.example:8443/callback',
      'http://127.0.0.1:45678/callback',
      'http://[::1]:45678/callback',
      'https://client.example/callback;form-action=*?next=%0d%0aInjected-Header%3Ayes;frame-ancestors=*',
    ]) {
      const registration = await request('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '');
      expect(registration.status).toBe(201);
      const client = await registration.json();
      const verifier = randomBytes(48).toString('base64url');
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: `${config.publicUrl}/mcp` });
      const consent = await request(`/authorize?${query}`, undefined, '');
      expect(consent.status).toBe(200);
      const policy = consent.headers.get('content-security-policy')!;
      const directives = policy.split(';').map(value => value.trim());
      expect(directives.filter(value => value.startsWith('form-action'))).toEqual([`form-action 'self' ${new URL(redirect).origin}`]);
      expect(directives.filter(value => value.startsWith('frame-ancestors'))).toEqual(["frame-ancestors 'none'"]);
      expect(policy).not.toContain('*');
      expect(policy).not.toContain('Injected-Header');
      expect(consent.headers.get('referrer-policy')).toBe('same-origin');
    }
  });
  it('rejects callback host, port, and control-character injection before issuing a consent page', async () => {
    for (const redirect of [
      'https://client.example;frame-ancestors/callback',
      'https://client.example%3Bframe-ancestors/callback',
      'https://*.client.example/callback',
      'https://client.example:443;form-action/callback',
      'https://client.example/callback\r\nInjected-Header:yes',
      'https://client.example/callback with-space',
    ]) expect((await request('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '')).status).toBe(400);
  });
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
    for (const origin of ['null', 'https://attacker.example']) {
      const rejected = await request('/authorize', { intent, ownerSecret: config.ownerSecret }, '', { Cookie: cookie, Origin: origin });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    }
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
  it('provides scoped app-only reads and edits, preserving idempotency and AI/manual separation', async () => {
    const client = new Client({ name: 'widget-bridge-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${auth.issue('oauth')}` } } }));
    try {
      const a = await bind('bridge-a'), b = await bind('bridge-b');
      const args = { projectId: a.state.projectId, projectToken: a.projectToken };
      const tools = (await client.listTools()).tools;
      for (const name of ['read_project_view', 'edit_project_view']) expect(tools.find(t => t.name === name)?._meta).toHaveProperty('ui.visibility', ['app']);
      const read = await client.callTool({ name: 'read_project_view', arguments: { ...args, view: 'state' } });
      expect(read.structuredContent).toHaveProperty('data.state.version', 0);
      for (const invalid of [{ ...args, projectId: b.state.projectId }, { ...args, projectToken: config.ownerSecret }, { ...args, projectToken: `${a.projectToken}tampered` }]) {
        expect((await client.callTool({ name: 'read_project_view', arguments: { ...invalid, view: 'state' } })).isError).toBe(true);
      }
      const d = delta(a.state.projectId, 0, [{ type: 'ADD_NODE', node: { id: 'idea', title: '手动记想法', status: 'parking' } }], 'bridge-once');
      const change = { action: 'manual', delta: d };
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change } })).structuredContent).toHaveProperty('data.outcome', 'applied');
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change } })).structuredContent).toHaveProperty('data.outcome', 'duplicate');
      expect(store.get('personal-owner', a.state.projectId).nodes[0].manualOverride).toBe(true);
      const cross = { action: 'manual', delta: { ...d, projectId: b.state.projectId } };
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change: cross } })).isError).toBe(true);
      const ai = { action: 'ai', delta: { ...delta(a.state.projectId, 1, [{ type: 'UPDATE_NODE', nodeId: 'idea', changes: { title: 'AI override' } }]), source: 'manual' } };
      expect((await client.callTool({ name: 'edit_project_view', arguments: { ...args, change: ai } })).structuredContent).toHaveProperty('data.outcome', 'pending');
      expect(store.get('personal-owner', a.state.projectId).nodes[0].title).toBe('手动记想法');
      expect(store.get('personal-owner', b.state.projectId).version).toBe(0);
      expect((await client.callTool({ name: 'read_project_view', arguments: { ...args, view: 'md' } })).structuredContent).toHaveProperty('data', expect.stringContaining('手动记想法'));
    } finally { await client.close(); }
  });
  it('initializes, discovers annotated tools, binds, changes, deduplicates and exports', async () => {
    const client = new Client({ name: 'integration-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${auth.issue('oauth')}` } } }));
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toContain('assess_project_turn');
    expect(listed.tools.find(t => t.name === 'stage_project_delta')!.annotations!.readOnlyHint).toBe(false);
    for (const name of ['bind_project', 'get_project_state', 'apply_project_delta', 'assess_project_turn', 'reconcile_project']) {
      const descriptor = listed.tools.find(t => t.name === name)!;
      expect(descriptor).toBeDefined();
      expect(descriptor._meta).not.toHaveProperty('ui');
      expect(descriptor._meta).not.toHaveProperty('openai/outputTemplate');
    }
    // Existing conversation cards keep this identity across UI deployments.
    expect(listed.tools.find(t => t.name === 'get_project_map')!._meta).toHaveProperty('ui.resourceUri', 'ui://project-task-map/map-v3.html');
    expect(listed.tools.find(t => t.name === 'stage_project_delta')!._meta).toHaveProperty('ui.resourceUri', 'ui://project-task-map/map-v3.html');
    const bound = await client.callTool({ name: 'bind_project', arguments: { bindingKey: 'mcp-project', name: 'MCP Project' } });
    const state = (bound.structuredContent as { state: { projectId: string } }).state;
    expect(bound._meta).toHaveProperty('projectToken');
    expect(JSON.stringify(bound.structuredContent)).not.toContain(String(bound._meta!.projectToken));
    const d = delta(state.projectId, 0, [{ type: 'ADD_NODE', node: { id: 'mcp-node', title: '通过 MCP 保存' } }], 'mcp-idempotency');
    const first = await client.callTool({ name: 'apply_project_delta', arguments: { delta: d } });
    expect(first.structuredContent).toHaveProperty('outcome', 'applied');
    const duplicate = await client.callTool({ name: 'apply_project_delta', arguments: { delta: d } });
    expect(duplicate.structuredContent).toHaveProperty('outcome', 'duplicate');
    const read = await client.callTool({ name: 'get_project_state', arguments: { projectId: state.projectId } });
    const displayed = await client.callTool({ name: 'get_project_map', arguments: { projectId: state.projectId } });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toEqual(displayed.structuredContent);
    expect(read.structuredContent).toHaveProperty('state.version', 1);
    const exported = await client.callTool({ name: 'export_task_map', arguments: { projectId: state.projectId, format: 'md' } });
    expect(JSON.stringify(exported.content)).toContain('通过 MCP 保存');
    const resources = await client.listResources(); expect(resources.resources[0].uri).toContain('ui://');
    expect(resources.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining(['ui://project-task-map/map-v3.html', 'ui://project-task-map/map.html']));
    await client.close();
  });
});
