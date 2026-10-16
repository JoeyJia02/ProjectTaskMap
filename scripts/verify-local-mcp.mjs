import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A real OAuth/MCP smoke check for this local installation. Credentials stay in
// memory, never enter the evidence file, and are never sent beyond loopback.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = resolve(root, '.tmp/local-mcp-verification.json');
const bindingKey = 'taskmap-local-verification';
const projectName = '接入验证（非业务项目）';
const nodeId = 'mcp-read-write-verification';
const nodeTitle = '验证 MCP 读取、写入、完成与导出';
const redirectUri = 'http://127.0.0.1:43197/taskmap-verification/callback';
const scope = 'projects:read projects:write';
const flags = new Set(process.argv.slice(2));
let stage = 'configuration';
let client;
const report = {
  ok: false,
  checkedAt: new Date().toISOString(),
  mode: flags.has('--read-only') ? 'read-only' : 'read-write',
  bindingKey,
};

class CheckFailed extends Error {}
function check(value, reason) {
  if (!value) throw new CheckFailed(reason);
}
function saveReport() {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

try {
  check([...flags].every(flag => ['--read-only', '--refresh-check'].includes(flag)), 'unsupported_argument');
  const env = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));
  const url = new URL(env.TASK_MAP_PUBLIC_URL);
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash, 'requires_configured_loopback_origin');
  check(typeof env.TASK_MAP_OWNER_SECRET === 'string' && env.TASK_MAP_OWNER_SECRET.length >= 32, 'missing_owner_secret');
  const base = url.origin;
  const resource = `${base}/mcp`;
  report.origin = base;
  const previous = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined;
  if (flags.has('--read-only')) {
    check(previous?.ok && previous.origin === base && previous.bindingKey === bindingKey
      && typeof previous.projectId === 'string', 'run_read_write_verification_first');
  }

  async function localFetch(input, init = {}) {
    const target = new URL(input instanceof Request ? input.url : String(input));
    check(target.origin === base && !target.username && !target.password, 'nonlocal_request_blocked');
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000);
    return fetch(input, { ...init, redirect: 'manual', signal });
  }
  async function request(path, body, headers = {}) {
    return localFetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function jsonResponse(response, expected = 200) {
    check(response.status === expected, `unexpected_http_status_${response.status}`);
    return response.json();
  }

  stage = 'health';
  check((await jsonResponse(await request('/health'))).ok === true, 'health_check_failed');
  stage = 'oauth-discovery';
  const metadata = await jsonResponse(await request('/.well-known/oauth-authorization-server'));
  check(metadata.issuer === base && metadata.authorization_endpoint === `${base}/authorize`
    && metadata.token_endpoint === `${base}/token` && metadata.registration_endpoint === `${base}/register`, 'unexpected_oauth_endpoints');
  const protectedResource = await jsonResponse(await request('/.well-known/oauth-protected-resource/mcp'));
  check(protectedResource.resource === resource, 'unexpected_resource_identifier');

  stage = 'oauth-register';
  const registration = await jsonResponse(await request('/register', {
    client_name: 'Project Task Map Local Verification',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', ...(flags.has('--refresh-check') ? ['refresh_token'] : [])],
    response_types: ['code'],
  }), 201);
  check(typeof registration.client_id === 'string', 'missing_client_id');
  const verifier = randomBytes(48).toString('base64url');
  const stateNonce = randomBytes(24).toString('base64url');
  const query = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource,
    scope,
    state: stateNonce,
  });
  stage = 'oauth-consent';
  const consent = await request(`/authorize?${query}`);
  check(consent.status === 200, 'consent_page_unavailable');
  const html = await consent.text();
  const intent = html.match(/name="intent" value="([A-Za-z0-9_-]+)"/)?.[1];
  const cookie = consent.headers.getSetCookie().find(value => value.startsWith('taskmap_oauth='))?.split(';')[0];
  check(intent && cookie === `taskmap_oauth=${intent}`, 'missing_bound_consent_cookie');
  const approval = await request('/authorize', { intent, ownerSecret: env.TASK_MAP_OWNER_SECRET }, { Cookie: cookie });
  check(approval.status === 303, 'owner_consent_failed');
  const callback = new URL(approval.headers.get('location'));
  const expectedCallback = new URL(redirectUri);
  check(callback.origin === expectedCallback.origin && callback.pathname === expectedCallback.pathname
    && !callback.username && !callback.password && !callback.hash
    && callback.searchParams.get('state') === stateNonce && callback.searchParams.has('code'), 'invalid_authorization_callback');
  // The callback is inspected in memory, never visited or printed.
  stage = 'oauth-token';
  let tokens = await jsonResponse(await request('/token', {
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code'),
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    resource,
    code_verifier: verifier,
  }));
  check(typeof tokens.access_token === 'string' && tokens.token_type.toLowerCase() === 'bearer'
    && tokens.scope === scope, 'invalid_token_response');
  report.oauth = { authorizationCodePkce: true, cookieBoundConsent: true, refresh: 'not-requested' };
  if (flags.has('--refresh-check')) {
    stage = 'oauth-refresh';
    check(metadata.grant_types_supported?.includes('refresh_token') && typeof tokens.refresh_token === 'string', 'refresh_not_supported');
    const oldRefreshToken = tokens.refresh_token;
    tokens = await jsonResponse(await request('/token', {
      grant_type: 'refresh_token',
      refresh_token: oldRefreshToken,
      client_id: registration.client_id,
      resource,
    }));
    check(typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string'
      && tokens.refresh_token !== oldRefreshToken && tokens.scope === scope, 'refresh_rotation_failed');
    report.oauth.refresh = 'rotated-once';
  }

  stage = 'mcp-initialize';
  client = new Client({ name: 'taskmap-local-verification', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    fetch: async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      check(target.href === resource, 'unexpected_mcp_request_destination');
      return localFetch(input, init);
    },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  }));
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  check(['bind_project', 'get_project_state', 'get_project_map', 'apply_project_delta', 'export_task_map'].every(name => tools.includes(name)), 'required_tools_missing');
  report.tools = tools;
  async function call(name, args) {
    stage = name;
    const result = await client.callTool({ name, arguments: args });
    check(!result.isError, 'mcp_tool_returned_error');
    return result;
  }
  const stateFrom = result => {
    const state = result.structuredContent?.state;
    check(state?.name === projectName && typeof state.projectId === 'string'
      && Number.isInteger(state.version) && Array.isArray(state.nodes), 'unexpected_verification_project');
    return state;
  };
  let current = flags.has('--read-only')
    ? stateFrom(await call('get_project_map', { projectId: previous.projectId }))
    : stateFrom(await call('bind_project', {
      bindingKey,
      name: projectName,
      goal: '仅验证本地 OAuth 与 MCP 接入，不承载真实业务任务。',
    }));
  report.projectId = current.projectId;
  report.initialVersion = current.version;
  let node = current.nodes.find(item => item.id === nodeId);
  check(!node || node.title === nodeTitle, 'verification_node_identity_changed');
  async function mutate(operation, purpose) {
    const timestamp = new Date().toISOString();
    const result = await call('apply_project_delta', { delta: {
      projectId: current.projectId,
      expectedVersion: current.version,
      idempotencyKey: `local-verification:${purpose}:${current.version}`,
      timestamp,
      source: 'ai',
      confidence: 1,
      evidence: [{ id: `local-mcp-check-${purpose}`, kind: 'file', label: '本地 MCP 验证脚本', timestamp,
        excerpt: `scripts/verify-local-mcp.mjs：${purpose}；仅操作接入验证项目。` }],
      operations: [operation],
    } });
    check(result.structuredContent?.outcome === 'applied', 'verification_mutation_not_applied');
    current = stateFrom(result);
  }
  if (!flags.has('--read-only')) {
    if (!node) {
      await mutate({ type: 'ADD_NODE', node: { id: nodeId, title: nodeTitle, status: 'todo' } }, 'create');
      node = current.nodes.find(item => item.id === nodeId);
    }
    check(node && ['todo', 'active', 'done'].includes(node.status), 'verification_node_requires_review');
    if (node.status !== 'done') await mutate({ type: 'COMPLETE_NODE', nodeId }, 'complete');
  }
  const opened = await call('get_project_map', { projectId: current.projectId });
  const reread = stateFrom(opened);
  const viaHost = await call('read_project_view', { projectId: current.projectId, projectToken: opened._meta.projectToken, view: 'state' });
  check(JSON.stringify(viaHost.structuredContent?.data?.state) === JSON.stringify(reread), 'host_bridge_read_mismatch');
  report.hostBridgeRead = true;
  check(reread.version === current.version && reread.nodes.some(item => item.id === nodeId && item.status === 'done'), 'saved_completed_node_not_found');
  if (flags.has('--read-only')) check(reread.version >= previous.version, 'saved_version_regressed');
  const exported = await call('export_task_map', { projectId: current.projectId, format: 'md' });
  const markdown = exported.content?.find(item => item.type === 'resource' && item.resource.mimeType === 'text/markdown')?.resource.text;
  check(typeof markdown === 'string' && markdown.includes(nodeTitle), 'markdown_export_missing_node');
  const resources = await client.listResources();
  check(resources.resources.some(item => item.uri === 'ui://project-task-map/map.html'), 'ui_resource_missing');
  Object.assign(report, {
    ok: true,
    version: reread.version,
    nodeId,
    nodeStatus: 'done',
    projectMutated: reread.version !== report.initialVersion,
    ...(previous?.ok && previous.projectId === reread.projectId ? { previousVersion: previous.version, unchangedSincePreviousRun: previous.version === reread.version } : {}),
    markdownBytes: Buffer.byteLength(markdown),
    uiResourceDiscovered: true,
  });
} catch (error) {
  report.failedStage = stage;
  // SDK/network errors may contain URLs or headers. Never print their raw text.
  report.failure = error instanceof CheckFailed ? error.message : 'local_configuration_network_or_protocol_error';
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  try { saveReport(); } catch { report.evidenceWriteFailed = true; process.exitCode = 1; }
  console.log(JSON.stringify(report));
}
