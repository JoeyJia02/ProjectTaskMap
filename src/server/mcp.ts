import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { bindSchema, bindingSchema, deltaSchema, assessmentSchema, overviewSchema, projectStateSchema, type ProjectState } from '../domain/schema.js';
import type { ProjectStore } from '../store/index.js';
import { renderMarkdown, renderHtml } from '../artifacts/index.js';
import { Auth, MCP_SCOPE, type Principal } from './auth.js';

const URI = 'ui://project-task-map/map.html';
const projectInput = { projectId: z.string().min(1).max(128) };
const outputSchema = {
  state: projectStateSchema,
  binding: bindingSchema.optional(),
  outcome: z.enum(['applied', 'no_op', 'duplicate', 'pending', 'awaiting_ui']).optional(),
  conflict: z.object({ id: z.string(), projectId: z.string(), kind: z.string(), message: z.string(), delta: deltaSchema, createdAt: z.string(), status: z.enum(['pending', 'approved', 'rejected']), reviewedAt: z.string().optional(), reviewVersion: z.number().optional(), reviewAction: z.enum(['approve', 'reject']).optional() }).optional(),
  coverage: z.string().optional(),
  checkedAt: z.string().optional(),
};

export function createMcpServer(store: ProjectStore, auth: Auth, principal: Principal): McpServer {
  const server = new McpServer({ name: 'project-task-map', version: '0.1.0' }, {
    instructions: 'Manage only the explicitly bound project. Reuse bindingKey stored in Project instructions. Read current state before writing. Use evidence-backed incremental deltas for meaningful changes; no change needs no write. Reconcile explicitly supplied overview after missed turns. Do not claim access to all project chats or host turn hooks. Manual locks and conflicts require human review.',
  });
  const securitySchemes = [{ type: 'oauth2', scopes: MCP_SCOPE.split(' ') }];
  registerAppResource(server, 'project-task-map-ui', URI, {}, async () => ({ contents: [{
    uri: URI, mimeType: RESOURCE_MIME_TYPE,
    text: readFileSync(resolve('dist/ui/index.html'), 'utf8'),
    _meta: {
      ui: { domain: auth.config.widgetOrigin, prefersBorder: true, csp: { connectDomains: [auth.config.publicUrl], resourceDomains: [] } },
      'openai/widgetDescription': '当前 Project 的目标、焦点、任务树、决策与暂缓分支。',
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      'openai/widgetCSP': { connect_domains: [auth.config.publicUrl], resource_domains: [] },
    },
  }] }));
  const meta = (state: ProjectState) => ({ projectToken: auth.issue('project', state.projectId), apiBaseUrl: auth.config.publicUrl });
  const result = (state: ProjectState, message: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { state, ...extra },
    _meta: meta(state),
  });
  const guarded = <T,>(fn: (args: T) => ReturnType<typeof result> | Promise<ReturnType<typeof result>>) => async (args: T) => {
    try { return await fn(args); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Request failed.' }] }; }
  };
  registerAppTool(server, 'bind_project', {
    title: '绑定项目任务地图',
    description: 'Create or restore this project using its persistent bindingKey. A name is a label, never identity. Save the key in Project instructions for later conversations. This may create persistent state.',
    inputSchema: bindSchema.shape, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, securitySchemes },
  }, guarded(args => {
    const { state, binding } = store.bind(principal.ownerId, args);
    return result(state, `项目已绑定。projectId=${state.projectId}; version=${state.version}; bindingKey=${binding.bindingKey}`, { binding });
  }));
  registerAppTool(server, 'get_project_map', {
    title: '查看项目任务地图', description: 'Read the explicitly bound project and show its map. After missed turns, request an overview of available context for reconcile; do not assume unobserved history.',
    inputSchema: projectInput, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, securitySchemes },
  }, guarded(({ projectId }) => result(store.get(principal.ownerId, projectId), '已读取保存的项目任务地图。')));
  server.registerTool('apply_project_delta', {
    title: '更新项目状态', description: 'Persist an evidence-backed incremental delta. Requires current expectedVersion and stable idempotencyKey. Low confidence or conflicting changes are held for human review. Never set manual source to bypass locks.',
    inputSchema: { delta: deltaSchema }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes },
  }, guarded(({ delta }) => {
    const mutation = store.apply(principal.ownerId, { ...delta, source: 'ai' });
    return result(mutation.state, `增量处理结果：${mutation.outcome}`, { outcome: mutation.outcome, conflict: mutation.conflict });
  }));
  server.registerTool('assess_project_turn', {
    title: '同步本轮项目变化', description: 'Validate a lightweight model-produced turn assessment and persist only meaningful changes. No change yields NO_OP without a project revision. The server does not read or classify hidden conversations.',
    inputSchema: { assessment: assessmentSchema }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes },
  }, guarded(({ assessment }) => {
    const mutation = store.assess(principal.ownerId, assessment);
    return result(mutation.state, `本轮处理结果：${mutation.outcome}`, { outcome: mutation.outcome, conflict: mutation.conflict });
  }));
  server.registerTool('reconcile_project', {
    title: '刷新项目地图', description: 'Reconcile a Project Overview from currently available context and evidence with the saved state. Retains omitted nodes and stable IDs; does not regenerate or enumerate project chats. Include actual coverage and uncertainty.',
    inputSchema: { overview: overviewSchema }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes },
  }, guarded(({ overview }) => {
    const mutation = store.reconcile(principal.ownerId, overview);
    return result(mutation.state, `核对结果：${mutation.outcome}；依据范围：${overview.coverage}`, { outcome: mutation.outcome, conflict: mutation.conflict, coverage: overview.coverage, checkedAt: mutation.checkedAt });
  }));
  registerAppTool(server, 'stage_project_delta', {
    title: '通过任务地图同步增量', description: 'Send an evidence-backed delta to the active Task Map UI, which will write it over HTTPS. This is a write-intent action, not a read-only preview. No UI means no write; use reconcile later.',
    inputSchema: { delta: deltaSchema }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, securitySchemes },
  }, guarded(({ delta }) => {
    const state = store.get(principal.ownerId, delta.projectId);
    return { ...result(state, '增量已交给活动 UI；后端确认前尚未保存。', { outcome: 'awaiting_ui' }), _meta: { ...meta(state), pendingDelta: { ...delta, source: 'ai' } } };
  }));
  server.registerTool('export_task_map', {
    title: '导出任务地图', description: 'Return a Markdown or safe static HTML snapshot of this project as an MCP text resource. Host file/tab registration is not performed.',
    inputSchema: { ...projectInput, format: z.enum(['md', 'html']).default('md') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { securitySchemes },
  }, async ({ projectId, format }) => {
    try {
      const state = store.get(principal.ownerId, projectId);
      const text = format === 'md' ? renderMarkdown(state) : renderHtml(state);
      return { content: [{ type: 'resource' as const, resource: { uri: `taskmap://${encodeURIComponent(projectId)}/v${state.version}/task-map.${format}`, mimeType: format === 'md' ? 'text/markdown' : 'text/html', text } }] };
    } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Export failed.' }] }; }
  });
  return server;
}
