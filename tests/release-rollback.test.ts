import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Auth, MCP_SCOPE, OWNER } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import { OAuthStore } from '../src/server/oauth-store.js';
import type { ProjectState } from '../src/domain/schema.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('../src/server/app.ts', import.meta.url));
const helperPath = fileURLToPath(new URL('./helpers/release-probe.mjs', import.meta.url));
const backupPath = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
const timestamp = '2026-09-30T00:00:00.000Z';
const at = Date.parse(timestamp) / 1000;
const uris = ['ui://project-task-map/map-v3.html', 'ui://project-task-map/map-v2.html',
  'ui://project-task-map/map-v4.html', 'ui://project-task-map/map.html'];
// This checks server asset delivery and URI compatibility, not browser rendering.
const knownGoodHtml = '<!doctype html><html><body>synthetic known-good release</body></html>';
let folder: string, database: string, asset: string, config: Config;
const children = new Set<ChildProcess>();
const clients = new Set<Client>();

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'taskmap-release-'));
  database = join(folder, 'candidate.sqlite');
  asset = join(folder, 'dist', 'ui', 'index.html');
  mkdirSync(join(folder, 'dist', 'ui'), { recursive: true });
  writeFileSync(asset, knownGoodHtml);
  config = { ownerSecret: 'synthetic-release-owner-'.repeat(3), signingSecret: 'synthetic-release-signing-'.repeat(3),
    publicUrl: 'http://127.0.0.1:9009', widgetOrigin: 'https://widget.example.test',
    allowedOrigins: ['https://widget.example.test'], dbPath: database, host: '127.0.0.1', port: 9009 };
});

async function stop(child: ChildProcess) {
  if (!children.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = once(child, 'exit');
  if (child.connected) child.send('stop'); else child.kill();
  const timer = setTimeout(() => child.kill(), 5000);
  try { await exited; } finally { clearTimeout(timer); children.delete(child); }
}

afterEach(async () => {
  for (const client of clients) await client.close();
  clients.clear();
  for (const child of children) await stop(child);
  // Remove only a directory created by this test; never a computed project path.
  expect(relative(resolve(tmpdir()), resolve(folder))).toMatch(/^taskmap-release-[^\\/]+$/);
  rmSync(folder, { recursive: true, force: true });
});

async function start(dbPath = database) {
  expect(existsSync(join(folder, '.env'))).toBe(false);
  const child = fork(helperPath, [appPath, JSON.stringify({ ...config, dbPath })], {
    cwd: folder, execArgv: ['--import', pathToFileURL(require.resolve('tsx')).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  const base = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic server did not start: ${errors}`)), 8000);
    child.once('message', message => { clearTimeout(timer); accept((message as { base: string }).base); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic server exited ${code}: ${errors}`)); });
  });
  const request = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.ownerSecret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const client = new Client({ name: 'release-acceptance', version: '1.0' });
  clients.add(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${new Auth(config).issue('oauth')}` } },
  }));
  return { child, client, request, base };
}

const delta = (projectId: string, expectedVersion: number, key: string, title: string) => ({
  projectId, expectedVersion, idempotencyKey: key, timestamp, source: 'ai', confidence: 1,
  evidence: [{ id: key, kind: 'turn', label: 'Synthetic acceptance only', timestamp }],
  operations: [{ type: 'ADD_NODE', node: { id: key, title } }],
});

async function verifyResources(client: Client) {
  const tools = await client.listTools();
  for (const name of ['get_project_map', 'stage_project_delta']) {
    expect(tools.tools.find(tool => tool.name === name)?._meta).toHaveProperty('ui.resourceUri', uris[0]);
  }
  for (const uri of uris) {
    const result = await client.readResource({ uri });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app', text: knownGoodHtml });
  }
}

async function assertStateAndHistory(runtime: Awaited<ReturnType<typeof start>>, expected: ProjectState) {
  const response = await runtime.request(`/api/projects/${expected.projectId}`);
  expect(response.status).toBe(200);
  expect((await response.json()).state).toEqual(expected);
  const history = await (await runtime.request(`/api/projects/${expected.projectId}/history`)).json();
  expect(history.history.map((entry: { version: number }) => entry.version)).toEqual(
    Array.from({ length: expected.version + 1 }, (_, index) => expected.version - index));
  const read = await runtime.client.callTool({ name: 'get_project_state', arguments: { projectId: expected.projectId } });
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent).toHaveProperty('state', expected);
  const binding = await (await runtime.request('/api/bind', { bindingKey: 'release-test', name: expected.name })).json();
  expect(binding.state.projectId).toBe(expected.projectId);
  expect(binding.state).toEqual(expected);
}

describe('isolated release failure and rollback acceptance', () => {
  it('rejects a healthy backend with a missing UI asset, then restores asset delivery without losing newer data', async () => {
    const first = await start();
    await verifyResources(first.client);
    const bound = await (await first.request('/api/bind', { bindingKey: 'release-test', name: 'Synthetic release', goal: 'Recovery acceptance' })).json();
    const proposal = delta(bound.state.projectId, 0, 'newer-write', 'Keep post-upgrade write');
    const result = await (await first.request(`/api/projects/${bound.state.projectId}/deltas`, proposal)).json();
    expect(result.outcome).toBe('applied');
    await first.client.close(); clients.delete(first.client); await stop(first.child);

    rmSync(asset);
    const failed = await start();
    expect((await failed.request('/health')).status).toBe(200);
    await expect(failed.client.readResource({ uri: uris[0] })).rejects.toThrow(/ENOENT/);
    await assertStateAndHistory(failed, result.state);
    await failed.client.close(); clients.delete(failed.client); await stop(failed.child);

    writeFileSync(asset, knownGoodHtml);
    const recovered = await start();
    await verifyResources(recovered.client);
    await assertStateAndHistory(recovered, result.state);
    const replay = await (await recovered.request(`/api/projects/${bound.state.projectId}/deltas`, proposal)).json();
    expect(replay.outcome).toBe('duplicate');
    expect(replay.state).toEqual(result.state);
    // This is an asset rollback with current backend code, not a full code downgrade.
  });

  it('backs up live WAL data and OAuth grants, restores to a new path, and preserves the failed database for comparison', async () => {
    const running = await start();
    const bound = await (await running.request('/api/bind', { bindingKey: 'release-test', name: 'Synthetic backup', goal: 'Backup acceptance' })).json();
    const proposal = delta(bound.state.projectId, 0, 'before-backup', 'In consistent backup');
    const before = await (await running.request(`/api/projects/${bound.state.projectId}/deltas`, proposal)).json();
    const oauth = new OAuthStore(config);
    let grant: ReturnType<OAuthStore['createGrant']>, clientId: string;
    try {
      clientId = oauth.register(['https://client.example.test/callback'], at).clientId;
      grant = oauth.createGrant(clientId, `${config.publicUrl}/mcp`, MCP_SCOPE, at);
      expect(statSync(`${database}-wal`).size).toBeGreaterThan(0);
      const backup = join(folder, 'consistent-backup.sqlite');
      const env = { ...process.env, TASK_MAP_DB: database };
      await exec(process.execPath, [backupPath, backup], { cwd: folder, env, timeout: 8000 });
      const savedBytes = readFileSync(backup);
      await expect(exec(process.execPath, [backupPath, backup], { cwd: folder, env, timeout: 8000 })).rejects.toThrow();
      expect(readFileSync(backup)).toEqual(savedBytes);
      await expect(exec(process.execPath, [backupPath, database], { cwd: folder, env, timeout: 8000 })).rejects.toThrow();

      const after = await (await running.request(`/api/projects/${bound.state.projectId}/deltas`,
        delta(bound.state.projectId, 1, 'after-backup', 'Retained in failed candidate only'))).json();
      expect(after.state.version).toBe(2);
      await running.client.close(); clients.delete(running.client); await stop(running.child);
      oauth.close();
      const failedBytes = readFileSync(database);
      const restoredPath = join(folder, 'restored-new-path.sqlite');
      copyFileSync(backup, restoredPath);
      const restored = await start(restoredPath);
      await assertStateAndHistory(restored, before.state);
      await verifyResources(restored.client);
      const replay = await (await restored.request(`/api/projects/${bound.state.projectId}/deltas`, proposal)).json();
      expect(replay.outcome).toBe('duplicate');
      expect(replay.state).toEqual(before.state);
      const restoredOAuth = new OAuthStore({ ...config, dbPath: restoredPath });
      try {
        expect(restoredOAuth.getClient(clientId)).toBeDefined();
        const rotated = restoredOAuth.rotate(grant.refreshToken, clientId, `${config.publicUrl}/mcp`, MCP_SCOPE, at + 60);
        expect(rotated).toMatchObject({ familyId: grant.familyId, expires: grant.expires });
      } finally { restoredOAuth.close(); }
      const preserved = new DatabaseSync(database, { readOnly: true });
      try {
        const row = preserved.prepare('SELECT state_json FROM projects WHERE project_id = ? AND owner_id = ?').get(bound.state.projectId, OWNER)!;
        expect(JSON.parse(String(row.state_json))).toEqual(after.state);
      } finally { preserved.close(); }
      expect(readFileSync(database)).toEqual(failedBytes);
      expect(readFileSync(backup)).toEqual(savedBytes);
    } finally { oauth.close(); }
  });
});
