import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectStore, StoreError } from '../src/store/index.js';
import type { ProjectStateDelta, ProjectOverview } from '../src/domain/schema.js';

let store: ProjectStore; let projectId: string; let sequence: number; let directory: string; let path: string;
const owner = 'owner';
function proposal(operations: ProjectStateDelta['operations'], overrides: Partial<ProjectStateDelta> = {}): ProjectStateDelta {
  sequence += 1; const timestamp = new Date(Date.UTC(2026, 8, 26, 1, sequence)).toISOString();
  return { projectId, idempotencyKey: `key-${sequence}`, expectedVersion: store.get(owner, projectId).version, timestamp,
    source: 'ai', confidence: 1, evidence: [{ id: `turn-${sequence}`, kind: 'turn', label: 'Confirmed change', timestamp }], operations, ...overrides };
}
function overview(nodes: ProjectOverview['nodes'], overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  const delta = proposal([]);
  return { projectId, reconcileId: delta.idempotencyKey, expectedVersion: delta.expectedVersion, timestamp: delta.timestamp,
    confidence: 1, evidence: delta.evidence, coverage: 'Ten newly supplied turns; other history not visible', nodes, ...overrides };
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'taskmap-store-')); path = join(directory, 'test.sqlite'); store = new ProjectStore(path);
  projectId = store.bind(owner, { bindingKey: 'stable-key', name: 'Project', goal: 'Ship' }).state.projectId; sequence = 0; });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

describe('durable, isolated binding', () => {
  it('survives rename, restart and owner scoped key reuse', () => {
    const other = store.bind('other-owner', { bindingKey: 'stable-key', name: 'Project' });
    expect(other.state.projectId).not.toBe(projectId);
    const renamed = store.bind(owner, { bindingKey: 'stable-key', name: 'Renamed', goal: 'Must not overwrite' });
    expect(renamed.state.projectId).toBe(projectId); expect(renamed.state.goal).toBe('Ship');
    store.close(); store = new ProjectStore(path);
    expect(store.bind(owner, { bindingKey: 'stable-key', name: 'Renamed' }).state).toEqual(renamed.state);
    expect(() => store.get('other-owner', projectId)).toThrow(StoreError);
    expect(() => store.apply('other-owner', proposal([{ type: 'UPDATE_GOAL', goal: 'attack' }]))).toThrow(/not found/);
    expect(() => store.history('other-owner', projectId)).toThrow(/not found/);
    expect(() => store.conflicts('other-owner', projectId)).toThrow(/not found/);
    expect(() => store.rollback('other-owner', projectId, 0, 1)).toThrow(/not found/);
    expect(() => store.review('other-owner', projectId, 'fake', 'reject', 1)).toThrow(/not found/);
  });
  it('uses verified host identity without conflating mismatched bindings', () => {
    const first = store.bind(owner, { bindingKey: 'host-one', name: 'Host', hostProjectId: 'host-id' });
    expect(store.bind(owner, { bindingKey: 'new-locator', name: 'Host', hostProjectId: 'host-id' }).state.projectId).toBe(first.state.projectId);
    expect(() => store.bind(owner, { bindingKey: 'stable-key', name: 'Wrong', hostProjectId: 'host-id' })).toThrow(/different projects/);
  });
});

describe('incremental scenarios A–D', () => {
  it('A: twenty delivered turns with four changes produce exactly four revisions', () => {
    for (let turn = 1; turn <= 20; turn += 1) {
      const meaningful = turn % 5 === 0; const request = proposal(meaningful ? [{ type: 'ADD_NODE', node: { id: `task-${turn}`, title: `Task ${turn}` } }] : []);
      const result = store.assess(owner, { projectId, turnId: `turn-${turn}`, expectedVersion: request.expectedVersion, timestamp: request.timestamp,
        meaningful, confidence: 1, evidence: request.evidence, operations: request.operations });
      expect(result.outcome).toBe(meaningful ? 'applied' : 'no_op');
    }
    expect(store.get(owner, projectId).version).toBe(4); expect(store.history(owner, projectId)).toHaveLength(5);
  });
  it('B: explicit 之后再看 observation goes to parking, never current focus', () => {
    const result = store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'later', title: '之后再看：探索插件', status: 'parking' } }]));
    expect(result.state.parkingLot[0].nodeId).toBe('later'); expect(result.state.activeNodeId).toBeNull();
  });
  it('C: mentioning completed work neither duplicates nor reopens it', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'done', title: 'Ship API' } }, { type: 'COMPLETE_NODE', nodeId: 'done' }]));
    expect(store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'new-id', title: ' ship   api ' } }])).outcome).toBe('no_op');
    expect(store.reconcile(owner, overview([{ title: 'Ship API', status: 'done' }])).outcome).toBe('no_op');
    const reopen = store.apply(owner, proposal([{ type: 'SET_ACTIVE_NODE', nodeId: 'done' }]));
    expect(reopen.outcome).toBe('pending'); expect(reopen.state.nodes).toHaveLength(1); expect(reopen.state.version).toBe(1);
  });
  it('D: manual drop survives old AI context and requires reviewed reopening', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'old', title: 'Abandoned task' } }]));
    store.apply(owner, proposal([{ type: 'DROP_NODE', nodeId: 'old', reason: 'User rejected direction' }], { source: 'manual' }));
    const blocked = store.apply(owner, proposal([{ type: 'SET_ACTIVE_NODE', nodeId: 'old' }]));
    expect(blocked.outcome).toBe('pending'); expect(blocked.state.nodes[0].status).toBe('dropped');
    const approved = store.review(owner, projectId, blocked.conflict!.id, 'approve', blocked.state.version);
    expect(approved.outcome).toBe('applied'); expect(approved.state.nodes[0].status).toBe('active'); expect(approved.state.nodes[0].manualOverride).toBe(true);
    expect(store.conflicts(owner, projectId).find(conflict => conflict.id === blocked.conflict!.id)?.status).toBe('approved');
  });
});

describe('consistency, receipts, audits and recovery', () => {
  it('six failed approvals do not multiply pending reviews or partially modify the project', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'existing', title: 'Existing task', summary: 'Saved' } }]));
    const request = proposal([{ type: 'UPDATE_GOAL', goal: 'Must not leak' }, { type: 'ADD_NODE', node: { id: 'different-id', title: 'Existing task', summary: 'Replacement' } }]);
    const pending = store.apply(owner, request);
    const before = store.get(owner, projectId), history = store.history(owner, projectId);
    for (let click = 0; click < 6; click++) {
      expect(() => store.review(owner, projectId, pending.conflict!.id, 'approve', before.version)).toThrow(/未新增待审项/);
      expect(store.conflicts(owner, projectId)).toHaveLength(1);
      expect(store.get(owner, projectId)).toEqual(before);
      expect(store.history(owner, projectId)).toEqual(history);
    }
    store.close(); store = new ProjectStore(path);
    expect(() => store.review(owner, projectId, pending.conflict!.id, 'approve', before.version)).toThrow(/已有任务/);
    expect(store.conflicts(owner, projectId)).toHaveLength(1);
  });
  it('archives only proven historical approval copies when the original is rejected', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'existing', title: 'Existing' } }]));
    const operations: ProjectStateDelta['operations'] = [{ type: 'ADD_NODE', node: { id: 'other-id', title: 'Existing', summary: 'Changed' } }];
    const root = store.apply(owner, proposal(operations)).conflict!;
    let parent = root;
    for (let copy = 0; copy < 6; copy++) {
      const key = `review:${parent.id}`;
      parent = store.apply(owner, proposal(operations, { source: 'manual', idempotencyKey: key,
        evidence: [{ id: key, kind: 'manual', label: 'Human approved proposal', timestamp: root.createdAt }] })).conflict!;
    }
    const independent = store.apply(owner, proposal(operations)).conflict!;
    expect(store.conflicts(owner, projectId).filter(item => item.status === 'pending')).toHaveLength(8);
    const before = store.get(owner, projectId);
    store.review(owner, projectId, root.id, 'reject', before.version);
    expect(store.get(owner, projectId)).toEqual(before);
    expect(store.conflicts(owner, projectId).filter(item => item.status === 'pending').map(item => item.id)).toEqual([independent.id]);
    expect(store.conflicts(owner, projectId)).toHaveLength(8);
  });
  it('performs literally zero table writes for NO_OP and identical updates', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }]));
    const before = store.get(owner, projectId); const connection = new DatabaseSync(path);
    const changes = () => connection.prepare('PRAGMA data_version').get()!.data_version;
    const baseline = changes();
    expect(store.apply(owner, proposal([])).outcome).toBe('no_op');
    expect(store.apply(owner, proposal([{ type: 'UPDATE_NODE', nodeId: 'a', changes: { title: 'A' } }])).outcome).toBe('no_op');
    expect(changes()).toBe(baseline); expect(store.get(owner, projectId)).toEqual(before); connection.close();
  });
  it('replays receipts after restart and rejects changed payload under the same key', () => {
    const request = proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }]);
    store.apply(owner, request); store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'b', title: 'B' } }]));
    store.close(); store = new ProjectStore(path);
    const replay = store.apply(owner, request); expect(replay.outcome).toBe('duplicate'); expect(replay.state.version).toBe(2);
    const conflict = store.apply(owner, { ...request, operations: [{ type: 'UPDATE_GOAL', goal: 'different' }] });
    expect(conflict.conflict?.kind).toBe('idempotency_conflict'); expect(store.get(owner, projectId).goal).toBe('Ship');
  });
  it('rejects atomic batches, deduplicates pending conflicts and audits rejection', () => {
    const invalid = proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }, { type: 'MOVE_NODE', nodeId: 'a', parentId: 'absent' }]);
    const result = store.apply(owner, invalid); expect(result.outcome).toBe('pending'); expect(result.state.nodes).toEqual([]);
    expect(store.apply(owner, invalid).conflict?.id).toBe(result.conflict?.id); expect(store.conflicts(owner, projectId)).toHaveLength(1);
    expect(store.apply(owner, { ...invalid, operations: [{ type: 'UPDATE_GOAL', goal: 'Changed' }] }).conflict?.kind).toBe('idempotency_conflict');
    const rejected = store.review(owner, projectId, result.conflict!.id, 'reject', 0);
    expect(rejected.conflict?.status).toBe('rejected'); expect(rejected.state.version).toBe(0); expect(rejected.conflict?.reviewedAt).toBeTruthy();
  });
  it('records stale versions without overwriting intervening work', () => {
    const stale = proposal([{ type: 'UPDATE_GOAL', goal: 'Stale goal' }]);
    store.apply(owner, proposal([{ type: 'UPDATE_GOAL', goal: 'Current goal' }]));
    const conflict = store.apply(owner, stale); expect(conflict.conflict?.kind).toBe('stale_version'); expect(conflict.state.goal).toBe('Current goal');
    expect(() => store.review(owner, projectId, conflict.conflict!.id, 'approve', 0)).toThrow(/Reload/);
  });
  it('protects node/goal/focus locks against MOVE, dependency changes and AI unlock', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B' } }]));
    store.apply(owner, proposal([{ type: 'UPDATE_NODE', nodeId: 'a', changes: { summary: 'Human choice' } }, { type: 'UPDATE_GOAL', goal: 'Human goal' }, { type: 'SET_ACTIVE_NODE', nodeId: 'b' }], { source: 'manual' }));
    for (const operation of [
      { type: 'MOVE_NODE', nodeId: 'a', parentId: 'b' }, { type: 'ADD_DEPENDENCY', nodeId: 'a', dependencyId: 'b' },
      { type: 'UPDATE_NODE', nodeId: 'a', changes: { manualOverride: false } }, { type: 'UPDATE_GOAL', goal: 'AI goal' }, { type: 'SET_ACTIVE_NODE', nodeId: null },
    ] as ProjectStateDelta['operations']) expect(store.apply(owner, proposal([operation])).outcome).toBe('pending');
    expect(store.get(owner, projectId).version).toBe(2);
  });
  it('never lowers temporal guards when historical evidence adds a previously unknown task', () => {
    const at = (hour: number) => `2026-09-26T${hour}:00:00.000Z`;
    const timed = (hour: number, operations: ProjectStateDelta['operations']) => proposal(operations, {
      timestamp: at(hour), evidence: [{ id: `time-${hour}`, kind: 'turn', label: 'Observed event', timestamp: at(hour) }],
    });
    const latest = store.apply(owner, timed(12, [{ type: 'UPDATE_GOAL', goal: 'Latest goal' }]));
    const historical = store.apply(owner, timed(10, [{ type: 'ADD_NODE', node: { id: 'historical', title: 'Missed historical work' } }]));
    expect(historical.outcome).toBe('applied'); expect(historical.state.lastIncrementalUpdate).toBe(at(12));
    expect(Date.parse(historical.state.updatedAt)).toBeGreaterThanOrEqual(Date.parse(latest.state.updatedAt));
    expect(historical.state.nodes[0].sourceRefs[0].timestamp).toBe(at(10));
    const attemptedOverwrite = store.apply(owner, timed(11, [{ type: 'UPDATE_GOAL', goal: 'Older goal' }]));
    expect(attemptedOverwrite.conflict?.kind).toBe('stale_evidence'); expect(attemptedOverwrite.state.goal).toBe('Latest goal');
    expect(store.apply(owner, timed(11, [{ type: 'SET_ACTIVE_NODE', nodeId: 'historical' }])).conflict?.kind).toBe('stale_evidence');
    const firstReconcile = store.reconcile(owner, overview([{ title: 'New recent work' }], { timestamp: at(14), evidence: [{ id: 'r14', kind: 'overview', label: 'Recent', timestamp: at(14) }] }));
    const olderReconcile = store.reconcile(owner, overview([{ title: 'Older missing work' }], { timestamp: at(13), evidence: [{ id: 'r13', kind: 'overview', label: 'Older', timestamp: at(13) }] }));
    expect(olderReconcile.outcome).toBe('applied'); expect(olderReconcile.state.lastFullReconcile).toBe(firstReconcile.state.lastFullReconcile);
  });
  it('rolls back as a new protected revision and keeps old receipts and history', () => {
    const original = proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }]); store.apply(owner, original);
    store.apply(owner, proposal([{ type: 'UPDATE_NODE', nodeId: 'a', changes: { summary: 'Later work' } }]));
    const result = store.rollback(owner, projectId, 1, 2);
    expect(result.state.version).toBe(3); expect(result.state.nodes[0].summary).toBe(''); expect(result.state.nodes[0].manualOverride).toBe(true);
    expect(result.state.manualOverrides).toEqual({ goal: true, focus: true }); expect(store.history(owner, projectId)).toHaveLength(4);
    expect(store.apply(owner, original).outcome).toBe('duplicate');
    expect(store.apply(owner, proposal([{ type: 'UPDATE_NODE', nodeId: 'a', changes: { summary: 'Old AI replay' } }])).outcome).toBe('pending');
  });
  it('does not let a new AI key resurrect items removed by a human rollback', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'removed', title: 'Abandoned plan' } }, { type: 'ADD_DECISION', decision: { id: 'old-choice', title: 'Old choice' } }]));
    store.rollback(owner, projectId, 0, 1);
    const restore = store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'new-id', title: 'Abandoned plan' } }]));
    expect(restore.conflict?.kind).toBe('rollback_guard');
    expect(store.apply(owner, proposal([{ type: 'ADD_DECISION', decision: { id: 'new-choice', title: 'Old choice' } }])).conflict?.kind).toBe('rollback_guard');
    const approved = store.review(owner, projectId, restore.conflict!.id, 'approve', 2);
    expect(approved.outcome).toBe('applied'); expect(approved.state.nodes[0].manualOverride).toBe(true);
  });
});

describe('overview recovery scenario E', () => {
  it('recovers ten missed turns in one merge, retaining IDs and omitted tasks', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'API' } }, { type: 'ADD_NODE', node: { id: 'omitted', title: 'Existing but unmentioned' } }]));
    const request = overview([{ title: 'API', status: 'done' }, { id: 'ui', title: 'UI', status: 'active', dependencies: ['a'], metadata: { nextStep: 'Implement tree' } }, { title: 'Maybe later', status: 'parking' }], {
      goal: 'Deliver map', decisions: [{ title: 'Use SQLite', rationale: 'Persistent personal deployment' }],
    });
    const result = store.reconcile(owner, request);
    expect(result.outcome).toBe('applied'); expect(result.state.version).toBe(2); expect(result.state.nodes).toHaveLength(4);
    expect(result.state.nodes.find(node => node.id === 'a')?.status).toBe('done'); expect(result.state.activeNodeId).toBe('ui');
    expect(result.state.lastFullReconcile).toBe(request.timestamp); expect(result.state.decisions).toHaveLength(1);
    expect(store.reconcile(owner, request).outcome).toBe('duplicate');
    store.close(); store = new ProjectStore(path); expect(store.get(owner, projectId)).toEqual(result.state);
  });
  it('stages ambiguous and stale observations without changing the graph', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }]));
    const stale = overview([{ id: 'a', title: 'A', summary: 'Old context' }], { evidence: [{ id: 'old', kind: 'overview', label: 'Old context', timestamp: '2020-01-01T00:00:00.000Z' }] });
    expect(store.reconcile(owner, stale).conflict?.kind).toBe('stale_evidence');
    expect(store.reconcile(owner, overview([{ title: 'A' }, { title: 'A' }])).conflict?.kind).toBe('ambiguous_observation');
    expect(store.get(owner, projectId).version).toBe(1);
  });
  it('retains last successful reconcile timestamp after no-change refresh', () => {
    const first = store.reconcile(owner, overview([{ title: 'A' }]));
    const second = store.reconcile(owner, overview([{ title: 'A' }]));
    expect(second.outcome).toBe('no_op'); expect(second.state).toEqual(first.state);
    expect(second.checkedAt).toBeTruthy(); expect(second.coverage).toBeTruthy();
  });
  it('resolves forward parent aliases and newly added dependency endpoints', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'parent', title: 'Parent' } }, { type: 'ADD_NODE', node: { id: 'child', title: 'Child', parentId: 'parent' } }]));
    const result = store.reconcile(owner, overview([
      { id: 'alias-child', title: 'Child', parentId: 'alias-parent', dependencies: ['new-prerequisite'] },
      { id: 'alias-parent', title: 'Parent' }, { id: 'new-prerequisite', title: 'New prerequisite' },
    ]));
    expect(result.outcome).toBe('applied'); expect(result.state.nodes).toHaveLength(3);
    expect(result.state.nodes.find(node => node.id === 'child')?.dependencies).toEqual(['new-prerequisite']);
    expect(result.state.nodes.find(node => node.id === 'alias-child')).toBeUndefined();
  });
  it('clears active focus when the overview explicitly reports todo', () => {
    store.apply(owner, proposal([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }, { type: 'SET_ACTIVE_NODE', nodeId: 'a' }]));
    const result = store.reconcile(owner, overview([{ id: 'a', title: 'A', status: 'todo' }], { activeNodeId: null }));
    expect(result.outcome).toBe('applied'); expect(result.state.activeNodeId).toBeNull(); expect(result.state.nodes[0].status).toBe('todo');
  });
});
