import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { ProjectState } from '../src/domain/schema.js';

// Isolated in-memory projects: no production configuration or credentials.
const config: Config = { ownerSecret: 'synthetic-owner-'.repeat(4), signingSecret: 'synthetic-signing-'.repeat(4), publicUrl: 'http://127.0.0.1:3000', widgetOrigin: 'https://widget.example', allowedOrigins: ['http://127.0.0.1:3000'], dbPath: ':memory:', host: '127.0.0.1', port: 3000 };
let server: Server, client: Client, close: () => void;
const timestamp = '2026-10-11T08:00:00.000Z';
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as { state: ProjectState; outcome?: string };
}
beforeEach(async () => {
  const app = createApp(config); close = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  client = new Client({ name: 'first-open-synthetic-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${new Auth(config).issue('oauth')}` } } }));
});
afterEach(async () => { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); close(); });

describe('first-opening protocol with visible confirmed evidence', () => {
  it.each([false, true])('imports into the same empty binding, including after rename=%s, without duplicate tasks', async rename => {
    const binding = { bindingKey: 'synthetic-first-open', name: '合成项目' };
    const first = await call('bind_project', binding);
    if (rename) await call('bind_project', { ...binding, name: '合成项目改名' });
    const saved = (await call('get_project_state', { projectId: first.state.projectId })).state;
    expect(saved.nodes).toHaveLength(0); expect(saved.version).toBe(rename ? 1 : 0);
    const overview = { projectId: saved.projectId, expectedVersion: saved.version, reconcileId: 'synthetic-visible-import', timestamp, confidence: 1,
      coverage: '仅本测试提供的两项用户确认事实；未读取其他会话', evidence: [{ id: 'synthetic-confirmation', kind: 'turn', label: '合成用户确认', timestamp }],
      nodes: [{ id: 'confirmed-done', title: '已确认交付', status: 'done' }, { id: 'confirmed-next', title: '已确认下一项', status: 'todo' }] };
    const imported = await call('reconcile_project', { overview });
    expect(imported.outcome).toBe('applied');
    const opened = (await call('get_project_map', { projectId: saved.projectId })).state;
    expect(opened.projectId).toBe(first.state.projectId); expect(opened.nodes).toHaveLength(2);
    expect(opened.nodes.find(node => node.id === 'confirmed-done')?.status).toBe('done');
    const repeated = await call('reconcile_project', { overview: { ...overview, expectedVersion: opened.version, reconcileId: 'synthetic-recheck' } });
    expect(repeated.outcome).toBe('no_op'); expect(repeated.state.version).toBe(opened.version);
    expect(repeated.state.nodes.map(node => node.id)).toEqual(opened.nodes.map(node => node.id));
    const other = await call('bind_project', { bindingKey: 'synthetic-other', name: '合成项目' });
    expect(other.state.projectId).not.toBe(opened.projectId); expect(other.state.nodes).toHaveLength(0);
  });

  it('keeps a read-only opening empty when no confirmed project facts are supplied', async () => {
    const first = await call('bind_project', { bindingKey: 'synthetic-no-evidence', name: '合成空项目' });
    const read = await call('get_project_state', { projectId: first.state.projectId });
    const opened = await call('get_project_map', { projectId: first.state.projectId });
    expect(opened.state).toEqual(read.state); expect(opened.state.nodes).toHaveLength(0); expect(opened.state.version).toBe(0);
  });
});
