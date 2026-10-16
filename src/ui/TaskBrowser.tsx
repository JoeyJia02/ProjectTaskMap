import { useState } from 'react';
import { relatedIds } from './ParkingLot';
import { TaskTree } from './TaskTree';
import type { ProjectState, TaskNode } from './types';

export function TaskBrowser({ state, onSelect }: { state: ProjectState; onSelect: (node: TaskNode) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('open');
  const linked = new Set(state.nodes.filter(node => node.status === 'parking').flatMap(relatedIds));
  const matches = state.nodes.filter(node => {
    const text = `${node.title} ${node.summary}`.toLocaleLowerCase();
    return text.includes(query.trim().toLocaleLowerCase()) && (filter === 'all'
      || filter === 'open' && !['done', 'dropped', 'parking'].includes(node.status)
      || filter === 'linked' && linked.has(node.id) || node.status === filter);
  });
  // Retain ancestors as context, even if they do not match the filter themselves.
  const ids = new Set(matches.map(node => node.id));
  const byId = new Map(state.nodes.map(node => [node.id, node]));
  for (const node of matches) {
    let parent = node.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) { seen.add(parent); ids.add(parent); parent = byId.get(parent)?.parentId ?? null; }
  }
  return <>
    <div className="task-toolbar"><input aria-label="搜索任务" placeholder="搜索任务名称或说明" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="筛选任务" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="open">未完成任务</option><option value="all">全部任务</option><option value="active">进行中</option><option value="blocked">受阻</option><option value="linked">有关联想法</option><option value="done">已完成</option>
      </select></div>
    <p className="field-hint">匹配 {matches.length} 项{ids.size > matches.length ? ' · 同时保留所属分支' : ''} · {state.nodes.filter(node => node.status === 'active').length} 项进行中</p>
    {matches.length || !state.nodes.length ? <TaskTree state={{ ...state, nodes: state.nodes.filter(node => ids.has(node.id)) }} onSelect={onSelect} /> : <p className="empty-copy">没有符合条件的任务。试试其他关键词或选择全部任务。</p>}
  </>;
}
