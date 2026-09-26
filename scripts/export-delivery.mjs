import { writeFileSync } from 'node:fs';
import { renderMarkdown } from '../dist/server/artifacts/index.js';
import { ProjectStore } from '../dist/server/store/index.js';

const store = new ProjectStore(':memory:');
const { state } = store.bind('delivery', { bindingKey: 'repository-delivery-checkpoint', name: 'Project Task Map · 交付概况', goal: '让用户在 ChatGPT 项目中快速看清目标、焦点、进度、阻塞、暂缓和决策。' });
const timestamp = new Date().toISOString();
const source = [{ id: 'repository', kind: 'file', label: '本仓库源码、测试与交付文档', timestamp }];
const result = store.apply('delivery', {
  projectId: state.projectId, expectedVersion: 0, idempotencyKey: 'delivery-v1', timestamp, source: 'manual', confidence: 1, evidence: source,
  operations: [
    { type: 'ADD_NODE', node: { id: 'design', title: '需求、架构和数据模型', status: 'done', summary: '先提交设计，再进入实现。' } },
    { type: 'ADD_NODE', node: { id: 'domain', title: '增量状态、DAG 与持久化', status: 'done' } },
    { type: 'ADD_NODE', node: { id: 'consistency', parentId: 'domain', title: '幂等、冲突、人工优先与回滚', status: 'done' } },
    { type: 'ADD_NODE', node: { id: 'sync', parentId: 'domain', title: '每轮结构化判定与 full reconcile', status: 'done', summary: '宿主提供判断；无变化零状态写入。' } },
    { type: 'ADD_NODE', node: { id: 'ui', title: '原生风格交互式 Task Map', status: 'done' } },
    { type: 'ADD_NODE', node: { id: 'integration', title: 'MCP Apps、OAuth 与 Artifact', status: 'done', summary: '本地真实 MCP SDK 协议已验证。' } },
    { type: 'ADD_NODE', node: { id: 'quality', title: '自动测试与独立审查', status: 'done', summary: '详见 docs/product-review.md 与 docs/code-review.md。' } },
    { type: 'ADD_NODE', node: { id: 'live', title: '真实 ChatGPT Pro 账号接入验收', status: 'blocked', summary: '尚需部署 HTTPS、配置域名并完成账号 OAuth 与 iframe 验收。', metadata: { nextStep: '按 docs/chatgpt-connection.md 配置部署并完成真实账号验收。' } } },
    { type: 'ADD_NODE', node: { id: 'future', title: '宿主 Project ID、workspace tab、可靠回调适配', status: 'parking', summary: '等待可用的官方宿主接口，不在 V1 虚构能力。' } },
    { type: 'ADD_DECISION', decision: { id: 'incremental', title: '采用增量更新与证据合并，刷新不重建状态', rationale: '保护人工决策与稳定身份。' } },
    { type: 'ADD_DECISION', decision: { id: 'platform', title: '如实标记平台与账号联调限制', rationale: '本地实现和测试不等于完整宿主自动化已经上线。' } },
  ],
});
if (result.outcome !== 'applied') throw new Error(`Unexpected export outcome: ${result.outcome}`);
writeFileSync('task-map.md', `> 仓库交付检查点，非用户运行时数据库；构建后使用 node scripts/export-delivery.mjs 重新生成。\n\n${renderMarkdown(result.state)}`);
store.close();
