import { describe, expect, it } from 'vitest';
import { reduceDelta } from '../src/domain/reducer.js';
import { deltaSchema, projectStateSchema } from '../src/domain/schema.js';
import { demoState } from '../src/ui/demo.js';
import { sortedIdeas } from '../src/ui/ParkingLot.js';

const request = (ids: string[]) => deltaSchema.parse({ projectId: demoState.projectId, idempotencyKey: 'capture', expectedVersion: 12,
  timestamp: '2026-09-27T03:00:00Z', source: 'manual', confidence: 1, evidence: [],
  operations: [{ type: 'ADD_NODE', node: { id: 'idea', title: '快速想法', status: 'parking', metadata: { relatedNodeIds: ids, ideaPriority: 'high', ideaPinned: true } } }],
});

describe('quick parking capture', () => {
  it('stores multi-node relationships without changing focus, hierarchy or dependencies', () => {
    const original = projectStateSchema.parse(demoState);
    const { state } = reduceDelta(original, request(['ui', 'storage']));
    expect(state.activeNodeId).toBe(original.activeNodeId);
    expect(state.nodes.slice(0, original.nodes.length)).toEqual(original.nodes);
    expect(state.parkingLot.some(item => item.nodeId === 'idea')).toBe(true);
    const idea = state.nodes.find(node => node.id === 'idea')!;
    expect(idea.metadata.relatedNodeIds).toEqual(['ui', 'storage']);
    expect(idea.manualOverride).toBe(true);
    expect(idea.parentId).toBeNull(); expect(idea.dependencies).toEqual([]);
    expect(() => reduceDelta(state, { ...request([]), source: 'ai', operations: [{ type: 'UPDATE_NODE', nodeId: 'idea', changes: { metadata: { relatedNodeIds: [] } } }] })).toThrow(/protected/);
  });
  it('rejects dangling, duplicate and self references atomically', () => {
    const original = projectStateSchema.parse(demoState);
    for (const ids of [['missing'], ['idea'], ['ui', 'ui']]) expect(() => reduceDelta(original, request(ids))).toThrow();
    expect(original.nodes).toHaveLength(demoState.nodes.length);
    expect(() => deltaSchema.parse({ ...request([]), operations: [{ type: 'ADD_NODE', node: { id: 'bad', title: 'Invalid', metadata: { ideaPriority: 'urgent' } } }] })).toThrow();
  });
  it('orders pinned, priority, focus and recency without mutating stored tasks', () => {
    const state = structuredClone(demoState);
    const base = state.nodes.find(node => node.id === 'future')!;
    const ideas = [
      { ...base, id: 'recent', metadata: {}, createdAt: '2026-09-27T00:00:00Z' },
      { ...base, id: 'focus', metadata: { relatedNodeIds: ['ui'] } },
      { ...base, id: 'high', metadata: { ideaPriority: 'high' } },
      { ...base, id: 'pinned', metadata: { ideaPinned: true, ideaPriority: 'low' } },
    ];
    state.nodes = ideas; state.parkingLot = ideas.map(node => ({ nodeId: node.id, reason: '', parkedAt: node.createdAt }));
    const before = structuredClone(state);
    expect(sortedIdeas(state).map(node => node.id)).toEqual(['pinned', 'high', 'focus', 'recent']);
    expect(sortedIdeas(state, true)[0].id).toBe('recent');
    expect(state).toEqual(before);
  });
});
