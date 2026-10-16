import { normalizeTitle } from '../domain/reducer';
import type { Operation, ProjectState, TaskNode } from './types';
import { statusLabels } from './TaskTree';

// Show a sequential preview, since several operations can affect the same field.
export function describeChanges(state: ProjectState, operations: Operation[]) {
  const working = structuredClone(state);
  const rows: { label: string; before: string; after: string }[] = [];
  const title = (id: unknown) => working.nodes.find(node => node.id === id)?.title || String(id ?? '未设置');
  const value = (input: unknown): string => input === undefined || input === null || input === '' ? '未设置' : typeof input === 'object' ? JSON.stringify(input) : String(input);
  for (const op of operations) {
    const node = working.nodes.find(node => node.id === op.nodeId);
    const add = (label: string, before: unknown, after: unknown) => rows.push({ label, before: value(before), after: value(after) });
    const statuses: Record<string, TaskNode['status']> = { START_NODE: 'active', COMPLETE_NODE: 'done', BLOCK_NODE: 'blocked', UNBLOCK_NODE: 'todo', PARK_NODE: 'parking', DROP_NODE: 'dropped' };
    if (op.type === 'NO_OP') continue;
    if (node && statuses[op.type]) { add(node.title, statusLabels[node.status], statusLabels[statuses[op.type]]); node.status = statuses[op.type]; }
    else if (op.type === 'UPDATE_GOAL') { add('项目目标', working.goal, op.goal); working.goal = String(op.goal); }
    else if (op.type === 'SET_ACTIVE_NODE') {
      add('当前焦点', title(working.activeNodeId), title(op.nodeId)); working.activeNodeId = op.nodeId as string | null;
      if (node && node.status !== 'active') { add(node.title, statusLabels[node.status], statusLabels.active); node.status = 'active'; }
    }
    else if (op.type === 'ADD_NODE') {
      const input = op.node as TaskNode;
      const existing = working.nodes.find(item => item.id === input.id || item.parentId === (input.parentId ?? null) && normalizeTitle(item.title) === normalizeTitle(input.title));
      add(existing ? '新增任务（已有对应项）' : '新增任务', existing ? `${existing.title} · ${statusLabels[existing.status]}` : '不存在', `${input.title} · ${statusLabels[input.status || 'todo']}`);
      if (!existing) working.nodes.push({ ...input, status: input.status || 'todo', metadata: input.metadata || {}, dependencies: input.dependencies || [] });
    }
    else if (node && op.type === 'UPDATE_NODE') {
      const labels: Record<string, string> = { title: '名称', summary: '说明', metadata: '任务属性', manualOverride: '人工保护' };
      for (const [key, next] of Object.entries(op.changes as Record<string, unknown>)) {
        const after = key === 'metadata' ? { ...node.metadata, ...next as object } : next;
        add(`${node.title} · ${labels[key] || key}`, node[key as keyof TaskNode], after);
        Object.assign(node, { [key]: after });
      }
    } else if (node && op.type === 'MOVE_NODE') { add(`${node.title} · 所属分支`, title(node.parentId), title(op.parentId)); node.parentId = op.parentId as string | null; }
    else if (op.type === 'ADD_DECISION') add('新增决策', '不存在', (op.decision as { title: string }).title);
    else if (op.type === 'ADD_DEPENDENCY' || op.type === 'REMOVE_DEPENDENCY') add(`${title(op.nodeId)} · 前置依赖`, op.type === 'REMOVE_DEPENDENCY' ? title(op.dependencyId) : '无此依赖', op.type === 'ADD_DEPENDENCY' ? title(op.dependencyId) : '移除此依赖');
    else add('任务变更', title(op.nodeId), '请展开原始提案检查');
  }
  return rows;
}

export function ReviewChanges({ state, operations }: { state: ProjectState; operations: Operation[] }) {
  return <div className="change-preview">{describeChanges(state, operations).map((row, index) => <div className="change-row" key={index}><strong>{row.label}</strong><div><span>当前</span><p>{row.before}</p></div><div><span>提议</span><p>{row.after}</p></div></div>)}</div>;
}
