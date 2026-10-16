import { createHash } from 'node:crypto';
import { canonical, DomainConflict, normalizeTitle } from './reducer.js';
import type { Operation, ProjectOverview, ProjectState, ProjectStateDelta, TaskNode } from './schema.js';

const stableId = (kind: string, projectId: string, key: unknown) => `${kind}-${createHash('sha256').update(canonical([projectId, key])).digest('hex').slice(0, 28)}`;
export function overviewDeltaBase(overview: ProjectOverview): ProjectStateDelta {
  return { projectId: overview.projectId, idempotencyKey: `reconcile:${overview.reconcileId}`, expectedVersion: overview.expectedVersion,
    timestamp: overview.timestamp, source: 'reconcile', confidence: overview.confidence, evidence: overview.evidence, operations: [] };
}

/** Merge observations, never infer deletion or completion from omission. */
export function planReconcile(state: ProjectState, overview: ProjectOverview): ProjectStateDelta {
  const delta = overviewDeltaBase(overview);
  const operations: Operation[] = delta.operations;
  const aliases = new Map<string, string>();
  const resolved = new Map<number, { id: string; existing?: TaskNode }>();
  const resolving = new Set<number>();
  const observationIndexes = new Map<string, number>();
  for (const [index, observation] of overview.nodes.entries()) {
    if (observation.id) {
      if (observationIndexes.has(observation.id)) throw new DomainConflict('ambiguous_observation', `Overview repeats ID ${observation.id}`);
      observationIndexes.set(observation.id, index);
    }
  }
  const seen = new Set<string>();
  const resolveObservation = (index: number): { id: string; existing?: TaskNode } => {
    const previous = resolved.get(index); if (previous) return previous;
    if (resolving.has(index)) throw new DomainConflict('hierarchy_cycle', 'Overview parent relationships contain a cycle');
    resolving.add(index);
    const observation = overview.nodes[index];
    const parentIndex = observation.parentId ? observationIndexes.get(observation.parentId) : undefined;
    const parentId = parentIndex === undefined ? observation.parentId : resolveObservation(parentIndex).id;
    let existing = observation.id ? state.nodes.find(node => node.id === observation.id) : undefined;
    if (!existing) {
      const matches = state.nodes.filter(node => normalizeTitle(node.title) === normalizeTitle(observation.title)
        && (parentId === undefined || node.parentId === parentId));
      if (matches.length > 1) throw new DomainConflict('ambiguous_match', `Overview title matches several tasks: ${observation.title}; supply an ID`);
      existing = matches[0];
    }
    const id = existing?.id ?? observation.id ?? stableId('task', state.projectId, [parentId ?? null, normalizeTitle(observation.title)]);
    if (seen.has(id)) throw new DomainConflict('ambiguous_observation', `Overview describes ${observation.title} more than once`);
    seen.add(id); resolved.set(index, { id, existing }); resolving.delete(index);
    if (observation.id) aliases.set(observation.id, id);
    return { id, existing };
  };
  for (const index of overview.nodes.keys()) resolveObservation(index);
  const mapId = (id: string) => aliases.get(id) ?? id;
  const focusCandidates: string[] = [];
  for (const [index, observation] of overview.nodes.entries()) {
    const { id, existing } = resolved.get(index)!;
    const parentId = observation.parentId === undefined ? undefined : observation.parentId === null ? null : mapId(observation.parentId);
    const dependencies = observation.dependencies?.map(mapId);
    if (!existing) {
      operations.push({ type: 'ADD_NODE', node: { ...observation, id, parentId, dependencies,
        status: observation.status } });
    } else {
      const changes: Extract<Operation, { type: 'UPDATE_NODE' }>['changes'] = {};
      if (observation.title !== existing.title) changes.title = observation.title;
      if (observation.summary !== undefined && observation.summary !== existing.summary) changes.summary = observation.summary;
      if (observation.metadata !== undefined && canonical({ ...existing.metadata, ...observation.metadata }) !== canonical(existing.metadata)) changes.metadata = observation.metadata;
      if (Object.keys(changes).length) operations.push({ type: 'UPDATE_NODE', nodeId: id, changes });
      if (parentId !== undefined && parentId !== existing.parentId) operations.push({ type: 'MOVE_NODE', nodeId: id, parentId });
      if (dependencies) {
        for (const dependencyId of existing.dependencies) if (!dependencies.includes(dependencyId)) operations.push({ type: 'REMOVE_DEPENDENCY', nodeId: id, dependencyId });
        for (const dependencyId of dependencies) if (!existing.dependencies.includes(dependencyId)) operations.push({ type: 'ADD_DEPENDENCY', nodeId: id, dependencyId });
      }
      if (observation.status && observation.status !== existing.status) {
        switch (observation.status) {
          case 'done': operations.push({ type: 'COMPLETE_NODE', nodeId: id }); break;
          case 'dropped': operations.push({ type: 'DROP_NODE', nodeId: id, reason: 'Explicit overview outcome' }); break;
          case 'parking': operations.push({ type: 'PARK_NODE', nodeId: id, reason: 'Deferred in supplied overview' }); break;
          case 'blocked': operations.push({ type: 'BLOCK_NODE', nodeId: id, reason: typeof observation.metadata?.blockReason === 'string' ? observation.metadata.blockReason : 'Blocked in supplied overview' }); break;
          case 'todo': operations.push({ type: 'UNBLOCK_NODE', nodeId: id }); break;
          case 'active': operations.push({ type: 'START_NODE', nodeId: id }); break;
        }
      }
    }
    if (observation.status === 'active') focusCandidates.push(id);
  }
  const explicitFocus = overview.activeNodeId === undefined ? undefined : overview.activeNodeId === null ? null : mapId(overview.activeNodeId);
  const focus = explicitFocus === undefined ? (state.activeNodeId === null && focusCandidates.length === 1 ? focusCandidates[0] : undefined) : explicitFocus;
  if (explicitFocus) {
    const observed = overview.nodes.find((_, index) => resolved.get(index)?.id === explicitFocus);
    if (observed?.status && observed.status !== 'active') throw new DomainConflict('invalid_focus', 'Overview focus contradicts the task status');
  }
  if (focus !== undefined && focus !== state.activeNodeId) operations.push({ type: 'SET_ACTIVE_NODE', nodeId: focus });
  if (overview.goal !== undefined && overview.goal !== state.goal) operations.push({ type: 'UPDATE_GOAL', goal: overview.goal });
  for (const decision of overview.decisions ?? []) operations.push({ type: 'ADD_DECISION', decision: {
    ...decision, id: decision.id ?? stableId('decision', state.projectId, normalizeTitle(decision.title)),
  } });
  // Endpoints added in the same atomic overview must exist before edits reference them.
  delta.operations = [...operations.filter(op => op.type === 'ADD_NODE'), ...operations.filter(op => op.type !== 'ADD_NODE')];
  return delta;
}
