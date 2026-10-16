import { useRef, useState } from 'react';
import type { Operation, ProjectState, TaskNode } from './types';

export const relatedIds = (node: TaskNode): string[] => Array.isArray(node.metadata.relatedNodeIds) ? node.metadata.relatedNodeIds.filter((id): id is string => typeof id === 'string') : [];
const priorityRank = (node: TaskNode) => node.metadata.ideaPriority === 'high' ? 2 : node.metadata.ideaPriority === 'low' ? 0 : 1;
export function sortedIdeas(state: ProjectState, newest = false) {
  const dates = new Map(state.parkingLot.map(item => [item.nodeId, item.parkedAt]));
  return state.nodes.filter(node => node.status === 'parking').sort((a, b) => {
    const recent = Date.parse(dates.get(b.id) ?? b.createdAt) - Date.parse(dates.get(a.id) ?? a.createdAt);
    if (newest) return recent || a.id.localeCompare(b.id);
    return Number(b.metadata.ideaPinned === true) - Number(a.metadata.ideaPinned === true)
      || priorityRank(b) - priorityRank(a)
      || Number(relatedIds(b).includes(state.activeNodeId ?? '')) - Number(relatedIds(a).includes(state.activeNodeId ?? ''))
      || recent || a.id.localeCompare(b.id);
  });
}

export function ParkingLot({ state, busy, initialRelated = [], onSave, onSelect }: {
  state: ProjectState; busy: boolean; initialRelated?: string[];
  onSave: (operations: Operation[]) => Promise<boolean>; onSelect: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [related, setRelated] = useState(initialRelated);
  const [priority, setPriority] = useState('normal');
  const [pinned, setPinned] = useState(false);
  const [search, setSearch] = useState('');
  const [newest, setNewest] = useState(true);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const editingNode = state.nodes.find(node => node.id === editing);
  const reset = () => { setEditing(null); setTitle(''); setSummary(''); setRelated([]); setPriority('normal'); setPinned(false); setSearch(''); input.current?.focus(); };
  async function save() {
    if (busy || submitting.current || !title.trim() || (editing && editingNode?.status !== 'parking')) return;
    submitting.current = true; setSaving(true);
    const metadata = { relatedNodeIds: related, ideaPriority: priority, ideaPinned: pinned };
    const operations: Operation[] = editing
      ? [{ type: 'UPDATE_NODE', nodeId: editing, changes: { title: title.trim(), summary, metadata } }]
      : [{ type: 'ADD_NODE', node: { id: crypto.randomUUID(), title: title.trim(), summary, status: 'parking', metadata } }];
    try { if (await onSave(operations)) reset(); } finally { submitting.current = false; setSaving(false); }
  }
  return <section className="tree-panel parking-panel">
    <div className="section-heading"><div><h2>Parking Lot <span className="count">{state.parkingLot.length}</span></h2><p className="section-subtitle">先记下来，不打断当前任务。保存后立即入库，无需刷新整张地图。</p></div></div>
    <form className="idea-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="idea-fields" disabled={busy || saving}><h3>{editing ? '编辑想法' : '快速记想法'}</h3>
      <label>一句话想法<input ref={input} autoFocus required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：给任务增加截止日期提醒" /></label>
      <details className="idea-extra" open={editing !== null || initialRelated.length > 0 ? true : undefined}><summary>补充说明、关联任务与排序（可选）{related.length > 0 ? ` · 已关联 ${related.length} 项` : ''}</summary><label>补充说明（可选）<textarea maxLength={10000} rows={2} value={summary} onChange={event => setSummary(event.target.value)} /></label>
      <fieldset className="idea-relations"><legend>关联任务（可多选）</legend><input aria-label="搜索关联任务" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务名称" />
        <div className="idea-chips">{related.map(id => <button type="button" className="button small-button" key={id} onClick={() => setRelated(related.filter(value => value !== id))} aria-label={`取消关联 ${state.nodes.find(node => node.id === id)?.title ?? id}`}>{state.nodes.find(node => node.id === id)?.title ?? id} ×</button>)}</div>
        <div className="idea-options">{state.nodes.filter(node => node.id !== editing && node.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(node => <label key={node.id}><input type="checkbox" checked={related.includes(node.id)} disabled={!related.includes(node.id) && related.length >= 100} onChange={event => setRelated(event.target.checked ? [...related, node.id] : related.filter(id => id !== node.id))} />{node.title}</label>)}</div>
        <p className="field-hint">关联仅作参考，不会改变任务层级或前置依赖。</p>
      </fieldset>
      <div className="form-columns"><label>想法优先级<select value={priority} onChange={event => setPriority(event.target.value)}><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select></label><label className="idea-check"><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} />置顶</label></div>
      </details>
      {editing && editingNode?.status !== 'parking' && <p role="alert">该想法已移出暂存区，请重新查看任务。</p>}
      <div className="idea-actions"><button className="button primary" disabled={busy || saving || !title.trim() || Boolean(editing && editingNode?.status !== 'parking')}>{saving ? '保存中…' : editing ? '保存想法' : '存入 Parking Lot'}</button>{editing && <button type="button" className="button" onClick={reset} disabled={saving}>取消编辑</button>}</div>
    </fieldset></form>
    <div className="section-heading"><h3>已记下的想法</h3><label>排序<select value={newest ? 'newest' : 'auto'} onChange={event => setNewest(event.target.value === 'newest')}><option value="auto">自动排序</option><option value="newest">最新记录优先（顺序稳定）</option></select></label></div>
    <p className="field-hint">自动排序：置顶 → 优先级 → 关联当前焦点 → 最新记录。只调整展示顺序。</p>
    {sortedIdeas(state, newest).map(node => <article className="parking-item idea-item" key={node.id}>
      <div><h3>{node.title}</h3><p>{node.summary || state.parkingLot.find(item => item.nodeId === node.id)?.reason}</p><p className="field-hint">{node.metadata.ideaPinned === true ? '置顶 · ' : ''}{priorityRank(node) === 2 ? '高优先级' : priorityRank(node) === 0 ? '低优先级' : '普通优先级'}{relatedIds(node).includes(state.activeNodeId ?? '') ? ' · 关联当前焦点' : ''}</p>
        <div className="idea-chips">{relatedIds(node).map(id => <button className="text-button" key={id} onClick={() => onSelect(id)}>↗ {state.nodes.find(item => item.id === id)?.title ?? id}</button>)}</div></div>
      <div className="idea-actions"><button className="button small-button" disabled={busy || saving} onClick={() => { setEditing(node.id); setTitle(node.title); setSummary(node.summary); setRelated(relatedIds(node)); setPriority(typeof node.metadata.ideaPriority === 'string' ? node.metadata.ideaPriority : 'normal'); setPinned(node.metadata.ideaPinned === true); setSearch(''); input.current?.focus(); }}>编辑想法</button><button className="text-button" onClick={() => onSelect(node.id)}>查看任务</button></div>
    </article>)}
    {state.parkingLot.length === 0 && <p className="empty-copy">还没有想法，在上面记下第一条。</p>}
  </section>;
}
