import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClient } from './api';
import { createHostAdapter } from './host';
import { TaskTree, Status, statusLabels } from './TaskTree';
import { demoState } from './demo';
import type { Conflict, Delta, HistoryEntry, HostAdapter, HostContext, MutationResult, Operation, ProjectState, TaskNode, TaskStatus } from './types';

const tabs = ['概览', '任务树', '决策日志', 'Parking Lot'] as const;
const timeLabel = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未同步';
const uuid = () => crypto.randomUUID();
const nextStepText = (node?: TaskNode) => typeof node?.metadata.nextStep === 'string' ? node.metadata.nextStep : '';
function savedBinding() { try { return sessionStorage.getItem('task-map.binding') || `map-${uuid()}`; } catch { return `map-${uuid()}`; } }

export function refreshPrompt(state: ProjectState) {
  return `输出我们任务概况目前进度，并更新 TaskBoardApp。当前 projectId=${state.projectId}，版本=${state.version}。先基于当前可访问的项目上下文输出目标、任务进展、当前焦点、下一步、阻塞、决策及暂存事项，并明确上下文覆盖范围和来源；再读取最新状态并调用 reconcile_project 工具增量合并。保留已有节点 ID、人工更改和未提及的任务，不把重复提及视为重新开启。完成后返回已提交的项目地图。`;
}

export function App({ initialState, initialToken = '', apiBaseUrl = '', host: suppliedHost }: { initialState?: ProjectState; initialToken?: string; apiBaseUrl?: string; host?: HostAdapter }) {
  const isDemo = !initialState && new URLSearchParams(window.location.search).get('demo') === '1';
  const [state, setState] = useState<ProjectState | null>(initialState || (isDemo ? demoState : null));
  const stateRef = useRef(state); stateRef.current = state;
  const projectRef = useRef(state?.projectId);
  const [tab, setTab] = useState<typeof tabs[number]>('概览');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [syncPending, setSyncPending] = useState(false);
  const [connected, setConnected] = useState(Boolean(initialToken));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [bindingKey, setBindingKey] = useState(savedBinding);
  const [boundKey, setBoundKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [ownerSecret, setOwnerSecret] = useState('');
  const [goalEditing, setGoalEditing] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const api = useRef(new ApiClient()).current;
  const token = useRef(initialToken);
  const base = useRef(apiBaseUrl);
  const adapter = useRef<HostAdapter | null>(null);
  const staged = useRef(new Set<string>());
  const mounted = useRef(true);

  const adoptState = useCallback((next: ProjectState) => {
    if (!mounted.current) return;
    if (projectRef.current && projectRef.current !== next.projectId) return;
    setState(previous => !previous || previous.projectId !== next.projectId || next.version >= previous.version ? next : previous);
  }, []);
  const loadAudit = useCallback(async (id: string) => {
    if (!api.authenticated || isDemo) return;
    const [reviews, revisions] = await Promise.all([api.conflicts(id), api.history(id)]);
    if (mounted.current && stateRef.current?.projectId === id) { setConflicts(reviews); setHistory(revisions); }
  }, [api, isDemo]);
  const acceptResult = useCallback(async (result: MutationResult) => {
    if (projectRef.current && result.state.projectId !== projectRef.current) return;
    adoptState(result.state);
    if (result.outcome === 'pending') setNotice(result.conflict?.message || '更新需要人工确认，当前地图保持不变。');
    else setNotice(result.outcome === 'no_op' ? '已核对，没有需要修改的内容。' : result.outcome === 'duplicate' ? '此更新已保存，无需重复应用。' : '已保存，地图已更新。');
    await loadAudit(result.state.projectId);
  }, [adoptState, loadAudit]);

  useEffect(() => {
    mounted.current = true;
    api.configure(initialToken, apiBaseUrl);
    const host = suppliedHost || createHostAdapter();
    adapter.current = host;
    async function onContext(context: HostContext) {
      try {
        if (context.projectToken) token.current = context.projectToken;
        if (context.apiBaseUrl) base.current = context.apiBaseUrl;
        api.configure(token.current, base.current);
        if (api.authenticated) setConnected(true);
        if (context.state) {
          if (projectRef.current !== context.state.projectId) { setSelectedId(null); setConflicts([]); setHistory([]); setShowHistory(false); setShowAdd(false); setBoundKey(null); }
          projectRef.current = context.state.projectId;
          if (context.bindingKey) setBoundKey(context.bindingKey);
          adoptState(context.state); setSyncPending(false); setNotice('已载入最新项目地图。');
        }
        if (context.pendingDelta && api.authenticated) {
          const key = `${context.pendingDelta.projectId}:${context.pendingDelta.idempotencyKey}`;
          if (!staged.current.has(key)) {
            staged.current.add(key);
            try { await acceptResult(await api.apply(context.pendingDelta, false)); } catch (failure) { staged.current.delete(key); throw failure; }
          }
        }
      } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '无法同步项目地图。'); }
    }
    if (!isDemo) host.connect(context => { void onContext(context); }).catch(() => { /* Direct browser mode has a manual binding form. */ });
    return () => { mounted.current = false; host.close(); };
  }, [acceptResult, adoptState, api, apiBaseUrl, initialToken, isDemo, suppliedHost]);

  useEffect(() => {
    if (!state || !connected || isDemo) return;
    const projectId = state.projectId;
    loadAudit(projectId).catch(failure => setError(failure.message));
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      Promise.all([api.state(projectId), loadAudit(projectId)]).then(([next]) => { adoptState(next); if (projectRef.current === projectId) setError(''); }).catch(failure => { if (projectRef.current === projectId) setError(failure.message); });
    }, 15000);
    return () => window.clearInterval(poll);
  }, [state?.projectId, connected, api, adoptState, loadAudit, isDemo]);

  async function run(action: () => Promise<void>) {
    if (busy) return false;
    setBusy(true); setError('');
    try { await action(); return true; } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，已保留上次状态。'); return false; } finally { if (mounted.current) setBusy(false); }
  }
  async function bind(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      token.current = ownerSecret; api.configure(ownerSecret, base.current);
      const result = await api.bind(bindingKey.trim(), name.trim(), goal.trim());
      if (result.projectToken) token.current = result.projectToken;
      if (result.apiBaseUrl) base.current = result.apiBaseUrl;
      api.configure(token.current, base.current);
      projectRef.current = result.state.projectId;
      setBoundKey(result.binding.bindingKey);
      setOwnerSecret(''); setConnected(true); adoptState(result.state);
      try { sessionStorage.setItem('task-map.binding', result.binding.bindingKey); } catch { /* Private browsing may disable session storage. */ }
      setNotice('项目已连接。请在连接设置中查看绑定 key，并保存到该 ChatGPT Project 的项目说明中。');
    });
  }
  async function manual(operations: Operation[]) {
    if (!state) return false;
    if (isDemo) { setNotice('当前为显式演示模式。连接真实项目后才能保存更改。'); return false; }
    if (!connected) { setError('请重新连接，获取有效的项目凭据后再保存。'); return false; }
    const timestamp = new Date().toISOString();
    const delta: Delta = { projectId: state.projectId, idempotencyKey: uuid(), expectedVersion: state.version, timestamp, source: 'manual', confidence: 1, evidence: [{ id: uuid(), kind: 'manual', label: '项目地图中的人工操作', timestamp }], operations };
    let saved = false;
    await run(async () => { const result = await api.apply(delta, true); saved = result.outcome !== 'pending'; await acceptResult(result); });
    return saved;
  }
  async function requestRefresh() {
    if (!state) return;
    await run(async () => {
      const sent = !isDemo && await adapter.current?.sendRefresh(refreshPrompt(state));
      if (sent) { setSyncPending(true); setNotice('已请求 ChatGPT 整理项目概况；等待概况核对完成后才会更新地图。'); }
      else { setShowPrompt(true); setNotice('复制下方请求到项目对话，让 ChatGPT 核对后更新地图。'); }
    });
  }
  async function exportArtifact(format: 'md' | 'html') {
    if (!state || isDemo) return;
    await run(async () => {
      const content = await api.artifact(state.projectId, format);
      const url = URL.createObjectURL(new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `task-map.${format}`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出服务器保存的最新 ${format === 'md' ? 'Markdown' : 'HTML'}，实际版本记录在文件内容中。`);
    });
  }

  if (!state) return <main className="app-shell onboarding"><div className="brand-icon" aria-hidden="true">⌘</div><p className="eyebrow">PROJECT TASK MAP</p><h1>让项目进展，一目了然</h1><p className="onboarding-intro">为一个 ChatGPT Project 保存一张持续更新的任务地图。目标、当前工作和下一步，都在这里。</p><form onSubmit={bind} className="connect-form">
    <div className="section-heading"><h2>连接项目</h2><span className="muted">首次使用 / 恢复已有地图</span></div>
    <label>项目名称<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品 V1 交付" /></label>
    <label>项目目标 <span className="muted">可选</span><textarea maxLength={2000} rows={2} value={goal} onChange={event => setGoal(event.target.value)} placeholder="这个项目最终要完成什么？" /></label>
    <label>绑定 key<input required value={bindingKey} onChange={event => setBindingKey(event.target.value)} maxLength={200} spellCheck={false} /></label><p className="field-hint">恢复时填入原来的 key。相同账号与 key 会打开同一张地图，项目改名不会创建新地图。</p>
    <label>部署者凭据<input type="password" required value={ownerSecret} onChange={event => setOwnerSecret(event.target.value)} autoComplete="off" placeholder="Owner secret，仅保存在本次页面内存" /></label>
    {error && <p role="alert" className="error-box">{error}</p>}<button className="button primary full-width" type="submit" disabled={busy}>{busy ? '正在连接…' : '连接项目地图'}<span aria-hidden="true">↗</span></button>
  </form><p className="onboarding-note">在 ChatGPT 中通过 MCP 工具打开时，项目及短期凭据会由宿主安全传入。</p></main>;

  const focus = state.nodes.find(node => node.id === state.activeNodeId);
  const selected = state.nodes.find(node => node.id === selectedId);
  const pending = conflicts.filter(conflict => conflict.status === 'pending');
  const blocked = state.nodes.filter(node => node.status === 'blocked');
  const done = state.nodes.filter(node => node.status === 'done');
  const branches = state.nodes.filter(node => node.parentId === null);
  return <main className="app-shell" aria-busy={busy}>
    {isDemo && <div className="demo-banner">演示数据 · 通过 ?demo=1 显式启用，不会写入真实项目</div>}
    <header className="app-header"><div className="brand"><span className="brand-icon small" aria-hidden="true">⌘</span><div><p className="eyebrow">PROJECT TASK MAP</p><h1>项目任务框架</h1></div></div><button className="button refresh" onClick={requestRefresh} disabled={busy}><span aria-hidden="true" className={busy ? 'spin' : ''}>↻</span>刷新项目地图</button></header>
    <div className="project-context"><span>{state.name}</span><span className={`connection ${error ? 'stale' : ''}`}><i />{error ? '连接待恢复' : syncPending ? '等待概况核对' : isDemo ? '演示' : connected ? '已连接' : '只读预览'}</span><span className="version">v{state.version}</span>{!isDemo && <button className="text-button" onClick={() => setShowCredentials(!showCredentials)}>连接设置</button>}</div>
    <nav className="tabs" aria-label="项目地图视图">{tabs.map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}{item === 'Parking Lot' && state.parkingLot.length > 0 && <span className="count">{state.parkingLot.length}</span>}</button>)}</nav>
    {error && !selectedId && !showAdd && <div role="alert" className="error-box">{error}<button className="text-button" disabled={busy} onClick={() => run(async () => { adoptState(await api.state(state.projectId)); await loadAudit(state.projectId); })}>重试读取</button></div>}
    {showCredentials && <form className="prompt-panel" onSubmit={event => { event.preventDefault(); void run(async () => { const previous = token.current; api.configure(ownerSecret, base.current); try { const next = await api.state(state.projectId); token.current = ownerSecret; setOwnerSecret(''); setConnected(true); adoptState(next); setShowCredentials(false); setNotice('连接凭据已更新。'); } catch (failure) { api.configure(previous, base.current); throw failure; } }); }}><div className="section-heading"><h2>恢复连接</h2><button type="button" className="text-button" onClick={() => setShowCredentials(false)}>收起</button></div><p className="field-hint">项目 ID：{state.projectId}</p>{boundKey && <label>已绑定的 key<input readOnly value={boundKey} onFocus={event => event.target.select()} /><span className="field-hint">保存到当前 ChatGPT Project 的项目说明中，后续连接时使用同一 key。</span></label>}<p className="field-hint">在 ChatGPT 中可再次打开地图取得新的短期凭据。独立浏览器可填写部署者凭据，恢复当前项目连接。</p><label>新的部署者凭据<input type="password" required autoComplete="off" value={ownerSecret} onChange={event => setOwnerSecret(event.target.value)} /></label><button className="button primary" disabled={busy}>更新连接凭据</button></form>}    {notice && !selectedId && !showAdd && <div role="status" className="notice">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    {showPrompt && <section className="prompt-panel"><div className="section-heading"><h2>发送给 ChatGPT</h2><button className="text-button" onClick={() => setShowPrompt(false)}>收起</button></div><textarea aria-label="项目概况恢复请求" readOnly value={refreshPrompt(state)} rows={5} onFocus={event => event.target.select()} /><p className="field-hint">选中并复制此请求。发送请求本身不会修改地图，只有核对后提交的更新才会保存。</p></section>}
    {pending.length > 0 && <section className="review-section"><div className="section-heading"><h2>有 {pending.length} 项更新需要你确认</h2><span className="muted">原有状态已保留</span></div>{pending.map(conflict => <article key={conflict.id} className="review-item"><div><span className="review-kind">{conflict.kind}</span><p>{conflict.message}</p><details><summary>查看提议与依据</summary><pre>{JSON.stringify(conflict.delta.operations, null, 2)}</pre>{conflict.delta.evidence.map(source => <p className="field-hint" key={source.id}>{source.label} · {timeLabel(source.timestamp)}{source.excerpt && `：${source.excerpt}`}</p>)}</details></div><div className="review-actions"><button className="button" disabled={busy || isDemo} onClick={() => run(async () => acceptResult(await api.review(state.projectId, conflict.id, 'reject', state.version)))}>保留当前</button><button className="button primary" disabled={busy || isDemo} onClick={() => run(async () => acceptResult(await api.review(state.projectId, conflict.id, 'approve', state.version)))}>批准更改</button></div></article>)}</section>}
    {(tab === '概览' || tab === '任务树') && <>
      <div className="summary-grid"><section className="summary-card goal-card"><div className="card-label"><span>GOAL / 项目目标</span><button className="text-button" onClick={() => { setGoal(state.goal); setGoalEditing(!goalEditing); }}>{goalEditing ? '取消' : '编辑'}</button></div>{goalEditing ? <form onSubmit={async event => { event.preventDefault(); if (await manual([{ type: 'UPDATE_GOAL', goal }])) setGoalEditing(false); }}><textarea aria-label="编辑项目目标" value={goal} required onChange={event => setGoal(event.target.value)} /><button className="button small-button" disabled={busy}>保存目标</button></form> : <h2>{state.goal || '尚未设定目标'}</h2>}<p className="card-foot">{branches.length} 条主线 <span>·</span> {done.length} / {state.nodes.length} 个任务完成{state.manualOverrides.goal && <span>· 人工保护</span>}</p></section>
      <section className="summary-card focus-card"><div className="card-label"><span><i className="focus-dot" />CURRENT FOCUS / 当前焦点</span>{focus && <Status status={focus.status} />}</div><h2>{focus?.title || '尚未选择当前任务'}</h2><p className="next-step"><span>下一步</span>{nextStepText(focus) || (focus ? '打开任务详情，补充一个明确的下一步。' : '在任务树选择任务，设为当前焦点。')}</p>{focus && <button className="text-button focus-link" onClick={() => setSelectedId(focus.id)}>查看任务详情 <span aria-hidden="true">↗</span></button>}</section></div>
      <section className="tree-panel"><div className="section-heading"><div><h2>任务地图 <span className="count">{state.nodes.length}</span></h2><p className="section-subtitle">顺着主线推进，保留每一个分支。</p></div><button className="button small-button" onClick={() => setShowAdd(true)}>＋ 添加任务</button></div><TaskTree state={state} onSelect={node => setSelectedId(node.id)} /><div className="tree-legend">{Object.entries(statusLabels).map(([value]) => <Status key={value} status={value as TaskStatus} />)}<span className="keyboard-hint">方向键浏览 · Enter 查看</span></div></section>
      {tab === '概览' && <div className="bottom-grid"><section className="small-panel"><div className="section-heading"><h2>最近决策</h2><button className="text-button" onClick={() => setTab('决策日志')}>查看全部 ↗</button></div>{state.decisions.slice(-3).reverse().map(decision => <article className="decision-mini" key={decision.id}><span className="timeline-dot" /><div><h3>{decision.title}</h3><p>{decision.rationale}</p><time>{timeLabel(decision.createdAt)}</time></div></article>)}{state.decisions.length === 0 && <p className="empty-copy">做出重要选择后，决策与原因会保存在这里。</p>}</section><section className="small-panel"><div className="section-heading"><h2>{blocked.length ? '需要关注' : 'Parking Lot'} <span className="count">{blocked.length || state.parkingLot.length}</span></h2><button className="text-button" onClick={() => setTab('Parking Lot')}>查看暂存 ↗</button></div>{(blocked.length ? blocked : state.nodes.filter(node => node.status === 'parking')).slice(0, 3).map(node => <button key={node.id} className="attention-item" onClick={() => setSelectedId(node.id)}><span>{node.title}</span><Status status={node.status} /></button>)}{blocked.length === 0 && state.parkingLot.length === 0 && <p className="empty-copy">当前没有阻塞或暂存事项，可以专注向前。</p>}</section></div>}
    </>}
    {tab === '决策日志' && <section className="tree-panel"><div className="section-heading"><div><h2>决策日志</h2><p className="section-subtitle">保留为什么这样做，让下一次讨论有据可依。</p></div><span className="count">{state.decisions.length}</span></div>{state.decisions.slice().reverse().map(decision => <article className="decision-full" key={decision.id}><time>{timeLabel(decision.createdAt)}</time><h3>{decision.title}</h3><p>{decision.rationale || '未补充决策原因'}</p><div className="source-list">{decision.sourceRefs.map(source => <span key={source.id} title={source.excerpt}>{source.label}</span>)}</div></article>)}{state.decisions.length === 0 && <div className="empty-state"><h3>还没有记录决策</h3><p>ChatGPT 识别到已确定的选择后，会带着依据记录在这里。</p></div>}</section>}
    {tab === 'Parking Lot' && <section className="tree-panel"><div className="section-heading"><div><h2>Parking Lot</h2><p className="section-subtitle">先保存想法，等需要时再继续。</p></div><span className="count">{state.parkingLot.length}</span></div>{state.parkingLot.map(item => { const node = state.nodes.find(candidate => candidate.id === item.nodeId); return node && <article className="parking-item" key={item.nodeId}><div><h3>{node.title}</h3><p>{item.reason}</p><time>{timeLabel(item.parkedAt)}</time></div><button className="button small-button" onClick={() => setSelectedId(node.id)}>查看任务</button></article>; })}{state.parkingLot.length === 0 && <div className="empty-state"><h3>暂存区是空的</h3><p>“之后再看”的想法会进入这里，不会占用当前焦点。</p></div>}</section>}
    <footer className="app-footer"><div><span>增量同步 {timeLabel(state.lastIncrementalUpdate)}</span><span>完整核对 {timeLabel(state.lastFullReconcile)}</span></div><div><button className="text-button" onClick={() => setShowHistory(!showHistory)}>版本记录</button><details className="export-menu"><summary>导出 ↗</summary><div><button disabled={busy || isDemo || !connected} onClick={() => exportArtifact('md')}>Markdown</button><button disabled={busy || isDemo || !connected} onClick={() => exportArtifact('html')}>HTML</button></div></details></div></footer>
    {showHistory && <section className="small-panel history-panel"><div className="section-heading"><h2>版本记录</h2><button className="text-button" onClick={() => setShowHistory(false)}>收起</button></div><p className="field-hint">恢复会生成新版本，保留完整历史，并保护恢复的内容。</p>{history.length === 0 && <p className="empty-copy">暂无可读取的版本记录。</p>}{history.slice().reverse().map(entry => <div className="history-row" key={entry.version}><div><strong>v{entry.version}</strong><span>{entry.reason}</span><time>{timeLabel(entry.createdAt)}</time></div>{entry.version < state.version && <button className="text-button" disabled={busy || isDemo} onClick={() => setRollbackTarget(entry.version)}>恢复此版本</button>}{entry.version === state.version && <span className="muted">当前</span>}</div>)}{rollbackTarget !== null && <div className="rollback-confirm" role="group" aria-label="确认恢复版本"><p>将版本 {rollbackTarget} 的内容恢复为新版本；此后人工保护将生效。</p><button className="button" onClick={() => setRollbackTarget(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => run(async () => { await acceptResult(await api.rollback(state.projectId, rollbackTarget, state.version)); setRollbackTarget(null); })}>确认恢复</button></div>}</section>}
    {selected && <NodeDetails node={selected} state={state} busy={busy} feedback={error || notice} feedbackIsError={Boolean(error)} onClose={() => setSelectedId(null)} onSave={manual} />}
    {showAdd && <AddNode state={state} busy={busy} feedback={error || notice} feedbackIsError={Boolean(error)} onClose={() => setShowAdd(false)} onSave={manual} />}
  </main>;
}

function NodeDetails({ node, state, busy, feedback, feedbackIsError, onClose, onSave }: { node: TaskNode; state: ProjectState; busy: boolean; feedback: string; feedbackIsError: boolean; onClose: () => void; onSave: (operations: Operation[]) => Promise<boolean> }) {
  const [title, setTitle] = useState(node.title);
  const [summary, setSummary] = useState(node.summary);
  const [nextStep, setNextStep] = useState(nextStepText(node));
  const [status, setStatus] = useState<TaskStatus>(node.status);
  const [parentId, setParentId] = useState(node.parentId || '');
  const [dependency, setDependency] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => previous?.focus(); }, []);
  useEffect(() => { setTitle(node.title); setSummary(node.summary); setNextStep(nextStepText(node)); setStatus(node.status); setParentId(node.parentId || ''); }, [node.id]);
  async function save(event: FormEvent) {
    event.preventDefault(); const operations: Operation[] = [];
    if (title !== node.title || summary !== node.summary || nextStep !== (nextStepText(node))) operations.push({ type: 'UPDATE_NODE', nodeId: node.id, changes: { title, summary, metadata: { ...node.metadata, nextStep } } });
    if (parentId !== (node.parentId || '')) operations.push({ type: 'MOVE_NODE', nodeId: node.id, parentId: parentId || null });
    if (status !== node.status) {
      if (status === 'active') operations.push({ type: 'SET_ACTIVE_NODE', nodeId: node.id });
      if (status === 'done') operations.push({ type: 'COMPLETE_NODE', nodeId: node.id });
      if (status === 'blocked') operations.push({ type: 'BLOCK_NODE', nodeId: node.id, reason: summary.slice(0, 300) || '人工标记受阻' });
      if (status === 'parking') operations.push({ type: 'PARK_NODE', nodeId: node.id, reason: summary.slice(0, 300) || '人工暂存' });
      if (status === 'dropped') operations.push({ type: 'DROP_NODE', nodeId: node.id, reason: summary || '人工放弃' });
      if (status === 'todo') operations.push(...(node.status === 'active' ? [{ type: 'SET_ACTIVE_NODE', nodeId: null }] : [{ type: 'UNBLOCK_NODE', nodeId: node.id }]));
    }
    if (operations.length) await onSave(operations);
  }
  return <div className="dialog-backdrop" onClick={onClose}><div className="detail-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]'); if (items?.length) { const first = items[0], last = items[items.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } } }}><div className="section-heading"><h2 id="detail-title">任务详情</h2><button className="icon-button" aria-label="关闭任务详情" onClick={onClose}>×</button></div>{feedback && <p role={feedbackIsError ? 'alert' : 'status'} className={feedbackIsError ? 'error-box' : 'notice'}>{feedback}</p>}<form onSubmit={save}><label>任务名称<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>说明 / 阻塞或暂存原因<textarea rows={3} value={summary} onChange={event => setSummary(event.target.value)} /></label><label>下一步<input value={nextStep} onChange={event => setNextStep(event.target.value)} placeholder="一个可以直接执行的动作" /></label><div className="form-columns"><label>状态<select value={status} onChange={event => setStatus(event.target.value as TaskStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value} disabled={(node.status === 'parking' && value === 'todo') || ((node.status === 'done' || node.status === 'dropped') && ![node.status, 'todo', 'active'].includes(value))}>{label}</option>)}</select></label><label>所属分支<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">主线任务</option>{state.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div><p className="field-hint">人工修改会保护此任务，AI 后续冲突更新需要你确认。</p><button className="button primary full-width" disabled={busy}>保存人工更改</button></form><section className="detail-section"><h3>依赖任务</h3>{node.dependencies.length === 0 && <p className="empty-copy">没有前置依赖。</p>}{node.dependencies.map(id => { const prerequisite = state.nodes.find(item => item.id === id); return <div className="dependency-item" key={id}><span>{prerequisite?.title || id}</span>{prerequisite && <Status status={prerequisite.status} />}<button className="text-button" disabled={busy} onClick={() => onSave([{ type: 'REMOVE_DEPENDENCY', nodeId: node.id, dependencyId: id }])}>移除</button></div>; })}<div className="dependency-add"><select aria-label="选择前置依赖" value={dependency} onChange={event => setDependency(event.target.value)}><option value="">选择前置任务</option>{state.nodes.filter(item => item.id !== node.id && !node.dependencies.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="button" disabled={!dependency || busy} onClick={async () => { if (await onSave([{ type: 'ADD_DEPENDENCY', nodeId: node.id, dependencyId: dependency }])) setDependency(''); }}>添加</button></div></section><section className="detail-section"><h3>来源与依据</h3>{node.sourceRefs.length === 0 && <p className="empty-copy">没有记录来源。</p>}{node.sourceRefs.map(source => <article className="source-item" key={source.id}><strong>{source.label}</strong><time>{timeLabel(source.timestamp)}</time>{source.excerpt && <p>{source.excerpt}</p>}</article>)}</section><p className="field-hint">最后更新 {timeLabel(node.updatedAt)}{node.manualOverride ? ' · 人工保护已开启' : ''}</p>{node.manualOverride && <button className="text-button" disabled={busy} onClick={() => onSave([{ type: 'UPDATE_NODE', nodeId: node.id, changes: { manualOverride: false } }])}>允许 AI 更新此任务（解除人工保护）</button>}</div></div>;
}

function AddNode({ state, busy, feedback, feedbackIsError, onClose, onSave }: { state: ProjectState; busy: boolean; feedback: string; feedbackIsError: boolean; onClose: () => void; onSave: (operations: Operation[]) => Promise<boolean> }) {
  const [title, setTitle] = useState(''); const [parentId, setParentId] = useState('');
  return <div className="dialog-backdrop"><form className="detail-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="add-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }} onSubmit={async event => { event.preventDefault(); if (await onSave([{ type: 'ADD_NODE', node: { id: uuid(), title: title.trim(), parentId: parentId || null, status: 'todo' } }])) onClose(); }}><div className="section-heading"><h2 id="add-title">添加任务</h2><button type="button" className="icon-button" aria-label="关闭添加任务" onClick={onClose}>×</button></div>{feedback && <p role={feedbackIsError ? 'alert' : 'status'} className={feedbackIsError ? 'error-box' : 'notice'}>{feedback}</p>}<label>任务名称<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder="清晰描述一项要完成的工作" /></label><label>所属分支<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">新建主线</option>{state.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label><button className="button primary full-width" disabled={busy || !title.trim()}>添加到地图</button></form></div>;
}
