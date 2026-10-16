import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { bindSchema, bindingSchema, deltaSchema, assessmentSchema, overviewSchema, projectStateSchema, type ProjectState } from '../domain/schema.js';
import type { ProjectStore } from '../store/index.js';
import { renderMarkdown, renderHtml } from '../artifacts/index.js';
import { Auth, MCP_SCOPE, type Principal } from './auth.js';
import { registerUiTools } from './ui-tools.js';

// Keep the URI pinned: existing host conversations retain the tool's URI, while
// remote resource access is scoped to the connector's current tool descriptor.
// Changing it can fail before resources/read ever reaches this server.
const URI = 'ui://project-task-map/map-v3.html';
const LEGACY_URI = 'ui://project-task-map/map.html';
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
    instructions: 'Project Task Map maintains project goals, tasks, decisions and quick ideas. A bare invocation of this app means open the current project map: inspect current project binding and context first, rather than asking what the app should do. Reuse its saved bindingKey. For a first-time project with a verified stable host Project ID and no saved binding, use task-map-<hostProjectId> and persist that binding in the current project instructions when writable. Never reuse another project key or infer identity from a name. If identity is ambiguous, ask only for the missing project binding. On the first opening of a verified project binding, call get_project_state. If no tasks are saved, and currently visible context contains user-confirmed facts or tasks for that same project, prepare an evidence-backed overview with actual coverage and call reconcile_project before get_project_map once. Without such evidence, keep the map empty and explain that no tasks are saved; do not ask a generic intent question. A pending result is not a completed import. Never scan hidden history or invent tasks. Explicit user restrictions such as read-only, view only, no sync or no changes take precedence: only read an existing binding/state; do not create a binding, reconcile or save local project instructions. When the user asks to organize or sync existing progress, read the available evidence and perform the conservative import without asking again whether to sync. Use get_project_state before writing; preserve IDs, manual edits and terminal states. Only get_project_map opens UI; use it once for open/show requests or bare invocation, never after routine updates. No change needs no write. Do not claim access to hidden chats or automatic turn hooks. Manual locks and conflicts require human review.',
  });
  const securitySchemes = [{ type: 'oauth2', scopes: MCP_SCOPE.split(' ') }];
  const registerUi = (name: string, uri: string) => registerAppResource(server, name, uri, {}, async () => ({ contents: [{
    uri, mimeType: RESOURCE_MIME_TYPE,
    text: readFileSync(resolve('dist/ui/index.html'), 'utf8'),
    _meta: {
      ui: { domain: auth.config.widgetOrigin, prefersBorder: true, csp: { connectDomains: [auth.config.publicUrl], resourceDomains: [] } },
      'openai/widgetDescription': '当前 Project 的目标、焦点、任务树、决策与暂缓分支。',
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      'openai/widgetCSP': { connect_domains: [auth.config.publicUrl], resource_domains: [] },
    },
  }] }));
  registerUi('project-task-map-ui-v3', URI);
  registerUi('project-task-map-ui-v4', 'ui://project-task-map/map-v4.html');
  registerUi('project-task-map-ui-v2', 'ui://project-task-map/map-v2.html');
  // Existing conversations may still reference the old descriptor.
  registerUi('project-task-map-ui', LEGACY_URI);
  const meta = (state: ProjectState) => ({ projectToken: auth.issue('project', state.projectId, 3600, principal.familyId), apiBaseUrl: auth.config.publicUrl });
  const result = (state: ProjectState, message: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { state, ...extra },
    _meta: meta(state),
  });
  const guarded = <T,>(fn: (args: T) => ReturnType<typeof result> | Promise<ReturnType<typeof result>>) => async (args: T) => {
    try { return await fn(args); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'Request failed.' }] }; }
  };
  server.registerTool('bind_project', {
    title: '绑定项目任务地图',
    description: 'First step when opening Project Task Map, including a bare app mention: inspect current project instructions and reuse its bindingKey. If none exists and a verified stable host Project ID is available, use task-map-<hostProjectId> and save the binding locally. Ask only if project identity is missing or ambiguous, not a generic what-do-you-want question. Never reuse another project key or match by name. Creates or restores persistent state; binding itself does not import tasks. Before the first map opening, read saved state; for a map without saved tasks and with visible user-confirmed project facts, submit a conservative overview via reconcile_project, then open once. Without evidence, explain the empty map and do not invent tasks or read hidden conversations. Explicit user restrictions such as read-only, view only, no sync or no changes take precedence: only read an existing binding/state; do not create a binding, reconcile or save local project instructions.',
    inputSchema: bindSchema.shape, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes },
  }, guarded(args => {
    const { state, binding } = store.bind(principal.ownerId, args);
    return result(state, `项目已绑定。projectId=${state.projectId}; version=${state.version}; bindingKey=${binding.bindingKey}`, { binding });
  }));
  server.registerTool('get_project_state', {
    title: '读取项目状态', description: 'Read saved project state without opening a UI. Use before updates, reconciliation and verification. Existing maps automatically reload saved changes; do not call get_project_map after routine updates.',
    inputSchema: projectInput, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { securitySchemes },
  }, guarded(({ projectId }) => result(store.get(principal.ownerId, projectId), '已读取保存的项目状态。')));
  registerAppTool(server, 'get_project_map', {
    title: '查看项目任务地图', description: 'Open the current project map after binding. A bare Project Task Map app mention defaults to opening it; do not ask a generic intent question. Each invocation may create a separate host tab, so call once. For routine reads, refreshes and verification use get_project_state. Before first opening a map without saved tasks, reconcile visible user-confirmed facts for this verified project if available; otherwise explain that no tasks are saved. Open once after reporting the actual import outcome. Explicit user restrictions such as read-only, view only, no sync or no changes take precedence: only read an existing binding/state; do not create a binding, reconcile or save local project instructions. A request to organize existing progress authorizes evidence-backed reconciliation without another confirmation; preserve saved IDs and human changes.',
    inputSchema: projectInput, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: URI }, securitySchemes },
  }, guarded(({ projectId }) => result(store.get(principal.ownerId, projectId), '已读取保存的项目任务地图。')));
  server.registerTool('apply_project_delta', {
    title: '更新项目状态', description: 'Persist an evidence-backed incremental delta. Requires current expectedVersion and stable idempotencyKey. Low confidence or conflicting changes are held for human review. Use START_NODE to mark work active independently of focus. SET_ACTIVE_NODE selects or clears the single focus without stopping other active tasks. Never set manual source to bypass locks.',
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
    title: '刷新项目地图', description: 'Reconcile a Project Overview from currently available context and evidence with the saved state. Retains omitted nodes and stable IDs; does not regenerate or enumerate project chats. Multiple active tasks are allowed; activeNodeId is the single focus, not a limit on parallel work. Omit focus to retain the existing choice. Include actual coverage and uncertainty.',
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
  registerUiTools(server, store, auth, principal);
  return server;
}
