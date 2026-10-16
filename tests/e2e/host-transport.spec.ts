import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { Auth } from '../../src/server/auth';
import { loadConfig } from '../../src/server/config';

for (const bridge of ['legacy', 'standard'] as const) {
  test(`${bridge} bridge recovers stale v0 and saves an idea with browser networking disabled`, async ({ page, request, baseURL }) => {
    const auth = new Auth(loadConfig({ TASK_MAP_PUBLIC_URL: baseURL!, TASK_MAP_OWNER_SECRET: 'e2e-only-owner-secret-never-use-in-production', TASK_MAP_SIGNING_SECRET: 'e2e-only-signing-secret-never-use-in-production' }));
    const bound = await (await request.post('/api/bind', { headers: { Authorization: `Bearer ${auth.config.ownerSecret}` }, data: { bindingKey: `host-${bridge}-${Date.now()}`, name: '宿主传输验证' } })).json();
    const stale = bound.state;
    const timestamp = new Date().toISOString();
    const write = await request.post(`/api/projects/${stale.projectId}/manual`, { headers: { Authorization: `Bearer ${bound.projectToken}` }, data: { projectId: stale.projectId, expectedVersion: 0, idempotencyKey: 'initial', timestamp, source: 'manual', confidence: 1, evidence: [], operations: [{ type: 'ADD_NODE', node: { id: 'existing', title: '服务器已有任务' } }] } });
    expect(write.ok()).toBe(true);
    const calls: string[] = [];
    let failRead = true;
    await page.exposeFunction('hostToolCall', async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'read_project_view' && args.view === 'state' && failRead) { failRead = false; return { isError: true, content: [{ type: 'text', text: '模拟连接中断，请重试' }] }; }
      const response = await request.post('/mcp', { headers: { Authorization: `Bearer ${auth.issue('oauth')}`, Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: calls.length, method: 'tools/call', params: { name, arguments: args } } });
      expect(response.ok()).toBe(true);
      return (await response.json()).result;
    });
    const meta = { projectToken: bound.projectToken, apiBaseUrl: 'http://127.0.0.1:1' };
    await page.addInitScript(({ bridge, stale, meta }) => {
      if (window.parent === window) return;
      const w = window as unknown as { openai: unknown; hostToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>; browserFetches: number };
      w.browserFetches = 0;
      window.fetch = async () => { w.browserFetches++; throw new TypeError('Failed to fetch'); };
      if (bridge === 'legacy') w.openai = { toolOutput: { state: stale }, toolResponseMetadata: meta, callTool: (name: string, args: Record<string, unknown>) => w.hostToolCall(name, args) };
    }, { bridge, stale, meta });
    await page.route('**/host-harness', route => route.fulfill({ contentType: 'text/html', body: '<iframe title="map" sandbox="allow-scripts allow-forms" style="width:900px;height:1000px"></iframe>' }));
    await page.goto('/host-harness');
    if (bridge === 'standard') await page.evaluate(({ stale, meta }) => {
      window.addEventListener('message', async event => {
        const m = event.data;
        const reply = (result: unknown) => (event.source as Window).postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
        if (m.method === 'ui/initialize') reply({ protocolVersion: m.params.protocolVersion, hostInfo: { name: 'test', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: { displayMode: 'inline' } });
        if (m.method === 'ui/notifications/initialized') (event.source as Window).postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { state: stale }, _meta: meta } }, '*');
        if (m.method === 'tools/call') reply(await (window as unknown as { hostToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown> }).hostToolCall(m.params.name, m.params.arguments));
      });
    }, { stale, meta });
    await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, readFileSync('dist/ui/index.html', 'utf8'));
    const map = page.frameLocator('iframe');
    await expect(map.getByRole('alert')).toContainText('模拟连接中断');
    await expect(map.getByText('已载入最新项目地图。')).toHaveCount(0);
    await map.getByRole('button', { name: '重试连接' }).click();
    await expect(map.getByText('v1', { exact: true })).toBeVisible();
    await expect(map.getByRole('treeitem', { name: /服务器已有任务/ })).toBeVisible();
    await map.getByRole('button', { name: '＋ 记想法' }).click();
    await map.getByLabel('一句话想法').fill('宿主桥接保存的想法');
    await map.getByRole('button', { name: '存入 Parking Lot' }).click();
    await expect(map.getByText('v2', { exact: true })).toBeVisible();
    const saved = await (await request.get(`/api/projects/${stale.projectId}`, { headers: { Authorization: `Bearer ${bound.projectToken}` } })).json();
    expect(saved.state.nodes.map((node: { title: string }) => node.title)).toContain('宿主桥接保存的想法');
    expect(calls).toContain('edit_project_view');
    expect(await map.locator('body').evaluate(() => (window as unknown as { browserFetches: number }).browserFetches)).toBe(0);
  });
}

test('opaque map recovers a hanging host through scoped HTTPS GETs without stacking host reads or retrying writes', async ({ page, request, baseURL }) => {
  test.setTimeout(60000);
  const testSecrets = {
    TASK_MAP_OWNER_SECRET: 'e2e-only-owner-secret-never-use-in-production',
    TASK_MAP_SIGNING_SECRET: 'e2e-only-signing-secret-never-use-in-production',
  };
  const localAuth = new Auth(loadConfig({ ...testSecrets, TASK_MAP_PUBLIC_URL: baseURL! }));
  const bound = await (await request.post('/api/bind', {
    headers: { Authorization: `Bearer ${localAuth.config.ownerSecret}` },
    data: { bindingKey: `host-fallback-${Date.now()}`, name: '挂起读取恢复验证' },
  })).json();
  const stale = bound.state;
  const timestamp = new Date().toISOString();
  const changed = await request.post(`/api/projects/${stale.projectId}/manual`, {
    headers: { Authorization: `Bearer ${bound.projectToken}` },
    data: { projectId: stale.projectId, expectedVersion: 0, idempotencyKey: 'fallback-baseline', timestamp, source: 'manual', confidence: 1, evidence: [], operations: [{ type: 'ADD_NODE', node: { id: 'existing', title: 'HTTPS 已保存任务' } }] },
  });
  expect(changed.ok()).toBe(true);

  // Simulate the HTTPS reverse proxy while retaining server-side signature and
  // project-scope checks. The isolated HTTP test server has a different issuer.
  const publicOrigin = 'https://map.test';
  const publicAuth = new Auth(loadConfig({ ...testSecrets, TASK_MAP_PUBLIC_URL: publicOrigin }));
  const projectToken = publicAuth.issue('project', stale.projectId);
  const reads: string[] = [];
  await page.route(`${publicOrigin}/api/**`, async route => {
    const outgoing = route.request();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET' };
    if (outgoing.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    expect(outgoing.method()).toBe('GET');
    const url = new URL(outgoing.url());
    expect(url.search).toBe('');
    expect(outgoing.headers().cookie).toBeUndefined();
    const credential = outgoing.headers().authorization;
    expect(credential).toBe(`Bearer ${projectToken}`);
    const principal = publicAuth.verify(credential.slice(7), 'api');
    expect(principal.kind).toBe('project');
    expect(principal.projectId).toBe(stale.projectId);
    expect(url.pathname.startsWith(`/api/projects/${principal.projectId}`)).toBe(true);
    reads.push(url.pathname);
    const upstream = await request.get(`${baseURL}${url.pathname}`, { headers: { Authorization: `Bearer ${bound.projectToken}` } });
    await route.fulfill({ status: upstream.status(), contentType: 'application/json', headers: cors, body: await upstream.text() });
  });
  await page.addInitScript(({ stale, projectToken, publicOrigin }) => {
    if (window.parent === window) return;
    const hostWindow = window as unknown as { openai: unknown; hostCalls: { name: string; view?: string }[] };
    hostWindow.hostCalls = [];
    hostWindow.openai = {
      toolOutput: { state: stale }, toolResponseMetadata: { projectToken, apiBaseUrl: publicOrigin },
      callTool: (name: string, args: { view?: string }) => {
        hostWindow.hostCalls.push({ name, view: args.view });
        if (name === 'edit_project_view') return Promise.reject(new Error('宿主未允许保存'));
        return new Promise(() => {});
      },
    };
  }, { stale, projectToken, publicOrigin });
  await page.route('**/fallback-harness', route => route.fulfill({ contentType: 'text/html', body: '<iframe title="map" sandbox="allow-scripts allow-forms" style="width:900px;height:1000px"></iframe>' }));
  await page.goto('/fallback-harness');
  await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, readFileSync('dist/ui/index.html', 'utf8'));
  const map = page.frameLocator('iframe');
  await expect(map.getByText('正在检查连接', { exact: true })).toBeVisible();
  expect(reads).toEqual([]);
  // Use the real deadline: page-level fake clocks do not advance this opaque
  // srcdoc frame consistently in the installed browser.
  await expect(map.getByText('v1', { exact: true })).toBeVisible({ timeout: 35000 });
  await expect(map.getByRole('treeitem', { name: /HTTPS 已保存任务/ })).toBeVisible();
  await expect(map.getByText('已连接', { exact: true })).toBeVisible();

  // Repeated resume events reuse the unanswered host state call.
  await map.locator('body').evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('online')); });
  await expect.poll(() => reads.filter(path => path === `/api/projects/${stale.projectId}`).length).toBeGreaterThan(1);
  const hostCalls = await map.locator('body').evaluate(() => (window as unknown as { hostCalls: { name: string; view?: string }[] }).hostCalls);
  expect(hostCalls.filter(call => call.name === 'read_project_view' && call.view === 'state')).toHaveLength(1);

  await map.getByLabel('随手记想法').fill('不应绕过宿主保存的想法');
  await map.getByLabel('随手记想法').press('Enter');
  await expect(map.getByRole('alert')).toContainText('宿主未允许保存');
  const saved = await (await request.get(`/api/projects/${stale.projectId}`, { headers: { Authorization: `Bearer ${bound.projectToken}` } })).json();
  expect(saved.state.version).toBe(1);
  expect(saved.state.nodes.map((node: { title: string }) => node.title)).toEqual(['HTTPS 已保存任务']);
  expect(reads.every(path => path.startsWith(`/api/projects/${stale.projectId}`))).toBe(true);
});
