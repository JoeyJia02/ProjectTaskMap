import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { deltaSchema } from '../domain/schema.js';
import type { ProjectStore } from '../store/index.js';
import { renderHtml, renderMarkdown } from '../artifacts/index.js';
import { Auth, MCP_SCOPE, type Principal } from './auth.js';

// A project capability is required in addition to the host OAuth connection.
// These tools cannot bind projects or forward arbitrary URLs/HTTP requests.
export function registerUiTools(server: McpServer, store: ProjectStore, auth: Auth, principal: Principal) {
  const scope = { projectId: z.string().min(1).max(128), projectToken: z.string().min(1).max(8192) };
  function authorize(projectId: string, token: string) {
    // The outer MCP OAuth token is verified afresh on every request. Renew only
    // its own signed project scope, including when reopening yesterday's card.
    const capability = auth.verifyUiCapability(token, principal);
    if (capability.kind !== 'project' || capability.projectId !== projectId || capability.ownerId !== principal.ownerId || capability.familyId !== principal.familyId) throw new Error('Project scope mismatch. Reopen this map.');
    store.get(principal.ownerId, projectId);
  }
  const meta = { ui: { visibility: ['app'] as ('app')[] }, 'openai/widgetAccessible': true, securitySchemes: [{ type: 'oauth2', scopes: MCP_SCOPE.split(' ') }] };
  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: '项目界面请求已完成。' }], structuredContent: { data } });
  const failed = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Project UI request failed.' }] });
  registerAppTool(server, 'read_project_view', {
    title: '读取当前地图界面', description: 'App-only authenticated reads for the currently displayed project. Does not open another UI.',
    inputSchema: { ...scope, view: z.enum(['state', 'history', 'conflicts', 'md', 'html']) }, outputSchema: { data: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: meta,
  }, async ({ projectId, projectToken, view }) => {
    try {
      authorize(projectId, projectToken);
      if (view === 'history') return ok({ history: store.history(principal.ownerId, projectId) });
      if (view === 'conflicts') return ok({ conflicts: store.conflicts(principal.ownerId, projectId) });
      const state = store.get(principal.ownerId, projectId);
      return ok(view === 'state' ? { state } : view === 'md' ? renderMarkdown(state) : renderHtml(state));
    } catch (e) { return failed(e); }
  });
  const change = z.discriminatedUnion('action', [
    z.object({ action: z.literal('manual'), delta: deltaSchema }).strict(),
    z.object({ action: z.literal('ai'), delta: deltaSchema }).strict(),
    z.object({ action: z.literal('review'), conflictId: z.string().min(1), decision: z.enum(['approve', 'reject']), expectedVersion: z.number().int().nonnegative() }).strict(),
    z.object({ action: z.literal('rollback'), targetVersion: z.number().int().nonnegative(), expectedVersion: z.number().int().nonnegative() }).strict(),
  ]);
  registerAppTool(server, 'edit_project_view', {
    title: '保存地图中的操作', description: 'App-only user edits and staged AI updates. Requires project capability and version checks. Never call to bypass human review.',
    inputSchema: { ...scope, change }, outputSchema: { data: z.unknown() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: meta,
  }, async ({ projectId, projectToken, change }) => {
    try {
      authorize(projectId, projectToken);
      if (change.action === 'review') return ok(store.review(principal.ownerId, projectId, change.conflictId, change.decision, change.expectedVersion));
      if (change.action === 'rollback') return ok(store.rollback(principal.ownerId, projectId, change.targetVersion, change.expectedVersion));
      if (change.delta.projectId !== projectId) throw new Error('Project scope mismatch.');
      return ok(store.apply(principal.ownerId, { ...change.delta, source: change.action === 'manual' ? 'manual' : 'ai', ...(change.action === 'manual' ? { confidence: 1 } : {}) }));
    } catch (e) { return failed(e); }
  });
}
