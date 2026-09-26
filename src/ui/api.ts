import type { Conflict, Delta, HistoryEntry, MutationResult, ProjectState } from './types';

export class ApiClient {
  private token = '';
  private baseUrl = '';
  configure(token: string, baseUrl?: string) {
    this.token = token;
    if (baseUrl !== undefined) {
      const url = new URL(baseUrl || window.location.origin, window.location.origin);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后端地址必须使用 HTTP 或 HTTPS。');
      this.baseUrl = url.origin;
    }
  }
  get authenticated() { return Boolean(this.token); }
  private async request<T>(path: string, body?: unknown, raw = false): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
    });
    if (!response.ok) {
      let detail = '';
      try { const error = await response.json(); detail = typeof error.error === 'string' ? error.error : error.error?.message || error.message || ''; } catch { /* An upstream proxy may not return JSON. */ }
      throw new Error(response.status === 401 ? '连接凭据已失效，请重新连接。' : detail || `请求失败（${response.status}），已保留上次状态。`);
    }
    return (raw ? response.text() : response.json()) as Promise<T>;
  }
  bind(bindingKey: string, name: string, goal: string) {
    return this.request<{ state: ProjectState; binding: { bindingKey: string }; projectToken?: string; apiBaseUrl?: string }>('/api/bind', { bindingKey, name, goal });
  }
  async state(id: string) { const result = await this.request<{ state: ProjectState }>(`/api/projects/${encodeURIComponent(id)}`); return result.state; }
  async conflicts(id: string) { const result = await this.request<{ conflicts: Conflict[] }>(`/api/projects/${encodeURIComponent(id)}/conflicts`); return result.conflicts; }
  async history(id: string) { const result = await this.request<{ history: HistoryEntry[] }>(`/api/projects/${encodeURIComponent(id)}/history`); return result.history; }
  apply(delta: Delta, manual: boolean) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(delta.projectId)}/${manual ? 'manual' : 'deltas'}`, delta); }
  review(id: string, conflictId: string, action: 'approve' | 'reject', expectedVersion: number) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(id)}/reviews/${encodeURIComponent(conflictId)}`, { action, expectedVersion }); }
  rollback(id: string, targetVersion: number, expectedVersion: number) { return this.request<MutationResult>(`/api/projects/${encodeURIComponent(id)}/rollback`, { targetVersion, expectedVersion }); }
  artifact(id: string, format: 'md' | 'html') { return this.request<string>(`/api/projects/${encodeURIComponent(id)}/artifact.${format}`, undefined, true); }
}
