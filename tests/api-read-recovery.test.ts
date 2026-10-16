// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/ui/api';
import { demoState } from '../src/ui/demo';
import type { Delta, HostAdapter } from '../src/ui/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const state = (version = 12) => ({ ...structuredClone(demoState), version });
const toolState = (version = 12) => ({ structuredContent: { data: { state: state(version) } } });
const response = (version = 12) => ({ ok: true, status: 200, json: async () => ({ state: state(version) }) }) as Response;
const capability = (values: Record<string, unknown> = {}) => `${btoa('{"alg":"HS256","typ":"JWT"}')}.${btoa(JSON.stringify({ kind: 'project', projectId: 'demo-project', iss: 'https://map.test', aud: 'https://map.test/api', ...values }))}.test-signature`;
function client(call: HostAdapter['callTool'], base = 'https://map.test') {
  const host: HostAdapter = { canCallTools: () => true, callTool: call, connect: async () => {}, close: () => {}, sendRefresh: async () => false };
  const api = new ApiClient(); api.configure(capability(), base); api.useHost(host);
  return { api, host };
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.useFakeTimers(); fetchMock = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded host read recovery', () => {
  it('accepts a 25 second host response and shares concurrent reads without browser networking', async () => {
    const call = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(toolState(13)), 25000)));
    const { api } = client(call);
    const reads = Promise.all([api.state('demo-project'), api.state('demo-project')]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await reads).map(item => item.version)).toEqual([13, 13]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one authenticated GET after a stuck host read, avoids duplicate RPCs, and returns to the host when it settles', async () => {
    const stuck = deferred<unknown>(), http = deferred<Response>();
    const call = vi.fn().mockImplementationOnce(() => stuck.promise).mockResolvedValue(toolState(15));
    fetchMock.mockImplementationOnce(() => http.promise).mockResolvedValue(response(14));
    const { api } = client(call);
    const reads = Promise.all([api.state('demo-project'), api.state('demo-project')]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(call).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://map.test/api/projects/demo-project', expect.objectContaining({
      method: 'GET', headers: { Authorization: `Bearer ${capability()}` }, credentials: 'omit',
    }));
    http.resolve(response(13));
    expect((await reads).map(item => item.version)).toEqual([13, 13]);
    expect((await api.state('demo-project')).version).toBe(14);
    expect(call).toHaveBeenCalledTimes(1);
    stuck.resolve(toolState(12)); await vi.advanceTimersByTimeAsync(0);
    expect((await api.state('demo-project')).version).toBe(15);
    expect(call).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'error-envelope', 'malformed'] as const)('does not fall back on an explicit host %s', async mode => {
    const call = vi.fn(async () => {
      if (mode === 'reject') throw new Error('Host denied');
      return mode === 'error-envelope' ? { isError: true, content: [{ type: 'text', text: 'Host denied' }] } : {};
    });
    const { api } = client(call);
    await expect(api.state('demo-project')).rejects.toThrow(mode === 'malformed' ? '未返回有效数据' : 'Host denied');
    await vi.advanceTimersByTimeAsync(45000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries or falls back for a pending host write', async () => {
    const write = deferred<unknown>(); const call = vi.fn(() => write.promise);
    const { api } = client(call);
    const delta: Delta = { projectId: 'demo-project', expectedVersion: 12, idempotencyKey: 'manual-once', timestamp: demoState.updatedAt, source: 'manual', confidence: 1, evidence: [], operations: [{ type: 'NO_OP' }] };
    const saved = api.apply(delta, true); const rejected = expect(saved).rejects.toThrow('Host denied');
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
    write.reject(new Error('Host denied')); await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an old host wait on credential change and never uses its fallback or late result', async () => {
    const old = deferred<unknown>();
    const call = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(toolState(14));
    const { api } = client(call);
    const read = api.state('demo-project'); const rejected = expect(read).rejects.toThrow('连接已更新');
    await vi.advanceTimersByTimeAsync(5000);
    api.configure('new-scoped-token', 'https://new-map.test'); await rejected;
    expect((await api.state('demo-project')).version).toBe(14);
    expect(call).toHaveBeenLastCalledWith('read_project_view', { projectId: 'demo-project', projectToken: 'new-scoped-token', view: 'state' });
    old.resolve(toolState(1)); await vi.advanceTimersByTimeAsync(45000);
    expect(fetchMock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an old HTTP fallback response after the connection changes', async () => {
    const http = deferred<Response>();
    fetchMock.mockImplementationOnce(() => http.promise);
    const call = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(toolState(14));
    const { api } = client(call);
    const read = api.state('demo-project'); const rejected = expect(read).rejects.toThrow('连接已更新');
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    api.configure('new-scoped-token', 'https://new-map.test');
    expect((await api.state('demo-project')).version).toBe(14);
    http.resolve(response(13)); await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a fallback capability to a non-HTTPS server', async () => {
    const { api } = client(vi.fn(() => new Promise(() => {})), 'http://127.0.0.1:3000');
    const read = api.state('demo-project'); const rejected = expect(read).rejects.toThrow('读取地图超时');
    await vi.advanceTimersByTimeAsync(30000); await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    api.useHost(undefined);
  });

  it.each([
    'owner-secret-not-a-project-capability',
    capability({ kind: 'oauth' }),
    capability({ projectId: 'another-project' }),
    capability({ iss: 'https://old-map.test', aud: 'https://old-map.test/api' }),
  ])('does not use an unscoped or mismatched credential for HTTP fallback (%#)', async credential => {
    const { api } = client(vi.fn(() => new Promise(() => {})));
    api.configure(credential);
    const read = api.state('demo-project'); const rejected = expect(read).rejects.toThrow('读取地图超时');
    await vi.advanceTimersByTimeAsync(30000); await rejected;
    expect(fetchMock).not.toHaveBeenCalled(); api.useHost(undefined);
  });
});
