import { describe, expect, it } from 'vitest';
import { assessmentSchema, deltaSchema, overviewSchema, type ProjectState, type ProjectStateDelta } from '../src/domain/schema.js';
import { assessmentToDelta } from '../src/domain/assessment.js';
import { DomainConflict, reduceDelta, validateGraph } from '../src/domain/reducer.js';
import { planReconcile } from '../src/domain/reconcile.js';

const timestamp = '2026-09-26T01:00:00.000Z';
const evidence = [{ id: 'turn-1', kind: 'turn' as const, label: 'User confirmed', timestamp }];
const empty = (): ProjectState => ({ projectId: 'project', name: 'Map', goal: 'Ship', activeNodeId: null,
  nodes: [], decisions: [], parkingLot: [], version: 0, createdAt: timestamp, updatedAt: timestamp,
  lastIncrementalUpdate: null, lastFullReconcile: null, manualOverrides: { goal: false, focus: false } });
const delta = (operations: ProjectStateDelta['operations'], overrides: Partial<ProjectStateDelta> = {}): ProjectStateDelta => ({
  projectId: 'project', idempotencyKey: 'key', expectedVersion: 0, timestamp, source: 'ai', confidence: 1, evidence, operations, ...overrides,
});

describe('runtime contracts and deterministic assessment', () => {
  it('rejects contradicting NO_OP assessments and excess/unknown data', () => {
    expect(() => assessmentSchema.parse({ projectId: 'project', turnId: '1', expectedVersion: 0, timestamp, meaningful: false, confidence: 1, evidence,
      operations: [{ type: 'UPDATE_GOAL', goal: 'Changed' }] })).toThrow();
    expect(() => deltaSchema.parse({ ...delta([]), privileged: true })).toThrow();
    expect(() => deltaSchema.parse(delta([{ type: 'ADD_NODE', node: { id: 'bad', title: 'Bad metadata', metadata: { nextStep: { invalid: true } } } }] as unknown as ProjectStateDelta['operations']))).toThrow();
    expect(() => overviewSchema.parse({ projectId: 'p', reconcileId: 'r', expectedVersion: 0, timestamp, confidence: 1, evidence, coverage: 'Visible', nodes: [], rawChat: 'private' })).toThrow();
  });
  it('creates a stable turn key and removes literal NO_OP operations', () => {
    const result = assessmentToDelta({ projectId: 'project', turnId: 'turn', expectedVersion: 0, timestamp, meaningful: true, confidence: 1, evidence,
      operations: [{ type: 'NO_OP' }, { type: 'ADD_NODE', node: { id: 'idea', title: 'Later', status: 'parking' } }] });
    expect(result.idempotencyKey).toBe('turn:turn');
    expect(result.operations).toHaveLength(1);
    const state = reduceDelta(empty(), result).state;
    expect(state.nodes[0].status).toBe('parking'); expect(state.activeNodeId).toBeNull();
  });
});

describe('pure atomic graph reducer', () => {
  it('keeps parallel work active while changing or clearing focus', () => {
    let state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'a', title: 'A', status: 'active' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B', status: 'active' } }])).state;
    state = reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'a' }, { type: 'SET_ACTIVE_NODE', nodeId: 'b' }, { type: 'SET_ACTIVE_NODE', nodeId: null }])).state;
    expect(state.nodes.map(node => node.status)).toEqual(['active', 'active']);
    expect(state.activeNodeId).toBeNull();
    state = reduceDelta(state, delta([{ type: 'UNBLOCK_NODE', nodeId: 'a' }])).state;
    expect(state.nodes[0].status).toBe('todo');
    expect(state.nodes[1].status).toBe('active');
  });
  it('merges multiple active observations without inventing a focus and preserves terminal protections', () => {
    const overview = overviewSchema.parse({ projectId: 'project', reconcileId: 'parallel', expectedVersion: 0, timestamp, confidence: 1, evidence, coverage: 'Current work', nodes: [{ id: 'a', title: 'A', status: 'active' }, { id: 'b', title: 'B', status: 'active' }] });
    let state = reduceDelta(empty(), planReconcile(empty(), overview)).state;
    expect(state.nodes.filter(node => node.status === 'active')).toHaveLength(2);
    expect(state.activeNodeId).toBeNull();
    state = reduceDelta(state, delta([{ type: 'COMPLETE_NODE', nodeId: 'a' }])).state;
    expect(() => reduceDelta(state, delta([{ type: 'START_NODE', nodeId: 'a' }]))).toThrow(/explicit human/);
    expect(() => planReconcile(state, { ...overview, activeNodeId: 'a', nodes: [{ id: 'a', title: 'A', status: 'done' }] })).toThrow(/contradicts/);
  });
  it('does not mutate input and reports a net-zero batch as unchanged', () => {
    const initial = empty();
    const result = reduceDelta(initial, delta([{ type: 'UPDATE_GOAL', goal: 'Temporary' }, { type: 'UPDATE_GOAL', goal: 'Ship' }]));
    expect(result.changed).toBe(false); expect(result.state).toBe(initial);
    expect(initial.version).toBe(0);
  });
  it('rejects parent and dependency cycles, self links and missing endpoints', () => {
    for (const operations of [
      [{ type: 'ADD_NODE', node: { id: 'a', title: 'A', parentId: 'a' } }],
      [{ type: 'ADD_NODE', node: { id: 'a', title: 'A', parentId: 'missing' } }],
      [{ type: 'ADD_NODE', node: { id: 'a', title: 'A', dependencies: ['a'] } }],
      [{ type: 'ADD_NODE', node: { id: 'a', title: 'A', dependencies: ['b'] } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B', dependencies: ['a'] } }],
      [{ type: 'ADD_NODE', node: { id: 'a', title: 'A', parentId: 'b' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B', parentId: 'a' } }],
    ] as ProjectStateDelta['operations'][]) expect(() => reduceDelta(empty(), delta(operations))).toThrow(DomainConflict);
  });
  it('enforces prerequisites for activation/completion, without auto-activation', () => {
    let state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B', dependencies: ['a'] } }])).state;
    expect(() => reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'b' }]))).toThrow(/prerequisites/);
    expect(() => reduceDelta(state, delta([{ type: 'COMPLETE_NODE', nodeId: 'b' }]))).toThrow(/prerequisites/);
    state = reduceDelta(state, delta([{ type: 'COMPLETE_NODE', nodeId: 'a' }])).state;
    expect(state.nodes.find(node => node.id === 'b')?.status).toBe('todo');
    state = reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'b' }])).state;
    expect(state.activeNodeId).toBe('b'); validateGraph(state);
  });
  it('protects implicit focus edits and clears parking index on human reopening', () => {
    let state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'a', title: 'A' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'B', status: 'parking' } }])).state;
    state = reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'a' }], { source: 'manual' })).state;
    expect(() => reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'b' }]))).toThrow(/human/);
    state = reduceDelta(state, delta([{ type: 'SET_ACTIVE_NODE', nodeId: 'b' }], { source: 'manual' })).state;
    expect(state.nodes.find(node => node.id === 'a')?.status).toBe('active'); expect(state.parkingLot).toEqual([]);
    state = reduceDelta(state, delta([{ type: 'COMPLETE_NODE', nodeId: 'b' }], { source: 'manual' })).state;
    expect(state.activeNodeId).toBeNull();
  });
  it('requires evidence and sufficient confidence only for real changes', () => {
    expect(reduceDelta(empty(), delta([], { evidence: [], confidence: 0 })).changed).toBe(false);
    expect(() => reduceDelta(empty(), delta([{ type: 'UPDATE_GOAL', goal: 'New' }], { evidence: [] }))).toThrow(/evidence/);
    expect(() => reduceDelta(empty(), delta([{ type: 'UPDATE_GOAL', goal: 'New' }], { confidence: 0.79 }))).toThrow(/Confidence/);
  });
  it('conservatively deduplicates normalized titles and rejects replacement ADD', () => {
    const state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'a', title: ' Build   UI ' } }])).state;
    expect(reduceDelta(state, delta([{ type: 'ADD_NODE', node: { id: 'b', title: 'build ui' } }])).changed).toBe(false);
    expect(() => reduceDelta(state, delta([{ type: 'ADD_NODE', node: { id: 'b', title: 'build ui', summary: 'Contradiction' } }]))).toThrow(/already exists/);
  });
  it('keeps parent completion explicit', () => {
    const state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'parent', title: 'Parent' } }, { type: 'ADD_NODE', node: { id: 'child', title: 'Child', parentId: 'parent' } }, { type: 'COMPLETE_NODE', nodeId: 'child' }])).state;
    expect(state.nodes.find(node => node.id === 'parent')?.status).toBe('todo');
  });
  it('checks accumulated metadata bounds before accepting a merged update', () => {
    const state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'a', title: 'A', metadata: { first: 'x'.repeat(7000) } } }])).state;
    expect(() => reduceDelta(state, delta([{ type: 'UPDATE_NODE', nodeId: 'a', changes: { metadata: { second: 'y'.repeat(7000) } } }]))).toThrow(/Metadata/);
    expect(state.nodes[0].metadata.second).toBeUndefined();
  });
});

describe('overview planner', () => {
  it('requires ID for same-title cross-branch observations', () => {
    const state = reduceDelta(empty(), delta([{ type: 'ADD_NODE', node: { id: 'p', title: 'Parent' } }, { type: 'ADD_NODE', node: { id: 'a', title: 'Test' } }, { type: 'ADD_NODE', node: { id: 'b', title: 'Test', parentId: 'p' } }])).state;
    expect(() => planReconcile(state, { projectId: 'project', reconcileId: 'r', expectedVersion: 1, timestamp, confidence: 1, evidence, coverage: 'One chat', nodes: [{ title: 'Test', status: 'done' }] })).toThrow(/several tasks/);
  });
});
