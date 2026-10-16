import type { Conflict, Delta, HistoryEntry, MutationResult, ProjectState, HostAdapter } from './types';

const HOST_READ_TIMEOUT_MS = 30000;
class HostReadTimeout extends Error {
  constructor() { super('读取地图超时，已保留上次快照，将自动重试。'); }
}
type HostRead = { result: Promise<unknown>; cancelWait: () => void };

export class ApiClient {
  private token = '';
  private baseUrl = '';
  private host?: HostAdapter;
  private hostReads = new Map<string, HostRead>();
  private fallbackReads = new Map<string, Promise<unknown>>();
  private connectionRevision = 0;
  private resetReads() {
    this.connectionRevision++;
    for (const read of this.hostReads.values()) read.cancelWait();
    this.hostReads.clear();
    this.fallbackReads.clear();
  }
  useHost(host?: HostAdapter) {
    if (host !== this.host) this.resetReads();
    this.host = host;
  }
  configure(token: string, baseUrl?: string) {
    let nextBase = this.baseUrl;
    if (baseUrl !== undefined) {
      // Embedded srcdoc/data documents have an opaque ("null") origin. Wait
      // for the host's absolute API URL instead of resolving against it.
      const origin = /^https?:$/.test(window.location.protocol) ? window.location.origin : '';
      const address = baseUrl || origin;
      if (!address) nextBase = '';
      else {
        let url: URL;
        try { url = new URL(address); }
        catch { if (!origin) throw new Error('嵌入地图需要有效的 HTTP 或 HTTPS 后端地址。'); url = new URL(address, origin); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后端地址必须使用 HTTP 或 HTTPS。');
        nextBase = url.origin;
      }
    }
    if (token !== this.token || nextBase !== this.baseUrl) this.resetReads();
    this.token = token; this.baseUrl = nextBase;
  }
  get authenticated() { return Boolean(this.token); }
  private canReadHttpFallback(projectId: string) {
    if (!this.baseUrl.startsWith('https://') || !this.token || this.token.length > 8192) return false;
    // This preflight prevents sending an owner credential or another issuer's
    // capability. It is not token verification: the API verifies the signature,
    // project scope, expiry and live grant before returning any data.
    try {
      const parts = this.token.split('.');
      if (parts.length !== 3) return false;
      const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return claims.kind === 'project' && claims.projectId === projectId && claims.iss === this.baseUrl && claims.aud === `${this.baseUrl}/api`;
    } catch { return false; }
  }
  private readThroughHost(path: string, args: Record<string, unknown>): Promise<unknown> {
    const existing = this.hostReads.get(path);
    if (existing) return existing.result;
    const host = this.host!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelWait: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HostReadTimeout()), HOST_READ_TIMEOUT_MS);
      cancelWait = () => reject(new Error('地图连接已更新，已取消旧连接的读取。'));
    });
    const pending = Promise.resolve().then(() => host.callTool!('read_project_view', args));
    const read: HostRead = {
      result: Promise.race([pending, deadline]).finally(() => { if (timer) clearTimeout(timer); }),
      cancelWait,
    };
    this.hostReads.set(path, read);
    // A local deadline cannot cancel the host's RPC. Keep sharing that call
    // until it settles, so polling/resume events cannot fill a stalled bridge
    // with duplicate reads. Changing credentials or hosts drops the old wait.
    const settled = () => { if (this.hostReads.get(path) === read) this.hostReads.delete(path); };
    void pending.then(settled, settled);
    return read.result;
  }
  private async request<T>(path: string, body?: unknown, raw = false): Promise<T> {
    const revision = this.connectionRevision;
    const route = /^\/api\/projects\/([^/]+)(.*)$/.exec(path);
    if (route && this.host?.canCallTools?.() && this.host.callTool) {
      const projectId = decodeURIComponent(route[1]);
      const suffix = route[2];
      const args: Record<string, unknown> = { projectId, projectToken: this.token };
      let name: string;
      if (body === undefined) {
        const views: Record<string, string> = { '': 'state', '/history': 'history', '/conflicts': 'conflicts', '/artifact.md': 'md', '/artifact.html': 'html' };
        if (!views[suffix]) throw new Error('不支持的地图读取请求。');
        name = 'read_project_view'; args.view = views[suffix];
      } else {
        name = 'edit_project_view';
        const values = body as Record<string, unknown>;
        if (suffix === '/manual' || suffix === '/deltas') args.change = { action: suffix === '/manual' ? 'manual' : 'ai', delta: body };
        else if (suffix === '/rollback') args.change = { ...values, action: 'rollback' };
        else if (suffix.startsWith('/reviews/')) args.change = { action: 'review', conflictId: decodeURIComponent(suffix.slice('/reviews/'.length)), decision: values.action, expectedVersion: values.expectedVersion };
        else throw new Error('不支持的地图保存请求。');
      }
      // Never retry a failed host write over HTTP: its outcome may be unknown,
      // or the host may have refused permission.
      let result: { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: { data?: T }; data?: T };
      try {
        result = await (body === undefined ? this.readThroughHost(path, args) : this.host.callTool(name, args)) as typeof result;
      } catch (failure) {
        // Retry only a locally timed-out read, never host refusals, malformed
        // results or writes. The existing HTTPS origin and scoped capability
        // still authenticate this GET; we do not bind or extend authorization.
        if (body !== undefined || !(failure instanceof HostReadTimeout) || revision !== this.connectionRevision || !this.canReadHttpFallback(projectId)) throw failure;
        let fallback = this.fallbackReads.get(path);
        if (!fallback) {
          fallback = this.httpRequest<T>(path, undefined, raw);
          this.fallbackReads.set(path, fallback);
          const finished = () => { if (this.fallbackReads.get(path) === fallback) this.fallbackReads.delete(path); };
          void fallback.then(finished, finished);
        }
        return fallback as Promise<T>;
      }
      if (body === undefined && revision !== this.connectionRevision) throw new Error('地图连接已更新，已取消旧连接的读取。');
      if (result?.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || '地图工具请求失败，请重试或重新打开地图。');
      const data = result?.structuredContent ?? result;
      if (!data || !Object.prototype.hasOwnProperty.call(data, 'data')) throw new Error('地图工具未返回有效数据，请刷新插件工具后重新打开地图。');
      return data.data as T;
    }
    return this.httpRequest<T>(path, body, raw);
  }
  private async httpRequest<T>(path: string, body?: unknown, raw = false): Promise<T> {
    if (!this.baseUrl) throw new Error('正在等待宿主提供地图服务地址，请重新打开地图。');
    const revision = this.connectionRevision;
    let response: Response;
    try { response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit', signal: AbortSignal.timeout(15000),
    }); } catch {
      if (body === undefined && revision !== this.connectionRevision) throw new Error('地图连接已更新，已取消旧连接的读取。');
      throw new Error('无法连接地图服务，已保留上次快照。请检查服务连接，或重新打开地图以启用宿主连接。');
    }
    if (body === undefined && revision !== this.connectionRevision) throw new Error('地图连接已更新，已取消旧连接的读取。');
    if (!response.ok) {
      let detail = '';
      try { const error = await response.json(); detail = typeof error.error === 'string' ? error.error : error.error?.message || error.message || ''; } catch { /* An upstream proxy may not return JSON. */ }
      throw new Error(response.status === 401 ? '连接凭据已失效，请重新连接。' : detail || `请求失败（${response.status}），已保留上次状态。`);
    }
    const result = await (raw ? response.text() : response.json()) as T;
    if (body === undefined && revision !== this.connectionRevision) throw new Error('地图连接已更新，已取消旧连接的读取。');
    return result;
  }
  bind(bindingKey: string, name: string, goal: string) {
    return this.request<{ state: ProjectState; binding: { bindingKey: string }; projectToken?: string; apiBaseUrl?: string }>('/api/bind', { bindingKey, name, goal });
  }
  async state(id: string) {
    const result = await this.request<{ state: ProjectState }>(`/api/projects/${encodeURIComponent(id)}`);
    if (!result?.state || result.state.projectId !== id || !Array.isArray(result.state.nodes)) throw new Error('服务器未返回当前项目状态，已保留上次快照。');
    return result.state;
  }
  async conflicts(id: string) { const result = await this.request<{ conflicts: Conflict[] }>(`/api/projects/${encodeURIComponent(id)}/conflicts`); return result.conflicts; }
  async history(id: string) { const result = await this.request<{ history: HistoryEntry[] }>(`/api/projects/${encodeURIComponent(id)}/history`); return result.history; }
  apply(delta: Delta, manual: boolean) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(delta.projectId)}/${manual ? 'manual' : 'deltas'}`, delta); }
  review(id: string, conflictId: string, action: 'approve' | 'reject', expectedVersion: number) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(id)}/reviews/${encodeURIComponent(conflictId)}`, { action, expectedVersion }); }
  rollback(id: string, targetVersion: number, expectedVersion: number) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(id)}/rollback`, { targetVersion, expectedVersion }); }
  artifact(id: string, format: 'md' | 'html') { return this.request<string>(`/api/projects/${encodeURIComponent(id)}/artifact.${format}`, undefined, true); }
}
