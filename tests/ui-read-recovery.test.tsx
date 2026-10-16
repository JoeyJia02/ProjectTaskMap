// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/ui/App';
import { demoState } from '../src/ui/demo';
import type { Conflict, HostAdapter, HostContext, ProjectState } from '../src/ui/types';

const snapshot = (version = 12): ProjectState => ({ ...structuredClone(demoState), version });
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value } as Response);
const quietHost = (): HostAdapter => ({ connect: vi.fn(async () => {}), sendRefresh: vi.fn(async () => false), close: vi.fn() });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear(); localStorage.clear();
  fetchMock = vi.fn(async (url: string) => response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: snapshot() }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('map read recovery', () => {
  it('shows the latest map even when history cannot be refreshed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/history')) throw new TypeError('history unavailable');
      return response(url.endsWith('/conflicts') ? { conflicts: [] } : { state: snapshot(13) });
    });
    render(<App initialState={snapshot()} initialToken="scoped-test-token" host={quietHost()} />);
    await screen.findByText('v13');
    await screen.findByText(/审批或版本记录暂未刷新/);
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.queryByText('连接待恢复')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a confirmed save successful when auxiliary reads subsequently fail', async () => {
    const user = userEvent.setup();
    let saved = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/manual')) { saved = true; return response({ state: snapshot(13), outcome: 'applied' }); }
      if (saved && /\/(conflicts|history)$/.test(url)) throw new TypeError('audit unavailable');
      return response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: snapshot(saved ? 13 : 12) });
    });
    render(<App initialState={snapshot()} initialToken="scoped-test-token" host={quietHost()} />);
    await screen.findByText('已连接');
    await user.type(screen.getByLabelText('随手记想法'), '已经确认保存的想法{Enter}');
    await screen.findByText('已保存，地图已更新。');
    await screen.findByText(/审批或版本记录暂未刷新/);
    expect((screen.getByLabelText('随手记想法') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('v13')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/manual'))).toHaveLength(1);
  });

  it('does not overlap reads on repeated resume events and polls after completion', async () => {
    vi.useFakeTimers();
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/demo-project')
      ? new Promise<Response>(resolve => { finish = resolve; })
      : response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App initialState={snapshot()} initialToken="scoped-test-token" host={quietHost()} />);
    await act(async () => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/demo-project'))).toHaveLength(1);
    await act(async () => { finish(response({ state: snapshot(13) })); });
    expect(screen.getByText('v13')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/demo-project'))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/demo-project'))).toHaveLength(2);
  });

  it('backs off offline reads while preserving the map and resumes immediately online', async () => {
    vi.useFakeTimers(); let offline = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (offline) throw new TypeError('offline');
      return response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: snapshot(13) });
    });
    render(<App initialState={snapshot()} initialToken="scoped-test-token" host={quietHost()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('v12')).toBeTruthy(); expect(screen.getByText('连接待恢复')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { offline = false; window.dispatchEvent(new Event('online')); });
    expect(screen.getByText('v13')).toBeTruthy(); expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('immediately retries the same project when fresh host credentials arrive', async () => {
    let deliver: (context: HostContext) => void = () => {};
    const host = quietHost(); host.connect = vi.fn(async callback => { deliver = callback; });
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if ((options.headers as Record<string, string>).Authorization === 'Bearer expired-test-token') throw new TypeError('old connection');
      return response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: snapshot(13) });
    });
    render(<App initialState={snapshot()} initialToken="expired-test-token" host={host} />);
    await screen.findByText('连接待恢复');
    await act(async () => { deliver({ state: snapshot(), projectToken: 'fresh-test-token' }); });
    await screen.findByText('v13');
    expect(screen.getByText('已连接')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not resurrect an approved card from a delayed pre-approval audit', async () => {
    const user = userEvent.setup();
    const conflict: Conflict = { id: 'pending-review', projectId: 'demo-project', kind: 'manual_override', message: '待审提案', status: 'pending', createdAt: demoState.updatedAt,
      delta: { projectId: 'demo-project', idempotencyKey: 'proposal', expectedVersion: 12, timestamp: demoState.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'COMPLETE_NODE', nodeId: 'ui' }] } };
    let approved = false, historyCalls = 0;
    let finishHistory: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/reviews/pending-review')) { approved = true; return response({ state: snapshot(13), outcome: 'applied', conflict: { ...conflict, status: 'approved' } }); }
      if (url.endsWith('/conflicts')) return response({ conflicts: approved ? [] : [conflict] });
      if (url.endsWith('/history') && ++historyCalls === 1) return new Promise<Response>(resolve => { finishHistory = resolve; });
      return response(url.endsWith('/history') ? { history: [] } : { state: snapshot(approved ? 13 : 12) });
    });
    render(<App initialState={snapshot()} initialToken="scoped-test-token" host={quietHost()} />);
    await screen.findByText('有 1 项更新需要你确认');
    await user.click(screen.getByRole('button', { name: '批准更改' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '批准更改' })).toBeNull());
    await act(async () => { finishHistory(response({ history: [] })); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/conflicts')).length).toBeGreaterThan(1));
    expect(screen.queryByText('有 1 项更新需要你确认')).toBeNull();
    expect(screen.getByText('v13')).toBeTruthy();
  });
});
