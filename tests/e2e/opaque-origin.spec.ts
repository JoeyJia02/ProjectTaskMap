import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { demoState } from '../../src/ui/demo';

for (const empty of [true, false]) {
  test(`opaque srcdoc map loads ${empty ? 'empty' : 'populated'} state and accepts the host API URL`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const state = empty ? { ...demoState, nodes: [], decisions: [], parkingLot: [], activeNodeId: null } : demoState;
    await page.addInitScript(state => {
      if (window.parent !== window) (window as unknown as { openai: unknown }).openai = {
        toolOutput: { state }, toolResponseMetadata: { apiBaseUrl: 'https://map.test', projectToken: 'test-only' },
      };
    }, state);
    await page.route('https://map.test/**', route => route.fulfill({
      contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization' },
      body: JSON.stringify(route.request().url().endsWith('/history') ? { history: [] } : route.request().url().endsWith('/conflicts') ? { conflicts: [] } : { state }),
    }));
    await page.route('**/opaque-harness', route => route.fulfill({ contentType: 'text/html', body: '<iframe title="map" sandbox="allow-scripts" style="width:900px;height:900px"></iframe>' }));
    await page.goto('/opaque-harness');
    await page.locator('iframe').evaluate((frame, html) => { (frame as HTMLIFrameElement).srcdoc = html; }, readFileSync('dist/ui/index.html', 'utf8'));
    const map = page.frameLocator('iframe');
    await expect(map.getByRole('heading', { name: '项目任务框架', exact: true })).toBeVisible();
    await expect(map.getByText('已连接', { exact: true })).toBeVisible();
    await map.getByRole('button', { name: /^Parking Lot/ }).click();
    await expect(map.getByRole('heading', { name: '快速记想法' })).toBeVisible();
    await expect(map.getByText('地图显示遇到问题', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
