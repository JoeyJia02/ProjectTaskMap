import { test, expect } from '@playwright/test';
import { demoState } from '../../src/ui/demo';

test('embedded map remains rendered through long scrolling, resize, hide/show and shorter tabs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/scroll-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0"><iframe title="map" src="/" style="width:100%;height:700px;border:0;display:block"></iframe><script>
    window.sizeReports=[];
    window.addEventListener('message',event=>{
      const m=event.data;
      if(m.method==='ui/initialize')event.source.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,hostInfo:{name:'scroll-test',version:'1'},hostCapabilities:{},hostContext:{displayMode:'fullscreen'}}},event.origin);
      if(m.method==='ui/notifications/initialized')event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:{state:${JSON.stringify(demoState)}}}},event.origin);
      if(m.method==='ui/notifications/size-changed'){window.sizeReports.push(m.params);document.querySelector('iframe').style.height=m.params.height+'px';}
    });
  </script></body></html>` }));
  await page.goto('/scroll-harness');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: '项目任务框架' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { sizeReports: unknown[] }).sizeReports.length)).toBeGreaterThan(0);
  for (const width of [800, 430, 1000]) {
    await page.setViewportSize({ width, height: 850 });
    await frame.locator('.app-footer').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 1200);
    await expect(frame.locator('.app-footer')).toBeInViewport();
    await frame.getByRole('heading', { name: '项目任务框架' }).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, -2000);
    await expect(frame.getByRole('heading', { name: '项目任务框架' })).toBeInViewport();
    await frame.getByRole('button', { name: '决策日志', exact: true }).click();
    await expect(frame.locator('.app-footer')).toBeVisible();
    await frame.getByRole('button', { name: '概览', exact: true }).click();
  }
  await page.locator('iframe').evaluate(element => { element.style.display = 'none'; });
  await page.locator('iframe').evaluate(element => { element.style.display = 'block'; });
  await expect(frame.getByRole('heading', { name: '项目任务框架' })).toBeVisible();
  expect(errors).toEqual([]);
  const reports = await page.evaluate(() => (window as unknown as { sizeReports: { height: number }[] }).sizeReports);
  expect(reports.every(item => item.height > 0 && item.height < 10000)).toBe(true);
  expect(reports.length).toBeLessThan(100);
  await page.screenshot({ path: '.tmp/scroll-embedded.png', fullPage: true });
});
