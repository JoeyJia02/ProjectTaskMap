// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, refreshPrompt } from '../src/ui/App';
import { TaskTree } from '../src/ui/TaskTree';
import { parseToolResult } from '../src/ui/host';
import { demoState } from '../src/ui/demo';
import { ApiClient } from '../src/ui/api';
import type { Conflict, Delta, HostAdapter, HostContext, ProjectState } from '../src/ui/types';

const state = (): ProjectState => structuredClone(demoState);
function response(value: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => String(value) } as Response; }
const quietHost = (): HostAdapter => ({ connect: vi.fn(async () => {}), sendRefresh: vi.fn(async () => false), close: vi.fn() });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, '', '/');
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/conflicts')) return response({ conflicts: [] });
    if (url.endsWith('/history')) return response({ history: [] });
    return response({ state: state() });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('project UI', () => {
  it('recovers reads when the network returns without clearing an unrelated write error', async () => {
    const user = userEvent.setup(); let offline = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/manual')) return response({ error: '需要重新核对提案' }, 409);
      if (offline) throw new TypeError('Failed to fetch');
      if (url.endsWith('/conflicts')) return response({ conflicts: [] });
      if (url.endsWith('/history')) return response({ history: [] });
      return response({ state: state() });
    });
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await screen.findByText('连接待恢复');
    expect(screen.getByText('v12')).toBeTruthy();
    offline = false;
    act(() => window.dispatchEvent(new Event('online')));
    await screen.findByText('已连接');
    await user.type(screen.getByLabelText('随手记想法'), '保留我的草稿{Enter}');
    await screen.findByText('需要重新核对提案');
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.getByText('已连接')).toBeTruthy());
    expect(screen.getByText('需要重新核对提案')).toBeTruthy();
    expect((screen.getByLabelText('随手记想法') as HTMLInputElement).value).toBe('保留我的草稿');
  });
  it.each([{ operations: [] }, { operations: [{ type: 'NO_OP' }] }])('does not offer approval for a proposal without executable operations (%j)', async ({ operations }) => {
    const user = userEvent.setup(); let dismissed = false;
    const conflict: Conflict = { id: 'invalid-focus', projectId: 'demo-project', kind: 'invalid_focus', message: 'Overview contains multiple active tasks', status: 'pending', createdAt: demoState.updatedAt,
      delta: { projectId: 'demo-project', idempotencyKey: 'invalid-overview', expectedVersion: 0, timestamp: demoState.updatedAt, source: 'reconcile', confidence: 1, evidence: [], operations } };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/reviews/invalid-focus')) { dismissed = true; return response({ state: state(), outcome: 'no_op' }); }
      if (url.endsWith('/conflicts')) return response({ conflicts: dismissed ? [] : [conflict] });
      if (url.endsWith('/history')) return response({ history: [] });
      return response({ state: state() });
    });
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await screen.findByText(/这份旧提案设置了多个当前任务/);
    expect(screen.queryByRole('button', { name: '批准更改' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '保留当前' }));
    await waitFor(() => expect(screen.queryByText(/这份旧提案设置了多个当前任务/)).toBeNull());
    const request = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/reviews/invalid-focus'))!;
    expect(JSON.parse(request[1].body)).toEqual({ action: 'reject', expectedVersion: 12 });
    expect(screen.getByText('v12')).toBeTruthy();
  });
  it('captures a linked idea with a single manual delta and no model refresh', async () => {
    const user = userEvent.setup(); const host = quietHost();
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/manual') ? { state: state(), outcome: 'applied' } : url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App initialState={state()} initialToken="token" host={host} />);
    await user.click(screen.getByRole('button', { name: '＋ 记想法' }));
    await user.type(screen.getByLabelText('一句话想法'), '增加提醒');
    await user.click(screen.getByText(/补充说明、关联任务与排序/));
    await user.click(screen.getByRole('checkbox', { name: '项目地图界面' }));
    await user.click(screen.getByRole('checkbox', { name: '项目绑定与持久化' }));
    await user.selectOptions(screen.getByLabelText('想法优先级'), 'high');
    await user.click(screen.getByRole('button', { name: '存入 Parking Lot' }));
    await waitFor(() => expect((screen.getByLabelText('一句话想法') as HTMLInputElement).value).toBe(''));
    const writes = fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/manual'));
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0][1].body);
    expect(payload.operations).toEqual([expect.objectContaining({ type: 'ADD_NODE', node: expect.objectContaining({ title: '增加提醒', status: 'parking', metadata: { relatedNodeIds: ['ui', 'storage'], ideaPriority: 'high', ideaPinned: false } }) })]);
    expect(host.sendRefresh).not.toHaveBeenCalled();
  });

  it('preserves the idea draft on failed save', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/manual') ? response({ error: '保存失败' }, 500) : response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await user.click(screen.getByRole('button', { name: '＋ 记想法' }));
    await user.type(screen.getByLabelText('一句话想法'), '保留草稿');
    await user.click(screen.getByRole('button', { name: '存入 Parking Lot' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('一句话想法') as HTMLInputElement).value).toBe('保留草稿');
  });
  it('starts without fabricated tasks and restores the entered binding key without storing a secret', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/bind') ? response({ state: state(), binding: { bindingKey: 'same-project-key' }, projectToken: 'scoped-token' }) : url.endsWith('/conflicts') ? response({ conflicts: [] }) : response({ history: [] }));
    render(<App host={quietHost()} />);
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByText('核心能力开发')).toBeNull();
    await user.type(screen.getByLabelText('项目名称'), '重命名项目');
    await user.clear(screen.getByLabelText('绑定 key')); await user.type(screen.getByLabelText('绑定 key'), 'same-project-key');
    await user.type(screen.getByLabelText('部署者凭据'), 'private-owner-secret');
    await user.click(screen.getByRole('button', { name: /连接项目地图/ }));
    await screen.findByRole('tree');
    const request = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/api/bind'))!;
    expect(JSON.parse(request[1].body).bindingKey).toBe('same-project-key');
    expect(request[1].headers.Authorization).toBe('Bearer private-owner-secret');
    expect(sessionStorage.getItem('task-map.binding')).toBe('same-project-key');
    expect(JSON.stringify(sessionStorage)).not.toContain('private-owner-secret');
    expect(JSON.stringify(localStorage)).not.toContain('scoped-token');
  });

  it('renders hierarchy, active ancestry, collapses and supports keyboard navigation', async () => {
    const select = vi.fn(); const user = userEvent.setup();
    render(<TaskTree state={state()} onSelect={select} />);
    const branch = screen.getByRole('treeitem', { name: '核心能力开发，待开始' });
    const active = screen.getByRole('treeitem', { name: '项目地图界面，进行中' });
    expect(active.getAttribute('aria-current')).toBe('step');
    expect(branch.parentElement?.classList.contains('branch-path')).toBe(true);
    branch.focus(); await user.keyboard('{ArrowLeft}');
    expect(branch.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: '项目地图界面，进行中' })).toBeNull();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('项目绑定与持久化，已完成');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(select.mock.calls[0][0].id).toBe('ui');
  });

  it('handles arbitrary JSON metadata without rendering objects as a next step', () => {
    const unusual = JSON.parse(JSON.stringify(state()));
    unusual.nodes.find((node: { id: string }) => node.id === 'ui').metadata.nextStep = { draft: 'not a display string' };
    render(<App initialState={unusual} host={quietHost()} />);
    expect(screen.getByText('打开任务详情，补充一个明确的下一步。')).toBeTruthy();
  });

  it('sends edits through manual route with the current version and evidence', async () => {
    const user = userEvent.setup(); const initial = state();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/manual')) { const delta = JSON.parse(String(init.body)); const next = state(); next.version += 1; next.nodes.find(node => node.id === 'ui')!.title = delta.operations[0].changes.title; return response({ state: next, outcome: 'applied' }); }
      return response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] });
    });
    render(<App initialState={initial} initialToken="scoped-secret" host={quietHost()} />);
    await user.click(screen.getByRole('treeitem', { name: '项目地图界面，进行中' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('任务名称')); await user.type(within(dialog).getByLabelText('任务名称'), '完成可访问任务树');
    await user.click(within(dialog).getByRole('button', { name: '保存人工更改' }));
    await waitFor(() => expect(screen.getByText('v13')).toBeTruthy());
    const request = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/manual'))!;
    const delta = JSON.parse(request[1].body);
    expect(delta.expectedVersion).toBe(12); expect(delta.source).toBe('manual'); expect(delta.evidence[0].kind).toBe('manual');
    expect(delta.operations[0]).toEqual({ type: 'UPDATE_NODE', nodeId: 'ui', changes: { title: '完成可访问任务树', summary: initial.nodes.find(node => node.id === 'ui')!.summary, metadata: { nextStep: '完成节点详情交互，并验证状态同步。' } } });
    expect(request[1].headers.Authorization).toBe('Bearer scoped-secret');
  });

  it('preserves unsaved add-task input and existing map when saving fails', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/manual') ? response({ error: '服务暂时不可用' }, 503) : response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await user.click(screen.getByRole('button', { name: /添加任务/ }));
    await user.type(screen.getByLabelText('任务名称'), '不应丢失的输入');
    await user.click(screen.getByRole('button', { name: '添加到地图' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('任务名称') as HTMLInputElement).value).toBe('不应丢失的输入');
    expect(screen.getByRole('tree')).toBeTruthy(); expect(screen.getByText('v12')).toBeTruthy();
  });

  it('keeps pending edits in the dialog and shows the reason where the user is editing', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/manual') ? response({ state: state(), outcome: 'pending', conflict: { message: '版本已更新，需要重新核对。' } }) : response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await user.click(screen.getByRole('treeitem', { name: '项目地图界面，进行中' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('任务名称')); await user.type(within(dialog).getByLabelText('任务名称'), '待确认的新名称');
    await user.click(within(dialog).getByRole('button', { name: '保存人工更改' }));
    await within(dialog).findByText('版本已更新，需要重新核对。');
    expect((within(dialog).getByLabelText('任务名称') as HTMLInputElement).value).toBe('待确认的新名称');
    expect(screen.getByText('v12')).toBeTruthy();
  });

  it('ignores old project polling responses after the host switches projects', async () => {
    vi.useFakeTimers();
    try {
      let deliver: (context: HostContext) => void = () => {};
      let resolveOld: (value: Response) => void = () => {};
      const host = quietHost(); host.connect = vi.fn(async callback => { deliver = callback; });
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/demo-project')) return new Promise<Response>(resolve => { resolveOld = resolve; });
        return response(url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] });
      });
      render(<App initialState={state()} initialToken="token-a" host={host} />);
      await act(async () => { vi.advanceTimersByTime(15000); });
      const next = { ...state(), projectId: 'project-b', name: '独立项目 B', version: 1 };
      await act(async () => { deliver({ state: next, projectToken: 'token-b' }); });
      await act(async () => { resolveOld(response({ state: { ...state(), version: 99 } })); });
      expect(screen.getByText('独立项目 B')).toBeTruthy(); expect(screen.getByText('v1')).toBeTruthy();
      expect(screen.queryByText('v99')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('exposes conflict reasons and requires explicit approval on the review route', async () => {
    const user = userEvent.setup();
    const delta: Delta = { projectId: 'demo-project', idempotencyKey: 'conflicted-update', expectedVersion: 12, timestamp: demoState.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'COMPLETE_NODE', nodeId: 'ui' }] };
    const conflict: Conflict = { id: 'conflict-1', projectId: 'demo-project', kind: 'manual_override', message: '该任务已有人工判断，请确认更改。', delta, createdAt: demoState.updatedAt, status: 'pending' };
    let reviewed = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/reviews/conflict-1')) { reviewed = true; return response({ state: state(), outcome: 'applied' }); }
      return response(url.endsWith('/conflicts') ? { conflicts: reviewed ? [] : [conflict] } : url.endsWith('/history') ? { history: [] } : { state: state() });
    });
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await screen.findByText(conflict.message);
    await user.click(screen.getByRole('button', { name: '批准更改' }));
    await waitFor(() => expect(screen.queryByText(conflict.message)).toBeNull());
    const request = fetchMock.mock.calls.find(call => String(call[0]).includes('/reviews/'))!;
    expect(JSON.parse(request[1].body)).toEqual({ action: 'approve', expectedVersion: 12 });
  });

  it('requests overview reconciliation without claiming it already succeeded', async () => {
    const user = userEvent.setup(); const host = quietHost(); host.sendRefresh = vi.fn(async () => true);
    render(<App initialState={state()} initialToken="token" host={host} />);
    await user.click(screen.getByRole('button', { name: '刷新项目地图' }));
    await screen.findByText(/已发送概况核对请求/);
    expect(screen.queryByText('等待概况核对')).toBeNull();
    expect(host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining('get_project_state'));
    expect(host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining('不要调用 get_project_map'));
    expect(screen.getByText('v12')).toBeTruthy();
    expect(host.sendRefresh).toHaveBeenCalledWith(expect.stringContaining('reconcile_project 工具'));
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/reconcile'))).toBe(false);
  });

  it('offers a selectable recovery prompt in a standalone browser', async () => {
    const user = userEvent.setup(); render(<App initialState={state()} host={quietHost()} />);
    await user.click(screen.getByRole('button', { name: '刷新项目地图' }));
    const prompt = await screen.findByLabelText('项目概况恢复请求') as HTMLTextAreaElement;
    expect(prompt.value).toBe(refreshPrompt(state())); expect(prompt.value).not.toContain('token');
  });

  it('routes host pending deltas through AI endpoint and deduplicates host deliveries', async () => {
    let deliver: (context: HostContext) => void = () => {};
    const host = quietHost(); host.connect = vi.fn(async callback => { deliver = callback; });
    const delta: Delta = { projectId: 'demo-project', idempotencyKey: 'host-change', expectedVersion: 12, timestamp: demoState.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] };
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/deltas') ? { state: state(), outcome: 'no_op' } : url.endsWith('/conflicts') ? { conflicts: [] } : { history: [] }));
    render(<App host={host} />);
    await act(async () => { deliver({ state: state(), projectToken: 'meta-token', pendingDelta: delta }); });
    await screen.findByRole('tree');
    await act(async () => { deliver({ state: state(), projectToken: 'meta-token', pendingDelta: delta }); });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/deltas'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/manual'))).toBe(false);
    expect(JSON.stringify(sessionStorage)).not.toContain('meta-token');
  });

  it('requires explicit rollback confirmation and sends target/current versions', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/rollback') ? { state: { ...state(), version: 13 }, outcome: 'applied' } : url.endsWith('/history') ? { history: [{ version: 0, reason: '初始化', createdAt: demoState.createdAt }, { version: 12, reason: '当前编辑', createdAt: demoState.updatedAt }] } : url.endsWith('/conflicts') ? { conflicts: [] } : { state: state() }));
    render(<App initialState={state()} initialToken="token" host={quietHost()} />);
    await user.click(screen.getByRole('button', { name: '版本记录' }));
    await user.click(await screen.findByRole('button', { name: '恢复此版本' }));
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/rollback'))).toBe(false);
    await user.click(screen.getByRole('button', { name: '确认恢复' }));
    await screen.findByText('v13');
    const request = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/rollback'))!;
    expect(JSON.parse(request[1].body)).toEqual({ targetVersion: 0, expectedVersion: 12 });
  });
});

describe('host and API boundary', () => {
  it('routes reads and manual edits through the host without browser fetch or write fallback', async () => {
    const host = quietHost(); host.canCallTools = () => true;
    host.callTool = vi.fn(async () => ({ structuredContent: { data: { state: state(), outcome: 'applied' } } }));
    const api = new ApiClient(); api.configure('capability', 'http://127.0.0.1:3000'); api.useHost(host);
    expect((await api.state('demo-project')).version).toBe(12);
    expect(host.callTool).toHaveBeenCalledWith('read_project_view', { projectId: 'demo-project', projectToken: 'capability', view: 'state' });
    const change: Delta = { projectId: 'demo-project', idempotencyKey: 'once', expectedVersion: 12, timestamp: demoState.updatedAt, source: 'manual', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] };
    await api.apply(change, true);
    expect(host.callTool).toHaveBeenLastCalledWith('edit_project_view', { projectId: 'demo-project', projectToken: 'capability', change: { action: 'manual', delta: change } });
    host.callTool = vi.fn(async () => { throw new Error('Host denied'); });
    await expect(api.apply(change, true)).rejects.toThrow('Host denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects host error envelopes and incomplete responses without silently falling back', async () => {
    const host = quietHost(); host.canCallTools = () => true;
    host.callTool = vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'Project scope mismatch' }] }));
    const api = new ApiClient(); api.configure('capability', 'http://127.0.0.1:3000'); api.useHost(host);
    await expect(api.state('other')).rejects.toThrow('Project scope mismatch');
    host.callTool = vi.fn(async () => ({}));
    await expect(api.state('other')).rejects.toThrow('未返回有效数据');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['call_tool_result', 'mcp_tool_result'])('reads canonical %s metadata without treating public fields as credentials', envelope => {
    const context = parseToolResult({ state: state(), projectToken: 'public-not-a-token' }, { [envelope]: { _meta: { projectToken: 'private-token', apiBaseUrl: 'https://map.example' } } });
    expect(context.projectToken).toBe('private-token'); expect(context.state?.projectId).toBe('demo-project');
    expect(parseToolResult({ state: state(), projectToken: 'public-token' }).projectToken).toBeUndefined();
  });
  it.each([{}, { unrelated: 'host-metadata' }])('falls back to result metadata when supplied metadata has no map fields (%j)', suppliedMeta => {
    const snapshot = state();
    const delta: Delta = { projectId: snapshot.projectId, idempotencyKey: 'parser-only', expectedVersion: snapshot.version, timestamp: snapshot.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] };
    expect(parseToolResult({ structuredContent: { state: snapshot }, _meta: { projectToken: 'result-test-token', apiBaseUrl: 'https://result.example', pendingDelta: delta } }, suppliedMeta)).toEqual({ state: snapshot, projectToken: 'result-test-token', apiBaseUrl: 'https://result.example', pendingDelta: delta });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['call_tool_result', 'mcp_tool_result'])('falls back per field while keeping valid nested %s metadata first', envelope => {
    const snapshot = state();
    const delta: Delta = { projectId: snapshot.projectId, idempotencyKey: 'parser-fallback-only', expectedVersion: snapshot.version, timestamp: snapshot.updatedAt, source: 'ai', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] };
    const context = parseToolResult({ structuredContent: { state: snapshot }, _meta: { projectToken: 'result-test-token', apiBaseUrl: 'https://result.example', pendingDelta: delta } }, {
      projectToken: 'direct-test-token', apiBaseUrl: false, pendingDelta: [],
      [envelope]: { _meta: { projectToken: '  ', apiBaseUrl: 'https://nested.example', pendingDelta: null } },
    });
    expect(context).toEqual({ state: snapshot, projectToken: 'direct-test-token', apiBaseUrl: 'https://nested.example', pendingDelta: delta });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not let an incomplete first nested wrapper hide valid fields in the other wrapper', () => {
    const context = parseToolResult({ state: state(), _meta: { projectToken: 'result-test-token', apiBaseUrl: 'https://result.example' } }, {
      projectToken: 'direct-test-token', apiBaseUrl: 'https://direct.example',
      call_tool_result: { _meta: { projectToken: 'preferred-test-token', apiBaseUrl: 123 } },
      mcp_tool_result: { _meta: { projectToken: 'other-test-token', apiBaseUrl: 'https://other-nested.example' } },
    });
    expect(context.projectToken).toBe('preferred-test-token');
    expect(context.apiBaseUrl).toBe('https://other-nested.example');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reads standard MCP tool results and keeps authenticated exports out of query strings', async () => {
    expect(parseToolResult({ structuredContent: { state: state() }, _meta: { projectToken: 'standard-token' } }).projectToken).toBe('standard-token');
    fetchMock.mockResolvedValue(response('# task map'));
    const api = new ApiClient(); api.configure('private-token', 'https://map.example');
    expect(await api.artifact('project-a', 'md')).toBe('# task map');
    expect(fetchMock).toHaveBeenCalledWith('https://map.example/api/projects/project-a/artifact.md', expect.objectContaining({ headers: { Authorization: 'Bearer private-token' }, credentials: 'omit' }));
  });
});
