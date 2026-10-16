// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App';
import { demoState } from '../src/ui/demo';
import type { HostAdapter, HostContext, ProjectState } from '../src/ui/types';

const map = (projectId = 'project-a', version = 12): ProjectState => ({ ...structuredClone(demoState), projectId, name: `项目 ${projectId}`, version });
const empty = (projectId = 'project-a', version = 0): ProjectState => ({ ...map(projectId, version), nodes: [], activeNodeId: null, parkingLot: [], decisions: [] });
const response = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value } as Response);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function bridge() {
  let deliver!: (context: HostContext) => void;
  const host: HostAdapter = { connect: vi.fn(async callback => { deliver = callback; }), sendRefresh: vi.fn(async () => false), close: vi.fn() };
  return { host, emit: async (context: HostContext) => { await act(async () => { deliver(context); }); } };
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); window.history.replaceState({}, '', '/');
  fetchMock = vi.fn(async (url: string) => response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: map() }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('first opening and project connection isolation', () => {
  it('waits honestly for connection metadata instead of treating an empty snapshot as a confirmed read', async () => {
    const b = bridge(); render(<App host={b.host} />);
    await b.emit({ state: empty() });
    expect(screen.getByText('只读预览')).toBeTruthy();
    expect(screen.getByText('当前快照还没有任务')).toBeTruthy();
    expect(screen.getByText(/等待宿主提供当前项目的连接信息/)).toBeTruthy();
    expect(screen.queryByText(/正在检查最新状态/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['metadata-first', 'state-first'] as const)('supports split first delivery: %s', async order => {
    const b = bridge(); render(<App host={b.host} />);
    const metadata = { projectToken: 'synthetic-a', apiBaseUrl: 'https://a.example' };
    for (const context of order === 'metadata-first' ? [metadata, { state: empty() }] : [{ state: empty() }, metadata]) await b.emit(context);
    await screen.findByText('已连接');
    expect(screen.getByText('v12')).toBeTruthy();
    const read = fetchMock.mock.calls.find(([url]) => url === 'https://a.example/api/projects/project-a');
    expect(read?.[1].headers.Authorization).toBe('Bearer synthetic-a');
  });

  it('retains initial connection props when the first project snapshot arrives later', async () => {
    const b = bridge(); render(<App initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await b.emit({ state: empty() }); await screen.findByText('已连接');
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://a.example/api/projects/project-a')).toBe(true);
  });

  it.each([0, 1])('explains a server-confirmed empty v%s and requests evidence-based sync without writing a fabricated map', async version => {
    const user = userEvent.setup(), b = bridge(); b.host.sendRefresh = vi.fn(async () => true);
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: empty('project-a', version) }));
    render(<App host={b.host} />); await b.emit({ state: empty('project-a', version), projectToken: 'synthetic-a', apiBaseUrl: 'https://a.example' });
    await screen.findByText('已连接'); expect(screen.getByText('当前地图尚未保存任务')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '整理当前可见进度' }));
    await screen.findByText(/已发送概况核对请求/);
    expect(b.host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining(`版本=${version}`));
    expect(b.host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining('reconcile_project'));
    expect(b.host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining('pending 仅表示待审'));
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(screen.getByText(`v${version}`)).toBeTruthy();
  });

  it('does not describe an unsuccessful empty read as confirmed', async () => {
    const b = bridge(); fetchMock.mockRejectedValue(new Error('合成读取故障'));
    render(<App host={b.host} />); await b.emit({ state: empty(), projectToken: 'synthetic-a', apiBaseUrl: 'https://a.example' });
    await screen.findByText('连接待恢复');
    expect(screen.getByText('当前快照还没有任务')).toBeTruthy();
    expect(screen.queryByText('当前地图尚未保存任务')).toBeNull();
  });

  it.each(['token-first', 'base-first'] as const)('clears the previous project connection and waits for all new HTTP metadata: %s', async order => {
    const b = bridge(); render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接'); fetchMock.mockClear();
    await b.emit({ state: empty('project-b') });
    expect(screen.getByText('只读预览')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
    const metadata = [{ projectToken: 'synthetic-b' }, { apiBaseUrl: 'https://b.example' }];
    if (order === 'base-first') metadata.reverse();
    await b.emit(metadata[0]); expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: map('project-b', 3) }));
    await b.emit(metadata[1]); await screen.findByText('已连接');
    expect(screen.getByText('v3')).toBeTruthy();
    expect(fetchMock.mock.calls.every(([url, init]) => String(url).startsWith('https://b.example/') && init.headers.Authorization === 'Bearer synthetic-b')).toBe(true);
  });

  it('shows the new project and clears old API credentials even if its new address is invalid', async () => {
    const b = bridge(); render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接'); fetchMock.mockClear();
    await b.emit({ state: empty('project-b'), projectToken: 'synthetic-b', apiBaseUrl: 'javascript:invalid' });
    expect(screen.getByText('项目 project-b')).toBeTruthy();
    expect(screen.getByText('后端地址必须使用 HTTP 或 HTTPS。')).toBeTruthy();
    expect(screen.getByText('只读预览')).toBeTruthy();
    await b.emit({ projectToken: 'synthetic-b' });
    act(() => window.dispatchEvent(new Event('online')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('permits the host tool transport without an HTTP URL', async () => {
    const b = bridge(); b.host.canCallTools = () => true;
    b.host.callTool = vi.fn(async (_name, args) => ({ data: args.view === 'state' ? { state: map('project-b', 3) } : args.view === 'conflicts' ? { conflicts: [] } : { history: [] } }));
    render(<App host={b.host} />); await b.emit({ state: empty('project-b'), projectToken: 'synthetic-b' });
    await screen.findByText('已连接'); expect(screen.getByText('v3')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes the previous connection when a same-project replacement address is invalid', async () => {
    const b = bridge(); render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接'); fetchMock.mockClear();
    await b.emit({ projectToken: 'synthetic-replacement', apiBaseUrl: 'javascript:invalid' });
    expect(screen.getByText('后端地址必须使用 HTTP 或 HTTPS。')).toBeTruthy();
    expect(screen.getByText('只读预览')).toBeTruthy();
    await b.emit({ projectToken: 'synthetic-replacement' });
    act(() => window.dispatchEvent(new Event('online')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores foreign staged updates and their connection metadata', async () => {
    const b = bridge(); render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接'); fetchMock.mockClear();
    await b.emit({ projectToken: 'synthetic-b', apiBaseUrl: 'https://b.example', pendingDelta: { projectId: 'project-b', idempotencyKey: 'foreign', expectedVersion: 0, timestamp: demoState.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] } });
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.every(([url, init]) => String(url).startsWith('https://a.example/') && init.headers.Authorization === 'Bearer synthetic-a' && init.method === 'GET')).toBe(true);
  });

  it('keeps server-confirmed tasks and focus when an empty host snapshot repeats the same version', async () => {
    const b = bridge(); render(<App initialState={empty('project-a', 12)} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接');
    expect(screen.getByRole('tree')).toBeTruthy();
    await b.emit({ state: empty('project-a', 12) });
    expect(screen.getByRole('tree')).toBeTruthy(); expect(screen.queryByText('尚未选择当前任务')).toBeNull();
    expect(screen.queryByText('当前地图尚未保存任务')).toBeNull();
    await b.emit({ state: empty('project-a', 13) });
    expect(screen.getByText('v13')).toBeTruthy(); expect(screen.queryByRole('tree')).toBeNull();
  });

  it('allows same-version enrichment before a server read is confirmed', async () => {
    const b = bridge(); render(<App host={b.host} />);
    await b.emit({ state: empty('project-a', 12) }); await b.emit({ state: map() });
    expect(screen.getByRole('tree')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores a delayed retry %s after A → B → A, including connection status and busy state', async outcome => {
    const user = userEvent.setup(), b = bridge(), old = deferred<Response>(), latest = deferred<Response>(); let reads = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/conflicts')) return response({ conflicts: [] });
      if (url.endsWith('/history')) return response({ history: [] });
      if (url.endsWith('/manual')) return latest.promise;
      if (url.endsWith('/project-b')) return response({ state: map('project-b', 2) });
      reads++; if (reads === 1) throw new Error('合成初次故障');
      if (reads === 2) return old.promise;
      return response({ state: map('project-a', 14) });
    });
    render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('连接待恢复'); await user.click(screen.getByRole('button', { name: '重试连接' }));
    await b.emit({ state: map('project-b', 2), projectToken: 'synthetic-b', apiBaseUrl: 'https://b.example' });
    await screen.findByText('v2'); await b.emit({ state: map('project-a', 14), projectToken: 'synthetic-a2', apiBaseUrl: 'https://a.example' });
    await screen.findByText('已连接'); await user.type(screen.getByLabelText('随手记想法'), '新项目操作{Enter}');
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    await act(async () => { if (outcome === 'resolve') old.resolve(response({ state: map('project-a', 99) })); else old.reject(new Error('迟到的旧故障')); });
    expect(screen.getByText('v14')).toBeTruthy(); expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.queryByText('迟到的旧故障')).toBeNull();
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    await act(async () => { latest.resolve(response({ state: map('project-a', 15), outcome: 'applied' })); });
    await screen.findByText('v15'); expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('false');
  });

  it.each(['resolve', 'reject'] as const)('ignores a delayed mutation %s after a project switch', async outcome => {
    const user = userEvent.setup(), b = bridge(), old = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/conflicts') ? { conflicts: [] } : url.endsWith('/history') ? { history: [] } : { state: map(url.includes('project-b') ? 'project-b' : 'project-a', 14) }));
    render(<App initialState={map()} initialToken="synthetic-a" apiBaseUrl="https://a.example" host={b.host} />);
    await screen.findByText('已连接');
    const immediate = fetchMock.getMockImplementation()! as (url: string, init: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init: RequestInit) => url.endsWith('/manual') ? old.promise : immediate(url, init));
    await user.type(screen.getByLabelText('随手记想法'), '旧操作{Enter}');
    await b.emit({ state: map('project-b', 14), projectToken: 'synthetic-b', apiBaseUrl: 'https://b.example' });
    await screen.findByText('已连接');
    await act(async () => { if (outcome === 'resolve') old.resolve(response({ state: map('project-a', 99), outcome: 'applied' })); else old.reject(new Error('迟到的写入故障')); });
    expect(screen.getByText('项目 project-b')).toBeTruthy(); expect(screen.getByText('v14')).toBeTruthy();
    expect(screen.queryByText('迟到的写入故障')).toBeNull(); expect(screen.queryByText('已保存，地图已更新。')).toBeNull();
  });
});
