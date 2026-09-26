import { useMemo, useState, type KeyboardEvent } from 'react';
import type { ProjectState, TaskNode, TaskStatus } from './types';

export const statusLabels: Record<TaskStatus, string> = { todo: '待开始', active: '进行中', blocked: '受阻', done: '已完成', parking: '暂存', dropped: '已放弃' };
export function Status({ status }: { status: TaskStatus }) { return <span className={`status status-${status}`}><span aria-hidden="true" />{statusLabels[status]}</span>; }

export function TaskTree({ state, onSelect }: { state: ProjectState; onSelect: (node: TaskNode) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const children = useMemo(() => {
    const map = new Map<string | null, TaskNode[]>();
    state.nodes.forEach(node => map.set(node.parentId, [...(map.get(node.parentId) || []), node]));
    return map;
  }, [state.nodes]);
  const activePath = new Set<string>();
  let active = state.nodes.find(node => node.id === state.activeNodeId);
  while (active && !activePath.has(active.id)) { activePath.add(active.id); active = state.nodes.find(node => node.id === active?.parentId); }
  const visible: TaskNode[] = [];
  function walk(parent: string | null) { (children.get(parent) || []).forEach(node => { visible.push(node); if (!collapsed.has(node.id)) walk(node.id); }); }
  walk(null);
  const tabStop = visible.find(node => node.id === focused)?.id || visible[0]?.id;
  function focusNode(id: string) { setFocused(id); document.getElementById(`tree-${id}`)?.focus(); }
  function toggle(id: string) { setCollapsed(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function key(event: KeyboardEvent, node: TaskNode) {
    const index = visible.findIndex(item => item.id === node.id);
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowDown' && visible[index + 1]) focusNode(visible[index + 1].id);
    if (event.key === 'ArrowUp' && visible[index - 1]) focusNode(visible[index - 1].id);
    if (event.key === 'Home' && visible[0]) focusNode(visible[0].id);
    if (event.key === 'End' && visible.at(-1)) focusNode(visible.at(-1)!.id);
    if (event.key === 'ArrowRight') { if (collapsed.has(node.id)) toggle(node.id); else if (children.get(node.id)?.[0]) focusNode(children.get(node.id)![0].id); }
    if (event.key === 'ArrowLeft') { if (children.has(node.id) && !collapsed.has(node.id)) toggle(node.id); else if (node.parentId) focusNode(node.parentId); }
    if (event.key === 'Enter' || event.key === ' ') onSelect(node);
  }
  function render(parent: string | null) { return (children.get(parent) || []).map(node => {
    const hasChildren = children.has(node.id);
    return <li key={node.id} role="none" className={activePath.has(node.id) ? 'branch-path' : ''}>
      <div id={`tree-${node.id}`} role="treeitem" aria-label={`${node.title}，${statusLabels[node.status]}`} aria-owns={hasChildren && !collapsed.has(node.id) ? `tree-group-${node.id}` : undefined} aria-expanded={hasChildren ? !collapsed.has(node.id) : undefined} aria-current={state.activeNodeId === node.id ? 'step' : undefined} tabIndex={tabStop === node.id ? 0 : -1} className={`tree-row ${state.activeNodeId === node.id ? 'is-active' : ''}`} onFocus={() => setFocused(node.id)} onKeyDown={event => key(event, node)} onClick={() => onSelect(node)}>
        <button className={`disclosure ${hasChildren ? '' : 'leaf'}`} tabIndex={-1} aria-label={`${collapsed.has(node.id) ? '展开' : '折叠'} ${node.title}`} disabled={!hasChildren} onClick={event => { event.stopPropagation(); toggle(node.id); }}>{hasChildren ? (collapsed.has(node.id) ? '›' : '⌄') : '·'}</button>
        <span className="tree-text"><span className="node-title">{node.title}{node.manualOverride && <span className="manual-mark" title="人工编辑保护">人工</span>}</span>{node.summary && <span className="node-summary">{node.summary}</span>}</span>
        <Status status={node.status} />
      </div>
      {hasChildren && !collapsed.has(node.id) && <ul id={`tree-group-${node.id}`} role="group">{render(node.id)}</ul>}
    </li>;
  }); }
  return state.nodes.length ? <ul role="tree" aria-label="项目任务树" className="task-tree">{render(null)}</ul> : <div className="empty-state"><span className="empty-icon" aria-hidden="true">⌘</span><h3>从一条主线开始</h3><p>添加第一个任务，或让 ChatGPT 根据当前项目上下文建立任务地图。</p></div>;
}
