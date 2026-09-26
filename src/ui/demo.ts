import type { ProjectState, TaskNode, TaskStatus } from './types';

// This fixture is loaded only by an explicit ?demo=1 or by tests. It is never persisted.
const date = '2026-09-26T03:00:00.000Z';
function node(id: string, title: string, parentId: string | null, status: TaskStatus, summary = '', nextStep?: string): TaskNode {
  return { id, title, summary, parentId, dependencies: [], status, createdAt: date, updatedAt: date, sourceRefs: [{ id: 'demo-source', kind: 'manual', label: '显式演示数据', timestamp: date }], manualOverride: false, metadata: nextStep ? { nextStep } : {} };
}
export const demoState: ProjectState = {
  projectId: 'demo-project', name: 'Task Map · 产品研发', goal: '打造一个融入 ChatGPT 工作流的项目管理工具，让每次讨论都成为可追踪的进展。', activeNodeId: 'ui', version: 12,
  nodes: [
    node('discovery', '产品定义与架构', null, 'done', '明确边界，建立可信的状态模型'),
    node('requirements', '需求与范围确认', 'discovery', 'done'),
    node('architecture', '数据模型与技术方案', 'discovery', 'done'),
    node('build', '核心能力开发', null, 'todo', '从对话中的真实变化生成增量更新'),
    node('storage', '项目绑定与持久化', 'build', 'done'),
    node('ui', '项目地图界面', 'build', 'active', '连接任务树、当前焦点与人工编辑', '完成节点详情交互，并验证状态同步。'),
    node('integration', 'ChatGPT 集成验证', 'build', 'blocked', '等待 HTTPS 部署地址与账户连接'),
    node('delivery', '验证与交付', null, 'todo', '覆盖关键场景，准备使用文档'),
    node('tests', '增量更新与冲突测试', 'delivery', 'todo'),
    node('future', '多项目聚合视图', null, 'parking', 'V1 只关注一个项目，后续再评估'),
  ],
  decisions: [{ id: 'd1', title: '任务状态保存在独立后端', rationale: '重开对话后复用同一地图，让历史与人工判断得以保留。', createdAt: date, sourceRefs: [] }, { id: 'd2', title: 'V1 保持单项目工作流', rationale: '优先让目标、焦点与下一步清楚可见。', createdAt: date, sourceRefs: [] }],
  parkingLot: [{ nodeId: 'future', reason: '超出 V1 范围，保留想法供后续评估。', parkedAt: date }],
  createdAt: date, updatedAt: date, lastIncrementalUpdate: date, lastFullReconcile: date, manualOverrides: { goal: false, focus: false },
};
