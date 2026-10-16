import { approvalIssue, pendingReviewGroups } from './review-model';
import { QuickIdea } from './QuickIdea';
import { ParkingLot, relatedIds } from './ParkingLot';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClient } from './api';
import { createHostAdapter } from './host';
import { TaskBrowser } from './TaskBrowser';
import { ReviewChanges } from './ReviewChanges';
import { Status, statusLabels } from './TaskTree';
import { demoState } from './demo';
import type { Conflict, Delta, HistoryEntry, HostAdapter, HostContext, MutationResult, Operation, ProjectState, TaskNode, TaskStatus } from './types';

const tabs = ['概览', '任务树', '决策日志', 'Parking Lot'] as const;
const timeLabel = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未同步';
const uuid = () => crypto.randomUUID();
const canApprove = (conflict: Conflict) => conflict.delta.operations.some(operation => operation.type !== 'NO_OP');
const conflictExplanation = (conflict: Conflict) => !canApprove(conflict)
  ? conflict.kind === 'invalid_focus'
    ? '这份旧提案设置了多个当前任务，未生成可执行更改，不能直接批准。已保存的地图不受影响；可保留当前状态并关闭此提案，需要更新时重新核对项目。'
    : '这份提案存在歧义或已过期，未生成可执行更改，不能直接批准。请保留当前状态，需要更新时重新核对项目。'
  : conflict.message;
const nextStepText = (node?: TaskNode) => typeof node?.metadata.nextStep === 'string' ? node.metadata.nextStep : '';
function savedBinding() { try { return sessionStorage.getItem('task-map.binding') || `map-${uuid()}`; } catch { return `map-${uuid()}`; } }

export function refreshPrompt(state: ProjectState) {
  return `输出我们任务概况目前进度，并更新 Taskmap。当前 projectId=${state.projectId}，版本=${state.version}。先基于当前可访问的项目上下文输出目标、任务进展、当前焦点、下一步、阻塞、决策及暂存事项，并明确上下文覆盖范围和来源；再用 get_project_state 读取最新状态并调用 reconcile_project 工具增量合并。仅整理当前可见且有依据的项目事实；没有新增可核实事实时保留已保存地图并如实说明没有新增事实；只有读回地图确实未保存任务时才说明当前地图尚未保存任务。不编造任务，不读取不可见的其他对话。保留已有节点 ID、人工更改和未提及的任务，不把重复提及视为重新开启。完成后用文字说明保存结果和版本；pending 仅表示待审，不报告为已导入。当前地图会自动读取已保存的变化，不要调用 get_project_map 创建新界面。`;
}

export function App({ initialState, initialToken = '', apiBaseUrl = '', host: suppliedHost }: { initialState?: ProjectState; initialToken?: string; apiBaseUrl?: string; host?: HostAdapter }) {
  const isDemo = !initialState && new URLSearchParams(window.location.search).get('demo') === '1';
  const [state, setState] = useState<ProjectState | null>(initialState || (isDemo ? demoState : null));
  const stateRef = useRef(state); stateRef.current = state;
  const projectRef = useRef(state?.projectId);
  const [tab, setTab] = useState<typeof tabs[number]>('概览');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [verifiedConnection, setVerifiedConnection] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(Boolean(initialToken));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [ideaSeed, setIdeaSeed] = useState({ key: 0, ids: [] as string[] });
  function captureIdea(ids: string[] = []) { setSelectedId(null); setIdeaSeed(seed => ({ key: seed.key + 1, ids })); setTab('Parking Lot'); }
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
  const allowSameOrigin = useRef(!apiBaseUrl);
  const adapter = useRef<HostAdapter | null>(null);
  const staged = useRef(new Set<string>());
  const mounted = useRef(true);
  const contextGeneration = useRef(0);
  const readProof = useRef(0);
  const verifiedState = useRef<{ projectId: string; version: number } | null>(null);
  const auditRevision = useRef(0);
  const historyVisible = useRef(showHistory); historyVisible.current = showHistory;
  const historyVersion = useRef<number | null>(null);
  const auditRequest = useRef<{ projectId: string; generation: number; revision: number; includeHistory: boolean; version?: number; refreshRequested: boolean; promise: Promise<void> } | null>(null);

  const invalidateConnection = useCallback(() => {
    contextGeneration.current++; readProof.current++; historyVersion.current = null;
    setVerifiedConnection(false); setReadError(''); setAuditError('');
    setBusy(false);
    setConnectionRevision(previous => previous + 1);
  }, []);

  const adoptState = useCallback((next: ProjectState, source: 'server' | 'snapshot' = 'server') => {
    if (!mounted.current) return;
    if (projectRef.current && projectRef.current !== next.projectId) return;
    setState(previous => {
      if (previous?.projectId === next.projectId && source === 'snapshot' && verifiedState.current?.projectId === next.projectId && next.version <= verifiedState.current.version) return previous;
      return !previous || previous.projectId !== next.projectId || next.version >= previous.version ? next : previous;
    });
  }, []);
  const confirmState = useCallback((next: ProjectState) => {
    verifiedState.current = { projectId: next.projectId, version: Math.max(verifiedState.current?.projectId === next.projectId ? verifiedState.current.version : -1, next.version) };
    adoptState(next); readProof.current++; setVerifiedConnection(true); setReadError('');
  }, [adoptState]);
  const loadAudit = useCallback(async (id: string, includeHistory = true, version = stateRef.current?.version) => {
    if (!api.authenticated || isDemo) return;
    const generation = contextGeneration.current;
    const pending = auditRequest.current;
    if (pending?.projectId === id && pending.generation === generation) {
      pending.includeHistory ||= includeHistory;
      if (version !== undefined) pending.version = Math.max(pending.version ?? version, version);
      if (pending.revision !== auditRevision.current) pending.refreshRequested = true;
      return pending.promise;
    }
    const current = () => mounted.current && contextGeneration.current === generation && projectRef.current === id;
    const request = { projectId: id, generation, revision: auditRevision.current, includeHistory, version, refreshRequested: false, promise: Promise.resolve() };
    request.promise = (async () => {
      do {
        request.refreshRequested = false;
        request.revision = auditRevision.current;
        const revision = request.revision, requestedVersion = request.version;
        const fresh = () => current() && auditRevision.current === revision;
        let failed = false;
        try { const reviews = await api.conflicts(id); if (fresh()) setConflicts(reviews); }
        catch { failed = true; }
        if (request.includeHistory && fresh()) {
          try {
            const revisions = await api.history(id);
            if (fresh()) { setHistory(revisions); historyVersion.current = requestedVersion ?? null; }
          } catch { failed = true; }
        }
        if (fresh()) setAuditError(failed ? '审批或版本记录暂未刷新，已保留原记录，将自动重试。' : '');
        // Writes invalidate replies captured before they were saved. Flush one
        // fresh audit after the current read; simultaneous writes share it.
      } while (current() && request.refreshRequested);
    })().finally(() => { if (auditRequest.current === request) auditRequest.current = null; });
    auditRequest.current = request;
    return request.promise;
  }, [api, isDemo]);
  const acceptResult = useCallback(async (result: MutationResult) => {
    if (projectRef.current && result.state.projectId !== projectRef.current) return;
    confirmState(result.state);
    auditRevision.current++;
    if (result.conflict && result.conflict.status !== 'pending') {
      const reviewedId = result.conflict.id;
      setConflicts(previous => previous.filter(conflict => conflict.id !== reviewedId));
    }
    if (result.outcome === 'pending') setNotice(result.conflict?.message || '更新需要人工确认，当前地图保持不变。');
    else setNotice(result.outcome === 'no_op' ? '已核对，没有需要修改的内容。' : result.outcome === 'duplicate' ? '此更新已保存，无需重复应用。' : '已保存，地图已更新。');
    void loadAudit(result.state.projectId, true, result.state.version);
  }, [confirmState, loadAudit]);

  useEffect(() => {
    mounted.current = true;
    api.configure(initialToken, apiBaseUrl);
    const host = suppliedHost || createHostAdapter();
    adapter.current = host;
    api.useHost(host);
    async function onContext(context: HostContext) {
      if (!context.state && context.pendingDelta && context.pendingDelta.projectId !== projectRef.current) return;
      let generation = contextGeneration.current;
      try {
        if (context.state && projectRef.current !== context.state.projectId) {
          if (projectRef.current) { allowSameOrigin.current = false; token.current = ''; base.current = ''; api.configure('', ''); }
          verifiedState.current = null;
          projectRef.current = context.state.projectId;
          invalidateConnection(); setConnected(false); setError('');
          generation = contextGeneration.current;
          setSelectedId(null); setConflicts([]); setHistory([]); setShowHistory(false); setShowAdd(false); setBoundKey(null);
          setShowPrompt(false); setShowCredentials(false); setRollbackTarget(null); setGoalEditing(false); setOwnerSecret('');
          setNotice('已载入保存的地图快照，等待宿主提供当前项目的连接信息。');
        }
        if (context.state) {
          if (context.bindingKey) setBoundKey(context.bindingKey);
          adoptState(context.state, 'snapshot');
        }
        const nextToken = context.projectToken || token.current;
        const nextBase = context.apiBaseUrl || base.current;
        const connectionChanged = nextToken !== token.current || nextBase !== base.current;
        try { api.configure(nextToken, nextBase); }
        catch (failure) {
          api.configure('', ''); token.current = ''; base.current = ''; allowSameOrigin.current = false;
          invalidateConnection(); generation = contextGeneration.current; setConnected(false);
          setNotice('已载入保存的地图快照，等待宿主提供当前项目的连接信息。');
          throw failure;
        }
        token.current = nextToken; base.current = nextBase;
        if (connectionChanged) invalidateConnection();
        generation = contextGeneration.current;
        const ready = api.authenticated && Boolean(nextBase || host.canCallTools?.() || allowSameOrigin.current && window.parent === window && /^https?:$/.test(window.location.protocol));
        setConnected(ready);
        if (context.state) {
          if (!ready) setNotice('已载入保存的地图快照，等待宿主提供当前项目的连接信息。');
          else if (verifiedState.current?.projectId !== context.state.projectId || context.state.version > verifiedState.current.version) setNotice('已载入保存的地图快照，正在检查最新状态。');
        } else if (ready) {
          setNotice(previous => previous.includes('等待宿主') ? '已取得当前项目连接信息，正在检查最新状态。' : previous);
        }
        if (context.pendingDelta && ready && context.pendingDelta.projectId === projectRef.current) {
          const key = `${context.pendingDelta.projectId}:${context.pendingDelta.idempotencyKey}`;
          if (!staged.current.has(key)) {
            staged.current.add(key);
            try { const result = await api.apply(context.pendingDelta, false); if (contextGeneration.current === generation) await acceptResult(result); } catch (failure) { staged.current.delete(key); throw failure; }
          }
        }
      } catch (failure) { if (mounted.current && contextGeneration.current === generation) setError(failure instanceof Error ? failure.message : '无法同步项目地图。'); }
    }
    if (!isDemo) host.connect(context => { void onContext(context); }).catch(() => { /* Direct browser mode has a manual binding form. */ });
    return () => { mounted.current = false; api.useHost(undefined); host.close(); };
  }, [acceptResult, adoptState, api, apiBaseUrl, initialToken, invalidateConnection, isDemo, suppliedHost]);

  useEffect(() => {
    if (!state || !connected || isDemo) return;
    const projectId = state.projectId;
    const generation = contextGeneration.current;
    let inFlight = false, cancelled = false, failures = 0;
    let poll: number | undefined;
    const reload = async () => {
      if (inFlight || cancelled || contextGeneration.current !== generation || projectRef.current !== projectId) return;
      if (poll !== undefined) window.clearTimeout(poll);
      inFlight = true;
      const proof = readProof.current;
      try {
        const next = await api.state(projectId);
        if (!cancelled && contextGeneration.current === generation && projectRef.current === projectId) {
          failures = 0; confirmState(next);
          setNotice(previous => previous.includes('地图快照') || previous.includes('正在检查最新状态') ? '已读取服务器最新地图。' : previous);
          void loadAudit(projectId, historyVisible.current || historyVersion.current !== next.version, next.version);
        }
      } catch (failure) {
        failures++;
        if (!cancelled && contextGeneration.current === generation && projectRef.current === projectId && readProof.current === proof) {
          setReadError(failure instanceof Error ? failure.message : '无法读取地图'); setNotice('');
        }
      } finally {
        inFlight = false;
        if (!cancelled && contextGeneration.current === generation && document.visibilityState === 'visible') {
          poll = window.setTimeout(() => { void reload(); }, failures ? Math.min(15000 * 2 ** (failures - 1), 120000) : 30000);
        }
      }
    };
    void reload();
    const resume = () => {
      if (document.visibilityState === 'visible') void reload();
      else if (poll !== undefined) window.clearTimeout(poll);
    };
    window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { cancelled = true; if (poll !== undefined) window.clearTimeout(poll); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [state?.projectId, connected, connectionRevision, api, confirmState, loadAudit, isDemo]);

  async function run(action: (current: () => boolean, trackConnection: () => void) => Promise<void>) {
    if (busy) return false;
    const scope = { generation: contextGeneration.current, projectId: projectRef.current };
    const current = () => mounted.current && scope.generation === contextGeneration.current && scope.projectId === projectRef.current;
    const trackConnection = () => { scope.generation = contextGeneration.current; scope.projectId = projectRef.current; };
    setBusy(true); setError('');
    try { await action(current, trackConnection); return current(); } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : '操作失败，已保留上次状态。'); return false; } finally { if (current()) setBusy(false); }
  }
  async function bind(event: FormEvent) {
    event.preventDefault();
    await run(async (current, trackConnection) => {
      token.current = ownerSecret; api.configure(ownerSecret, base.current);
      const result = await api.bind(bindingKey.trim(), name.trim(), goal.trim());
      if (!current()) return;
      if (result.projectToken) token.current = result.projectToken;
      if (result.apiBaseUrl) base.current = result.apiBaseUrl;
      api.configure(token.current, base.current);
      if (projectRef.current !== result.state.projectId) { contextGeneration.current++; verifiedState.current = null; historyVersion.current = null; setReadError(''); setAuditError(''); }
      projectRef.current = result.state.projectId;
      trackConnection();
      setBoundKey(result.binding.bindingKey);
      setOwnerSecret(''); setConnected(true); confirmState(result.state);
      try { sessionStorage.setItem('task-map.binding', result.binding.bindingKey); } catch { /* Private browsing may disable session storage. */ }
      setNotice('项目已连接。请在连接设置中查看绑定 key，并保存到该 ChatGPT Project 的项目说明中。');
    });
  }
  async function restoreConnection(event: FormEvent) {
    event.preventDefault();
    if (!state) return;
    await run(async (_current, trackConnection) => {
      const projectId = state.projectId;
      const previous = token.current, previousBase = base.current;
      api.configure(ownerSecret, base.current); token.current = ownerSecret;
      invalidateConnection();
      trackConnection(); setBusy(true);
      const generation = contextGeneration.current;
      try {
        const next = await api.state(projectId);
        if (contextGeneration.current !== generation || projectRef.current !== projectId) return;
        setOwnerSecret(''); setConnected(true); confirmState(next);
        setShowCredentials(false); setNotice('连接凭据已更新。');
        void loadAudit(projectId, true, next.version);
      } catch (failure) {
        if (contextGeneration.current !== generation || projectRef.current !== projectId) return;
        api.configure(previous, previousBase); token.current = previous; base.current = previousBase;
        invalidateConnection();
        trackConnection();
        throw failure;
      }
    });
  }
  async function manual(operations: Operation[]) {
    if (!state) return false;
    if (isDemo) { setNotice('当前为显式演示模式。连接真实项目后才能保存更改。'); return false; }
    if (!connected) { setError('请重新连接，获取有效的项目凭据后再保存。'); return false; }
    const timestamp = new Date().toISOString();
    const delta: Delta = { projectId: state.projectId, idempotencyKey: uuid(), expectedVersion: state.version, timestamp, source: 'manual', confidence: 1, evidence: [{ id: uuid(), kind: 'manual', label: '项目地图中的人工操作', timestamp }], operations };
    let saved = false;
    const completed = await run(async current => { const result = await api.apply(delta, true); if (!current()) return; saved = result.outcome !== 'pending'; await acceptResult(result); });
    return saved && completed;
  }
  async function requestRefresh() {
    if (!state) return;
    await run(async current => {
      const sent = !isDemo && await adapter.current?.sendRefresh(refreshPrompt(state));
      if (!current()) return;
      if (sent) { setNotice('已发送概况核对请求；处理结果请看对话，已保存的变化会自动显示在此地图。'); }
      else { setShowPrompt(true); setNotice('复制下方请求到项目对话，让 ChatGPT 核对后更新地图。'); }
    });
  }
  async function reviewConflict(conflictId: string, decision: 'approve' | 'reject') {
    if (!state || !connected) return;
    await run(async current => { const result = await api.review(state.projectId, conflictId, decision, state.version); if (current()) await acceptResult(result); });
  }
  async function restoreVersion(target: number) {
    if (!state || !connected) return;
    await run(async current => { const result = await api.rollback(state.projectId, target, state.version); if (!current()) return; await acceptResult(result); setRollbackTarget(null); });
  }
  async function exportArtifact(format: 'md' | 'html') {
    if (!state || isDemo) return;
    await run(async current => {
      const content = await api.artifact(state.projectId, format);
      if (!current()) return;
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
  const pending = pendingReviewGroups(conflicts);
  const blocked = state.nodes.filter(node => node.status === 'blocked');
  const done = state.nodes.filter(node => node.status === 'done');
  const branches = state.nodes.filter(node => node.parentId === null);
  return <main className="app-shell" aria-busy={busy}>
    {isDemo && <div className="demo-banner">演示数据 · 通过 ?demo=1 显式启用，不会写入真实项目</div>}
    <header className="app-header"><div className="brand"><span className="brand-icon small" aria-hidden="true">⌘</span><div><p className="eyebrow">PROJECT TASK MAP</p><h1>项目任务框架</h1></div></div><button className="button" onClick={() => captureIdea()}>＋ 记想法</button><button className="button refresh" onClick={requestRefresh} disabled={busy}><span aria-hidden="true" className={busy ? 'spin' : ''}>↻</span>刷新项目地图</button></header>
    <div className="project-context"><span>{state.name}</span><span className={`connection ${readError ? 'stale' : ''}`}><i />{readError ? '连接待恢复' : isDemo ? '演示' : connected ? verifiedConnection ? '已连接' : '正在检查连接' : '只读预览'}</span><span className="version">v{state.version}</span>{!isDemo && <button className="text-button" onClick={() => setShowCredentials(!showCredentials)}>连接设置</button>}</div>
    <QuickIdea key={state.projectId} busy={busy} onSave={manual} />
    <nav className="tabs" aria-label="项目地图视图">{tabs.map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}{item === 'Parking Lot' && state.parkingLot.length > 0 && <span className="count">{state.parkingLot.length}</span>}</button>)}</nav>
    {readError && !error && !selectedId && !showAdd && <div role="alert" className="error-box">{readError}<button className="text-button" disabled={busy || !connected} onClick={() => run(async current => { const next = await api.state(state.projectId); if (!current()) return; confirmState(next); void loadAudit(state.projectId, true, next.version); })}>重试连接</button></div>}
    {auditError && !selectedId && !showAdd && <div role="status" className="notice">{auditError}<button className="text-button" onClick={() => { void loadAudit(state.projectId); }}>重试记录</button></div>}
    {error && !selectedId && !showAdd && <div role="alert" className="error-box">{error}<button className="text-button" onClick={() => setError('')}>关闭</button></div>}
    {showCredentials && <form className="prompt-panel" onSubmit={restoreConnection}><div className="section-heading"><h2>恢复连接</h2><button type="button" className="text-button" onClick={() => setShowCredentials(false)}>收起</button></div><p className="field-hint">项目 ID：{state.projectId}</p>{boundKey && <label>已绑定的 key<input readOnly value={boundKey} onFocus={event => event.target.select()} /><span className="field-hint">保存到当前 ChatGPT Project 的项目说明中，后续连接时使用同一 key。</span></label>}<p className="field-hint">在 ChatGPT 中可再次打开地图取得新的短期凭据。独立浏览器可填写部署者凭据，恢复当前项目连接。</p><label>新的部署者凭据<input type="password" required autoComplete="off" value={ownerSecret} onChange={event => setOwnerSecret(event.target.value)} /></label><button className="button primary" disabled={busy}>更新连接凭据</button></form>}    {notice && !selectedId && !showAdd && <div role="status" className="notice">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    {showPrompt && <section className="prompt-panel"><div className="section-heading"><h2>发送给 ChatGPT</h2><button className="text-button" onClick={() => setShowPrompt(false)}>收起</button></div><textarea aria-label="项目概况恢复请求" readOnly value={refreshPrompt(state)} rows={5} onFocus={event => event.target.select()} /><p className="field-hint">选中并复制此请求。发送请求本身不会修改地图，只有核对后提交的更新才会保存。</p></section>}
    {!isDemo && state.nodes.length === 0 && <section className="prompt-panel" aria-label="首次整理项目进度"><h2>{verifiedConnection ? '当前地图尚未保存任务' : '当前快照还没有任务'}</h2><p>{verifiedConnection ? '这不代表项目没有任务。可根据当前可见上下文同步；没有可核实的事实时，地图会保持为空。' : '这不代表项目没有任务。服务器最新状态尚未确认，请等待当前项目连接后读取。'}</p><button className="button" disabled={busy} onClick={requestRefresh}>整理当前可见进度</button></section>}
    {pending.length > 0 && <section className="review-section"><div className="section-heading"><h2>有 {pending.length} 项更新需要你确认</h2><span className="muted">原有状态已保留</span></div>{pending.map(({ conflict, copies }) => <article key={conflict.id} className="review-item"><div><span className="review-kind">{canApprove(conflict) ? "待审更改" : "需要重新核对的提案"}</span><p>{canApprove(conflict) && approvalIssue(state, conflict) ? approvalIssue(state, conflict) : canApprove(conflict) ? '请核对下列修改。批准后将按人工决定保存；保留当前则不应用本次提议。' : conflictExplanation(conflict)}</p>{canApprove(conflict) && <ReviewChanges state={state} operations={conflict.delta.operations} />}<details><summary>查看提议与依据</summary>{copies > 0 && <p className="field-hint">已合并 {copies} 条历史失败审批副本；处理原提案时一并归档，独立提案不受影响。</p>}<p className="field-hint">{conflict.message}</p>{canApprove(conflict) && <pre>{JSON.stringify(conflict.delta.operations, null, 2)}</pre>}{conflict.delta.evidence.map(source => <p className="field-hint" key={source.id}>{source.label} · {timeLabel(source.timestamp)}{source.excerpt && `：${source.excerpt}`}</p>)}</details></div><div className="review-actions"><button className="button" disabled={busy || isDemo} onClick={() => reviewConflict(conflict.id, 'reject')}>保留当前</button>{canApprove(conflict) && !approvalIssue(state, conflict) && <button className="button primary" disabled={busy || isDemo} onClick={() => reviewConflict(conflict.id, 'approve')}>批准更改</button>}</div></article>)}</section>}
    {(tab === '概览' || tab === '任务树') && <>
      <div className="summary-grid"><section className="summary-card goal-card"><div className="card-label"><span>GOAL / 项目目标</span><button className="text-button" onClick={() => { setGoal(state.goal); setGoalEditing(!goalEditing); }}>{goalEditing ? '取消' : '编辑'}</button></div>{goalEditing ? <form onSubmit={async event => { event.preventDefault(); if (await manual([{ type: 'UPDATE_GOAL', goal }])) setGoalEditing(false); }}><textarea aria-label="编辑项目目标" value={goal} required onChange={event => setGoal(event.target.value)} /><button className="button small-button" disabled={busy}>保存目标</button></form> : <h2>{state.goal || '尚未设定目标'}</h2>}<p className="card-foot">{branches.length} 条主线 <span>·</span> {done.length} / {state.nodes.length} 个任务完成{state.manualOverrides.goal && <span>· 人工保护</span>}</p></section>
      <section className="summary-card focus-card"><div className="card-label"><span><i className="focus-dot" />CURRENT FOCUS / 当前焦点</span>{focus && <Status status={focus.status} />}</div><h2>{focus?.title || '尚未选择当前任务'}</h2><p className="next-step"><span>下一步</span>{nextStepText(focus) || (focus ? '打开任务详情，补充一个明确的下一步。' : '在任务树选择任务，设为当前焦点。')}</p>{focus && <button className="text-button focus-link" onClick={() => setSelectedId(focus.id)}>查看任务详情 <span aria-hidden="true">↗</span></button>}</section></div>
      <section className="tree-panel"><div className="section-heading"><div><h2>任务地图 <span className="count">{state.nodes.length}</span></h2><p className="section-subtitle">顺着主线推进，保留每一个分支。</p></div><button className="button small-button" onClick={() => setShowAdd(true)}>＋ 添加任务</button></div><TaskBrowser state={state} onSelect={node => setSelectedId(node.id)} /><div className="tree-legend">{Object.entries(statusLabels).map(([value]) => <Status key={value} status={value as TaskStatus} />)}<span className="keyboard-hint">方向键浏览 · Enter 查看</span></div></section>
      {tab === '概览' && <div className="bottom-grid"><section className="small-panel"><div className="section-heading"><h2>最近决策</h2><button className="text-button" onClick={() => setTab('决策日志')}>查看全部 ↗</button></div>{state.decisions.slice(-3).reverse().map(decision => <article className="decision-mini" key={decision.id}><span className="timeline-dot" /><div><h3>{decision.title}</h3><p>{decision.rationale}</p><time>{timeLabel(decision.createdAt)}</time></div></article>)}{state.decisions.length === 0 && <p className="empty-copy">做出重要选择后，决策与原因会保存在这里。</p>}</section><section className="small-panel"><div className="section-heading"><h2>{blocked.length ? '需要关注' : 'Parking Lot'} <span className="count">{blocked.length || state.parkingLot.length}</span></h2><button className="text-button" onClick={() => setTab('Parking Lot')}>查看暂存 ↗</button></div>{(blocked.length ? blocked : state.nodes.filter(node => node.status === 'parking')).slice(0, 3).map(node => <button key={node.id} className="attention-item" onClick={() => setSelectedId(node.id)}><span>{node.title}</span><Status status={node.status} /></button>)}{blocked.length === 0 && state.parkingLot.length === 0 && <p className="empty-copy">当前没有阻塞或暂存事项，可以专注向前。</p>}</section></div>}
    </>}
    {tab === '决策日志' && <section className="tree-panel"><div className="section-heading"><div><h2>决策日志</h2><p className="section-subtitle">保留为什么这样做，让下一次讨论有据可依。</p></div><span className="count">{state.decisions.length}</span></div>{state.decisions.slice().reverse().map(decision => <article className="decision-full" key={decision.id}><time>{timeLabel(decision.createdAt)}</time><h3>{decision.title}</h3><p>{decision.rationale || '未补充决策原因'}</p><div className="source-list">{decision.sourceRefs.map(source => <span key={source.id} title={source.excerpt}>{source.label}</span>)}</div></article>)}{state.decisions.length === 0 && <div className="empty-state"><h3>还没有记录决策</h3><p>ChatGPT 识别到已确定的选择后，会带着依据记录在这里。</p></div>}</section>}
    {tab === 'Parking Lot' && <ParkingLot key={`${state.projectId}:${ideaSeed.key}`} state={state} busy={busy} initialRelated={ideaSeed.ids} onSave={manual} onSelect={setSelectedId} />}
    <footer className="app-footer"><div><span>增量同步 {timeLabel(state.lastIncrementalUpdate)}</span><span>完整核对 {timeLabel(state.lastFullReconcile)}</span></div><div><button className="text-button" onClick={() => { setShowHistory(!showHistory); if (!showHistory) void loadAudit(state.projectId); }}>版本记录</button><details className="export-menu"><summary>导出 ↗</summary><div><button disabled={busy || isDemo || !connected} onClick={() => exportArtifact('md')}>Markdown</button><button disabled={busy || isDemo || !connected} onClick={() => exportArtifact('html')}>HTML</button></div></details></div></footer>
    {showHistory && <section className="small-panel history-panel"><div className="section-heading"><h2>版本记录</h2><button className="text-button" onClick={() => setShowHistory(false)}>收起</button></div><p className="field-hint">恢复会生成新版本，保留完整历史，并保护恢复的内容。</p>{history.length === 0 && <p className="empty-copy">暂无可读取的版本记录。</p>}{history.slice().reverse().map(entry => <div className="history-row" key={entry.version}><div><strong>v{entry.version}</strong><span>{entry.reason}</span><time>{timeLabel(entry.createdAt)}</time></div>{entry.version < state.version && <button className="text-button" disabled={busy || isDemo} onClick={() => setRollbackTarget(entry.version)}>恢复此版本</button>}{entry.version === state.version && <span className="muted">当前</span>}</div>)}{rollbackTarget !== null && <div className="rollback-confirm" role="group" aria-label="确认恢复版本"><p>将版本 {rollbackTarget} 的内容恢复为新版本；此后人工保护将生效。</p><button className="button" onClick={() => setRollbackTarget(null)}>取消</button><button className="button primary" disabled={busy} onClick={() => restoreVersion(rollbackTarget)}>确认恢复</button></div>}</section>}
    {selected && <NodeDetails onCapture={() => captureIdea([selected.id])} onSelect={setSelectedId} node={selected} state={state} busy={busy} feedback={error || notice} feedbackIsError={Boolean(error)} onClose={() => setSelectedId(null)} onSave={manual} />}
    {showAdd && <AddNode state={state} busy={busy} feedback={error || notice} feedbackIsError={Boolean(error)} onClose={() => setShowAdd(false)} onSave={manual} />}
  </main>;
}

function NodeDetails({ onCapture, onSelect, node, state, busy, feedback, feedbackIsError, onClose, onSave }: { onCapture: () => void; onSelect: (id: string) => void; node: TaskNode; state: ProjectState; busy: boolean; feedback: string; feedbackIsError: boolean; onClose: () => void; onSave: (operations: Operation[]) => Promise<boolean> }) {
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
      if (status === 'active') operations.push({ type: 'START_NODE', nodeId: node.id });
      if (status === 'done') operations.push({ type: 'COMPLETE_NODE', nodeId: node.id });
      if (status === 'blocked') operations.push({ type: 'BLOCK_NODE', nodeId: node.id, reason: summary.slice(0, 300) || '人工标记受阻' });
      if (status === 'parking') operations.push({ type: 'PARK_NODE', nodeId: node.id, reason: summary.slice(0, 300) || '人工暂存' });
      if (status === 'dropped') operations.push({ type: 'DROP_NODE', nodeId: node.id, reason: summary || '人工放弃' });
      if (status === 'todo') operations.push({ type: 'UNBLOCK_NODE', nodeId: node.id });
    }
    if (operations.length) await onSave(operations);
  }
  return <div className="dialog-backdrop" onClick={onClose}><div className="detail-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]'); if (items?.length) { const first = items[0], last = items[items.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } } }}><div className="section-heading"><h2 id="detail-title">任务详情</h2><button className="icon-button" aria-label="关闭任务详情" onClick={onClose}>×</button></div>{feedback && <p role={feedbackIsError ? 'alert' : 'status'} className={feedbackIsError ? 'error-box' : 'notice'}>{feedback}</p>}<form onSubmit={save}><label>任务名称<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>说明 / 阻塞或暂存原因<textarea rows={3} value={summary} onChange={event => setSummary(event.target.value)} /></label><label>下一步<input value={nextStep} onChange={event => setNextStep(event.target.value)} placeholder="一个可以直接执行的动作" /></label><div className="form-columns"><label>状态<select value={status} onChange={event => setStatus(event.target.value as TaskStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value} disabled={((node.status === 'done' || node.status === 'dropped') && ![node.status, 'todo', 'active'].includes(value))}>{label}</option>)}</select></label><label>所属分支<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">主线任务</option>{state.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div><p className="field-hint">人工修改会保护此任务，AI 后续冲突更新需要你确认。</p><button className="button primary full-width" disabled={busy}>保存人工更改</button></form><section className="detail-section"><h3>当前焦点</h3><p className="field-hint">切换焦点不会改变其他进行中任务的状态。</p><button className="button" disabled={busy || node.status === 'blocked' || node.status === 'done' || node.status === 'dropped'} onClick={() => onSave([{ type: 'SET_ACTIVE_NODE', nodeId: state.activeNodeId === node.id ? null : node.id }])}>{state.activeNodeId === node.id ? '取消当前焦点' : '设为当前焦点'}</button></section><section className="detail-section"><h3>关联想法</h3><button className="button" onClick={onCapture}>为此任务记想法</button>{state.nodes.filter(idea => idea.status === 'parking' && relatedIds(idea).includes(node.id)).map(idea => <button className="text-button idea-backlink" key={idea.id} onClick={() => onSelect(idea.id)}>{idea.title} ↗</button>)}</section><section className="detail-section"><h3>依赖任务</h3>{node.dependencies.length === 0 && <p className="empty-copy">没有前置依赖。</p>}{node.dependencies.map(id => { const prerequisite = state.nodes.find(item => item.id === id); return <div className="dependency-item" key={id}><span>{prerequisite?.title || id}</span>{prerequisite && <Status status={prerequisite.status} />}<button className="text-button" disabled={busy} onClick={() => onSave([{ type: 'REMOVE_DEPENDENCY', nodeId: node.id, dependencyId: id }])}>移除</button></div>; })}<div className="dependency-add"><select aria-label="选择前置依赖" value={dependency} onChange={event => setDependency(event.target.value)}><option value="">选择前置任务</option>{state.nodes.filter(item => item.id !== node.id && !node.dependencies.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="button" disabled={!dependency || busy} onClick={async () => { if (await onSave([{ type: 'ADD_DEPENDENCY', nodeId: node.id, dependencyId: dependency }])) setDependency(''); }}>添加</button></div></section><section className="detail-section"><h3>来源与依据</h3>{node.sourceRefs.length === 0 && <p className="empty-copy">没有记录来源。</p>}{node.sourceRefs.map(source => <article className="source-item" key={source.id}><strong>{source.label}</strong><time>{timeLabel(source.timestamp)}</time>{source.excerpt && <p>{source.excerpt}</p>}</article>)}</section><p className="field-hint">最后更新 {timeLabel(node.updatedAt)}{node.manualOverride ? ' · 人工保护已开启' : ''}</p>{node.manualOverride && <button className="text-button" disabled={busy} onClick={() => onSave([{ type: 'UPDATE_NODE', nodeId: node.id, changes: { manualOverride: false } }])}>允许 AI 更新此任务（解除人工保护）</button>}</div></div>;
}

function AddNode({ state, busy, feedback, feedbackIsError, onClose, onSave }: { state: ProjectState; busy: boolean; feedback: string; feedbackIsError: boolean; onClose: () => void; onSave: (operations: Operation[]) => Promise<boolean> }) {
  const [title, setTitle] = useState(''); const [parentId, setParentId] = useState('');
  return <div className="dialog-backdrop"><form className="detail-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="add-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }} onSubmit={async event => { event.preventDefault(); if (await onSave([{ type: 'ADD_NODE', node: { id: uuid(), title: title.trim(), parentId: parentId || null, status: 'todo' } }])) onClose(); }}><div className="section-heading"><h2 id="add-title">添加任务</h2><button type="button" className="icon-button" aria-label="关闭添加任务" onClick={onClose}>×</button></div>{feedback && <p role={feedbackIsError ? 'alert' : 'status'} className={feedbackIsError ? 'error-box' : 'notice'}>{feedback}</p>}<label>任务名称<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder="清晰描述一项要完成的工作" /></label><label>所属分支<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">新建主线</option>{state.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label><button className="button primary full-width" disabled={busy || !title.trim()}>添加到地图</button></form></div>;
}
