import { test, expect } from '@playwright/test';
import { demoState } from '../../src/ui/demo';

test('an injected host bridge remains visible beyond the old six-second second-handshake timeout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(state => {
    if (window.parent !== window) (window as unknown as { openai: unknown }).openai = { toolOutput: { state } };
  }, demoState);
  await page.route('**/legacy-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><iframe title="map" src="/" style="width:800px;height:800px"></iframe><script>
    window.handshakes=[];
    window.addEventListener('message',event=>{
      if(event.data?.method==='ui/initialize'||event.data?.method==='notifications/cancelled')window.handshakes.push(event.data.method);
    });
  </script></body></html>` }));
  await page.goto('/legacy-harness');
  const map = page.frameLocator('iframe');
  await expect(map.getByRole('heading', { name: '项目任务框架' })).toBeVisible();
  // Exercise the real timer: this deliberately exceeds the previous handshake deadline.
  await page.waitForTimeout(11000);
  expect(await page.evaluate(() => (window as unknown as { handshakes: string[] }).handshakes)).toEqual([]);
  await expect(map.getByRole('heading', { name: '项目任务框架' })).toBeVisible();
  await map.getByRole('button', { name: /^Parking Lot/ }).click();
  await expect(map.getByRole('heading', { name: '快速记想法' })).toBeVisible();
  expect(errors).toEqual([]);
});
