import { test, expect } from '@playwright/test';

test('bind, persist a real tree, edit manually, export, and restore the same binding', async ({ page, request }) => {
  const key = `browser-${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('项目名称', { exact: true }).fill('原生项目地图验收');
  await page.getByLabel('项目目标', { exact: false }).fill('在十秒内看清项目目标、焦点和下一步');
  await page.getByLabel('绑定 key', { exact: true }).fill(key);
  await page.getByLabel('部署者凭据').fill('e2e-only-owner-secret-never-use-in-production');
  await page.getByRole('button', { name: '连接项目地图' }).click();
  await expect(page.getByRole('heading', { name: '项目任务框架' })).toBeVisible();
  await page.getByRole('button', { name: '添加任务' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务名称').fill('打通 ChatGPT 集成');
  await dialog.getByRole('button', { name: '添加到地图' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tree')).toContainText('打通 ChatGPT 集成');
  await page.getByRole('button', { name: '刷新项目地图' }).click();
  await expect(page.getByLabel('项目概况恢复请求')).toHaveValue(/reconcile_project/);
  const rebound = await request.post('/api/bind', { headers: { Authorization: 'Bearer e2e-only-owner-secret-never-use-in-production' }, data: { bindingKey: key, name: '原生项目地图验收' } });
  const { state, projectToken } = await rebound.json();
  expect(state.nodes).toHaveLength(1);
  expect(state.nodes[0].manualOverride).toBe(true);
  const exported = await request.get(`/api/projects/${state.projectId}/artifact.md`, { headers: { Authorization: `Bearer ${projectToken}` } });
  expect(await exported.text()).toContain('打通 ChatGPT 集成');
  await page.reload();
  await page.getByLabel('项目名称', { exact: true }).fill('原生项目地图验收');
  await page.getByLabel('绑定 key', { exact: true }).fill(key);
  await page.getByLabel('部署者凭据').fill('e2e-only-owner-secret-never-use-in-production');
  await page.getByRole('button', { name: '连接项目地图' }).click();
  await expect(page.getByRole('tree')).toContainText('打通 ChatGPT 集成');
});

test('visual acceptance: goal, focus, tree, decisions and parking remain legible at desktop and narrow widths', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.getByText('CURRENT FOCUS / 当前焦点')).toBeVisible();
  await expect(page.getByText('GOAL / 项目目标')).toBeVisible();
  await page.screenshot({ path: 'test-results/task-map-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tree')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task-map-mobile.png', fullPage: true });
});
