import { test, expect } from '@playwright/test';

test('failed approval cannot grow the queue, and valid approval still saves once', async ({ page, request }) => {
  const owner = 'e2e-only-owner-secret-never-use-in-production';
  const key = `review-browser-${Date.now()}`;
  const bound = await (await request.post('/api/bind', { headers: { Authorization: `Bearer ${owner}` }, data: { bindingKey: key, name: '审批验收' } })).json();
  const id = bound.state.projectId;
  const headers = { Authorization: `Bearer ${bound.projectToken}` };
  const path = `/api/projects/${id}`;
  const make = (version: number, operations: unknown[], stamp: string) => ({ projectId: id, expectedVersion: version, idempotencyKey: stamp, source: 'ai', confidence: 1, timestamp: new Date().toISOString(), evidence: [{ id: stamp, kind: 'manual', label: '测试', timestamp: new Date().toISOString() }], operations });
  const added = await request.post(`${path}/manual`, { headers, data: make(0, [{ type: 'ADD_NODE', node: { id: 'task', title: '已有任务', summary: '原始说明' } }], 'add') });
  expect(added.ok()).toBe(true);
  const conflict = await (await request.post(`${path}/deltas`, { headers, data: make(1, [{ type: 'ADD_NODE', node: { id: 'duplicate', title: '已有任务', summary: '覆盖说明' } }], 'duplicate') })).json();
  for (let i = 0; i < 6; i++) {
    const failed = await request.post(`${path}/reviews/${conflict.conflict.id}`, { headers, data: { action: 'approve', expectedVersion: 1 } });
    expect(failed.status()).toBe(409);
  }
  expect((await (await request.get(`${path}/conflicts`, { headers })).json()).conflicts).toHaveLength(1);
  await page.goto('/');
  await page.getByLabel('项目名称', { exact: true }).fill('审批验收');
  await page.getByLabel('绑定 key', { exact: true }).fill(key);
  await page.getByLabel('部署者凭据').fill(owner);
  await page.getByRole('button', { name: '连接项目地图' }).click();
  await expect(page.getByText('有 1 项更新需要你确认')).toBeVisible();
  await expect(page.getByText(/提案中的新增任务已存在/)).toBeVisible();
  await expect(page.getByRole('button', { name: '批准更改' })).toHaveCount(0);
  await page.getByRole('button', { name: '保留当前' }).click();
  await expect(page.getByText('有 1 项更新需要你确认')).toHaveCount(0);
  const valid = await (await request.post(`${path}/deltas`, { headers, data: make(1, [{ type: 'UPDATE_NODE', nodeId: 'task', changes: { summary: '经批准的新说明' } }], 'edit') })).json();
  expect(valid.outcome).toBe('pending');
  // Trigger the same read-only recovery path as returning to the app.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: '批准更改' }).click();
  await expect(page.getByText('有 1 项更新需要你确认')).toHaveCount(0);
  const saved = await (await request.get(path, { headers })).json();
  expect(saved.state.version).toBe(2); expect(saved.state.nodes).toHaveLength(1);
  expect(saved.state.nodes[0].summary).toBe('经批准的新说明');
});
