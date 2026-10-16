// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { observeContentSize } from '../src/ui/resize';
import { MapBoundary } from '../src/ui/MapBoundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports content changes without changing document height, ignores hidden zero sizes and stops after disposal', async () => {
  let resized = () => {}; let nextFrame = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const root = document.createElement('div'); let height = 2300;
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ height } as DOMRect));
  const report = vi.fn(async () => {});
  const previousHeight = document.documentElement.style.height;
  const stop = observeContentSize(root, report);
  nextFrame(); resized(); nextFrame();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith({ width: window.innerWidth, height: 2300 });
  height = 0; resized(); nextFrame(); expect(report).toHaveBeenCalledTimes(1);
  height = 450; resized(); nextFrame(); expect(report).toHaveBeenLastCalledWith({ width: window.innerWidth, height: 450 });
  expect(document.documentElement.style.height).toBe(previousHeight);
  stop(); height = 900; resized(); nextFrame();
  expect(report).toHaveBeenCalledTimes(2); expect(disconnect).toHaveBeenCalledOnce();
});

it('shows a recovery control instead of an empty root after a rendering exception', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  function Fragile() { if (fail) throw Error('test rendering failure'); return <h1>任务地图恢复</h1>; }
  render(<MapBoundary><Fragile /></MapBoundary>);
  expect(screen.getByRole('alert').textContent).toContain('地图显示遇到问题');
  fail = false;
  act(() => fireEvent.click(screen.getByRole('button', { name: '恢复地图显示' })));
  expect(screen.getByRole('heading', { name: '任务地图恢复' })).toBeTruthy();
});
