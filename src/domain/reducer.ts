import { projectStateSchema, type ProjectState, type ProjectStateDelta, type SourceRef, type TaskNode, type TaskStatus } from './schema.js';

export class DomainConflict extends Error {
  constructor(public readonly kind: string, message: string) { super(message); this.name = 'DomainConflict'; }
}
export const normalizeTitle = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const latestTimestamp = (...values: (string | null)[]) => new Date(Math.max(...values.filter((value): value is string => value !== null).map(value => Date.parse(value)))).toISOString();
const terminal = (status: TaskStatus) => status === 'done' || status === 'dropped';
const mergeEvidence = (old: SourceRef[], evidence: SourceRef[]) => [...new Map([...old, ...evidence].map(ref => [ref.id, ref])).values()].slice(-100);

export function validateGraph(state: ProjectState): void {
  const nodes = new Map(state.nodes.map(node => [node.id, node]));
  if (nodes.size !== state.nodes.length) throw new DomainConflict('duplicate_id', 'Task IDs must be unique');
  for (const node of state.nodes) {
    const related = node.metadata.relatedNodeIds ?? [];
    if (new Set(related).size !== related.length) throw new DomainConflict('duplicate_relation', 'Related task IDs must be unique');
    for (const id of related) {
      if (id === node.id || !nodes.has(id)) throw new DomainConflict('invalid_relation', 'Related task must exist and cannot be the idea itself');
    }
    if (node.parentId && !nodes.has(node.parentId)) throw new DomainConflict('missing_endpoint', `Parent ${node.parentId} does not exist`);
    if (new Set(node.dependencies).size !== node.dependencies.length) throw new DomainConflict('duplicate_dependency', 'Dependency IDs must be unique');
    for (const dep of node.dependencies) if (!nodes.has(dep)) throw new DomainConflict('missing_endpoint', `Dependency ${dep} does not exist`);
  }
  const checkCycles = (links: (node: TaskNode) => string[], label: string) => {
    const seen = new Set<string>(); const visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new DomainConflict(`${label}_cycle`, `${label} graph contains a cycle`);
      if (seen.has(id)) return;
      visiting.add(id); for (const next of links(nodes.get(id)!)) visit(next);
      visiting.delete(id); seen.add(id);
    };
    for (const node of state.nodes) visit(node.id);
  };
  checkCycles(node => node.parentId ? [node.parentId] : [], 'hierarchy');
  checkCycles(node => node.dependencies, 'dependency');
  if (state.activeNodeId !== null && nodes.get(state.activeNodeId)?.status !== 'active') {
    throw new DomainConflict('invalid_focus', 'Current focus must reference an active task');
  }
  for (const node of state.nodes) if (node.status === 'active' || node.status === 'done') {
    if (node.dependencies.some(id => nodes.get(id)!.status !== 'done')) throw new DomainConflict('unresolved_dependency', `Task ${node.id} has unfinished prerequisites`);
  }
  const parked = state.nodes.filter(node => node.status === 'parking').map(node => node.id).sort();
  if (!same(parked, state.parkingLot.map(item => item.nodeId).sort())) throw new DomainConflict('invalid_parking', 'Parking index must match parked tasks');
}

/** Pure atomic reducer: callers commit only after every operation and graph check succeeds. */
export function reduceDelta(original: ProjectState, delta: ProjectStateDelta): { state: ProjectState; changed: boolean } {
  const state = structuredClone(original);
  const isHuman = delta.source === 'manual';
  const originalById = new Map(original.nodes.map(node => [node.id, node]));
  const touched = new Set<string>();
  let goalChanged = false; let focusChanged = false;
  const checkProjectEvidence = (field: string) => {
    const lastObservedChange = Math.max(Date.parse(original.lastIncrementalUpdate ?? '') || 0, Date.parse(original.lastFullReconcile ?? '') || 0);
    if (!isHuman && delta.evidence.length && Math.min(Date.parse(delta.timestamp), Math.max(...delta.evidence.map(ref => Date.parse(ref.timestamp)))) < lastObservedChange) {
      throw new DomainConflict('stale_evidence', `${field} proposal predates the last observed project change`);
    }
  };
  const get = (id: string) => {
    const node = state.nodes.find(item => item.id === id);
    if (!node) throw new DomainConflict('missing_endpoint', `Task ${id} does not exist`);
    return node;
  };
  const authorize = (node: TaskNode) => {
    if (!isHuman && node.manualOverride) throw new DomainConflict('manual_override', `Task ${node.id} is protected by a human edit`);
    const prior = originalById.get(node.id);
    if (!isHuman && prior && Date.parse(delta.timestamp) < Date.parse(prior.updatedAt)) {
      throw new DomainConflict('stale_evidence', `Proposal predates the last change to ${node.id}`);
    }
    if (!isHuman && prior && delta.evidence.length && Math.max(...delta.evidence.map(ref => Date.parse(ref.timestamp))) < Date.parse(prior.updatedAt)) {
      throw new DomainConflict('stale_evidence', `Evidence predates the last change to ${node.id}`);
    }
  };
  const touch = (node: TaskNode) => { authorize(node); touched.add(node.id); if (isHuman) node.manualOverride = true; };
  const changeFocus = (id: string | null) => {
    if (state.activeNodeId === id) return;
    if (!isHuman && state.manualOverrides.focus) throw new DomainConflict('manual_focus', 'Current focus is protected by a human edit');
    checkProjectEvidence('Focus');
    focusChanged = true;
    state.activeNodeId = id;
  };
  const transition = (node: TaskNode, status: TaskStatus, allowHumanReopen = false) => {
    if (node.status === status) return;
    if (terminal(node.status) && !(isHuman && allowHumanReopen)) throw new DomainConflict('terminal_state', `Task ${node.id} cannot leave ${node.status} without an explicit human reopening`);
    touch(node); node.status = status;
    if (status !== 'parking') state.parkingLot = state.parkingLot.filter(item => item.nodeId !== node.id);
    if (state.activeNodeId === node.id && status !== 'active') changeFocus(null);
  };
  for (const operation of delta.operations) {
    switch (operation.type) {
      case 'NO_OP': break;
      case 'ADD_NODE': {
        const input = operation.node;
        const existingId = state.nodes.find(node => node.id === input.id);
        const matches = state.nodes.filter(node => node.parentId === (input.parentId ?? null) && normalizeTitle(node.title) === normalizeTitle(input.title));
        const existing = existingId ?? (matches.length === 1 ? matches[0] : undefined);
        if (matches.length > 1) throw new DomainConflict('ambiguous_match', `Several tasks match ${input.title}`);
        if (existing) {
          const provided = { title: input.title, ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}), ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.dependencies !== undefined ? { dependencies: [...new Set(input.dependencies)].sort() } : {}), ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) };
          if (Object.entries(provided).every(([key, value]) => key === 'title' ? normalizeTitle(existing.title) === normalizeTitle(value as string) : same(key === 'dependencies' ? [...existing.dependencies].sort() : existing[key as keyof TaskNode], value))) break;
          throw new DomainConflict('duplicate_task', `Task ${input.title} already exists; update its stable ID explicitly`);
        }
        const node: TaskNode = { id: input.id, title: input.title, summary: input.summary ?? '', parentId: input.parentId ?? null,
          dependencies: [...new Set(input.dependencies ?? [])], status: input.status ?? 'todo', metadata: input.metadata ?? {},
          createdAt: delta.timestamp, updatedAt: delta.timestamp, sourceRefs: delta.evidence, manualOverride: isHuman };
        state.nodes.push(node); touched.add(node.id);
        if (node.status === 'parking') state.parkingLot.push({ nodeId: node.id, reason: 'Deferred idea', parkedAt: delta.timestamp });
        break;
      }
      case 'UPDATE_NODE': {
        const node = get(operation.nodeId); const changes = operation.changes;
        if (!isHuman && changes.manualOverride !== undefined) throw new DomainConflict('manual_override', 'Only a human can change a manual lock');
        const changed = Object.entries(changes).some(([key, value]) => !same(node[key as keyof TaskNode], key === 'metadata' ? { ...node.metadata, ...value as object } : value));
        if (!changed) break;
        touch(node);
        if (changes.title !== undefined) node.title = changes.title;
        if (changes.summary !== undefined) node.summary = changes.summary;
        if (changes.metadata !== undefined) node.metadata = { ...node.metadata, ...changes.metadata };
        if (changes.manualOverride !== undefined) node.manualOverride = changes.manualOverride;
        break;
      }
      case 'MOVE_NODE': { const node = get(operation.nodeId); if (node.parentId !== operation.parentId) { touch(node); node.parentId = operation.parentId; } break; }
      case 'COMPLETE_NODE': transition(get(operation.nodeId), 'done'); break;
      case 'DROP_NODE': {
        const node = get(operation.nodeId); transition(node, 'dropped');
        if (operation.reason !== undefined && node.metadata.dropReason !== operation.reason) { touch(node); node.metadata.dropReason = operation.reason; } break;
      }
      case 'BLOCK_NODE': {
        const node = get(operation.nodeId); transition(node, 'blocked');
        if (node.metadata.blockReason !== operation.reason) { touch(node); node.metadata.blockReason = operation.reason; } break;
      }
      case 'UNBLOCK_NODE': {
        const node = get(operation.nodeId);
        if (node.status === 'todo') break;
        if (!['blocked', 'active', 'parking'].includes(node.status) && !(isHuman && terminal(node.status))) throw new DomainConflict('invalid_transition', `Cannot unblock ${node.status}`);
        transition(node, 'todo', true); delete node.metadata.blockReason; break;
      }
      case 'PARK_NODE': {
        const node = get(operation.nodeId); transition(node, 'parking');
        const item = state.parkingLot.find(entry => entry.nodeId === node.id);
        if (!item || item.reason !== operation.reason) { touch(node); state.parkingLot = state.parkingLot.filter(entry => entry.nodeId !== node.id); state.parkingLot.push({ nodeId: node.id, reason: operation.reason, parkedAt: delta.timestamp }); }
        break;
      }
      case 'START_NODE': {
        const node = get(operation.nodeId);
        if (node.status === 'blocked') throw new DomainConflict('invalid_transition', 'Unblock the task before starting it');
        transition(node, 'active', isHuman); break;
      }
      case 'SET_ACTIVE_NODE': {
        if (operation.nodeId === state.activeNodeId) break;
        const next = operation.nodeId === null ? undefined : get(operation.nodeId);
        if (next?.status === 'blocked') throw new DomainConflict('invalid_transition', 'Unblock the task before activating it');
        if (next) { authorize(next); if (terminal(next.status) && !isHuman) throw new DomainConflict('terminal_state', 'Reopening requires a human decision'); }
        changeFocus(operation.nodeId);
        if (next) { touch(next); next.status = 'active'; state.parkingLot = state.parkingLot.filter(item => item.nodeId !== next.id); }
        break;
      }
      case 'ADD_DECISION': {
        const existing = state.decisions.find(item => item.id === operation.decision.id || normalizeTitle(item.title) === normalizeTitle(operation.decision.title));
        if (existing) {
          if (normalizeTitle(existing.title) !== normalizeTitle(operation.decision.title) || (operation.decision.rationale !== undefined && existing.rationale !== operation.decision.rationale)) throw new DomainConflict('decision_conflict', 'Existing decision differs; preserve the decision audit');
          break;
        }
        state.decisions.push({ ...operation.decision, rationale: operation.decision.rationale ?? '', createdAt: delta.timestamp, sourceRefs: delta.evidence }); break;
      }
      case 'UPDATE_GOAL': {
        if (state.goal === operation.goal) break;
        if (!isHuman && state.manualOverrides.goal) throw new DomainConflict('manual_goal', 'Goal is protected by a human edit');
        checkProjectEvidence('Goal');
        state.goal = operation.goal; goalChanged = true; break;
      }
      case 'ADD_DEPENDENCY': case 'REMOVE_DEPENDENCY': {
        const node = get(operation.nodeId); get(operation.dependencyId);
        const exists = node.dependencies.includes(operation.dependencyId);
        if (exists === (operation.type === 'ADD_DEPENDENCY')) break;
        touch(node); node.dependencies = operation.type === 'ADD_DEPENDENCY' ? [...node.dependencies, operation.dependencyId] : node.dependencies.filter(id => id !== operation.dependencyId); break;
      }
    }
  }
  // Distinct IDs with the same parent/title are ambiguous and must be reviewed.
  const keys = new Set<string>();
  for (const node of state.nodes) { const key = canonical([node.parentId, normalizeTitle(node.title)]); if (keys.has(key)) throw new DomainConflict('ambiguous_match', `Duplicate task title under the same parent: ${node.title}`); keys.add(key); }
  if (isHuman && goalChanged) state.manualOverrides.goal = true;
  if (isHuman && focusChanged) state.manualOverrides.focus = true;
  validateGraph(state);
  // Net-zero batches do not create timestamps, evidence, history or receipts.
  if (same(state, original)) return { state: original, changed: false };
  if (!isHuman && delta.evidence.length === 0) throw new DomainConflict('missing_evidence', 'AI changes require source evidence');
  if (!isHuman && delta.confidence < 0.8) throw new DomainConflict('low_confidence', 'Confidence below 0.8 requires human review');
  for (const node of state.nodes) if (touched.has(node.id)) { node.updatedAt = latestTimestamp(node.updatedAt, delta.timestamp); node.sourceRefs = mergeEvidence(node.sourceRefs, delta.evidence); }
  state.version = original.version + 1; state.updatedAt = latestTimestamp(original.updatedAt, delta.timestamp);
  if (delta.source === 'reconcile') state.lastFullReconcile = latestTimestamp(original.lastFullReconcile, delta.timestamp);
  else state.lastIncrementalUpdate = latestTimestamp(original.lastIncrementalUpdate, delta.timestamp);
  const validated = projectStateSchema.safeParse(state);
  if (!validated.success) throw new DomainConflict('state_limit', `Resulting state is invalid: ${validated.error.issues[0].message}`);
  return { state, changed: true };
}
