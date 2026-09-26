import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assessmentSchema, bindSchema, deltaSchema, idSchema, overviewSchema,
  type BindInput, type Conflict, type HistoryEntry, type MutationResult, type ProjectBinding,
  type ProjectOverview, type ProjectState, type ProjectStateDelta, type TurnAssessment,
} from '../domain/schema.js';
import { canonical, DomainConflict, normalizeTitle, reduceDelta, validateGraph } from '../domain/reducer.js';
import { assessmentToDelta } from '../domain/assessment.js';
import { overviewDeltaBase, planReconcile } from '../domain/reconcile.js';

export class StoreError extends Error {
  readonly statusCode: number;
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'StoreError'; this.statusCode = status; }
}
type Row = Record<string, string | number | null>;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const now = () => new Date().toISOString();
const maxTime = (first: string | null, second: string | null): string | null => first === null ? second : second === null ? first : new Date(Math.max(Date.parse(first), Date.parse(second))).toISOString();

export class ProjectStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (project_id TEXT PRIMARY KEY REFERENCES projects(project_id), owner_id TEXT NOT NULL, binding_key TEXT NOT NULL,
        host_project_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner_id, binding_key), UNIQUE(owner_id, host_project_id));
      CREATE TABLE IF NOT EXISTS history (project_id TEXT NOT NULL REFERENCES projects(project_id), version INTEGER NOT NULL, state_json TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, version));
      CREATE TABLE IF NOT EXISTS receipts (project_id TEXT NOT NULL REFERENCES projects(project_id), idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id), fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, data_json TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(project_id, fingerprint));
      CREATE TABLE IF NOT EXISTS rollback_guards (project_id TEXT NOT NULL REFERENCES projects(project_id), entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, semantic_key TEXT NOT NULL, PRIMARY KEY(project_id, entity_type, entity_id));`);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private read(ownerId: string, projectId: string): ProjectState {
    const row = this.db.prepare('SELECT state_json FROM projects WHERE project_id = ? AND owner_id = ?').get(projectId, ownerId) as Row | undefined;
    if (!row) throw new StoreError(404, 'not_found', 'Project not found');
    return JSON.parse(row.state_json as string) as ProjectState;
  }
  private binding(row: Row): ProjectBinding {
    return { projectId: row.project_id as string, ownerId: row.owner_id as string, bindingKey: row.binding_key as string,
      hostProjectId: row.host_project_id as string | null, name: row.name as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }
  bind(ownerId: string, input: BindInput): { binding: ProjectBinding; state: ProjectState } {
    idSchema.parse(ownerId); const request = bindSchema.parse(input);
    return this.transaction(() => {
      const byKey = this.db.prepare('SELECT * FROM bindings WHERE owner_id = ? AND binding_key = ?').get(ownerId, request.bindingKey) as Row | undefined;
      const byHost = request.hostProjectId ? this.db.prepare('SELECT * FROM bindings WHERE owner_id = ? AND host_project_id = ?').get(ownerId, request.hostProjectId) as Row | undefined : undefined;
      if (byKey && byHost && byKey.project_id !== byHost.project_id) throw new StoreError(409, 'binding_conflict', 'Binding key and host ID address different projects');
      const row = byKey ?? byHost;
      if (row) {
        if (request.hostProjectId && row.host_project_id && request.hostProjectId !== row.host_project_id) throw new StoreError(409, 'binding_conflict', 'Binding already has another host ID');
        const binding = this.binding(row); const state = this.read(ownerId, binding.projectId); const timestamp = now();
        if (binding.name !== request.name) {
          state.name = request.name; state.updatedAt = maxTime(state.updatedAt, timestamp)!; state.version += 1;
          this.commitState(state, 'rename'); binding.name = request.name; binding.updatedAt = timestamp;
        }
        if (!binding.hostProjectId && request.hostProjectId) { binding.hostProjectId = request.hostProjectId; binding.updatedAt = timestamp; }
        this.db.prepare('UPDATE bindings SET name = ?, host_project_id = ?, updated_at = ? WHERE project_id = ?').run(binding.name, binding.hostProjectId, binding.updatedAt, binding.projectId);
        return { binding, state };
      }
      const timestamp = now(); const projectId = randomUUID();
      const state: ProjectState = { projectId, name: request.name, goal: request.goal ?? '', activeNodeId: null, nodes: [], decisions: [], parkingLot: [],
        version: 0, createdAt: timestamp, updatedAt: timestamp, lastIncrementalUpdate: null, lastFullReconcile: null, manualOverrides: { goal: false, focus: false } };
      const binding: ProjectBinding = { projectId, ownerId, bindingKey: request.bindingKey, hostProjectId: request.hostProjectId ?? null, name: request.name, createdAt: timestamp, updatedAt: timestamp };
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run(projectId, ownerId, 0, JSON.stringify(state));
      this.db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?, ?)').run(projectId, ownerId, binding.bindingKey, binding.hostProjectId, binding.name, timestamp, timestamp);
      this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?)').run(projectId, 0, JSON.stringify(state), 'initialize', timestamp);
      return { binding, state };
    });
  }
  get(ownerId: string, projectId: string): ProjectState { return this.read(ownerId, projectId); }
  private commitState(state: ProjectState, reason: string): void {
    this.db.prepare('UPDATE projects SET version = ?, state_json = ? WHERE project_id = ?').run(state.version, JSON.stringify(state), state.projectId);
    this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?)').run(state.projectId, state.version, JSON.stringify(state), reason, now());
  }
  private pending(state: ProjectState, delta: ProjectStateDelta, kind: string, message: string, payloadHash: string): MutationResult {
    const fingerprint = hash([payloadHash, kind, message]);
    const existing = this.db.prepare('SELECT data_json FROM conflicts WHERE project_id = ? AND fingerprint = ?').get(state.projectId, fingerprint) as Row | undefined;
    const conflict: Conflict = existing ? JSON.parse(existing.data_json as string) : {
      id: randomUUID(), projectId: state.projectId, kind, message, delta, createdAt: now(), status: 'pending',
    };
    if (!existing) this.db.prepare('INSERT INTO conflicts VALUES (?, ?, ?, ?, ?, ?, ?)').run(conflict.id, conflict.projectId, fingerprint, conflict.status, JSON.stringify(conflict), delta.idempotencyKey, payloadHash);
    return { outcome: 'pending', state, conflict };
  }
  private replay(state: ProjectState, delta: ProjectStateDelta, payloadHash: string): MutationResult | undefined {
    const row = this.db.prepare('SELECT payload_hash FROM receipts WHERE project_id = ? AND idempotency_key = ?').get(state.projectId, delta.idempotencyKey) as Row | undefined;
    if (!row) {
      const prior = this.db.prepare('SELECT payload_hash FROM conflicts WHERE project_id = ? AND request_key = ? ORDER BY rowid LIMIT 1').get(state.projectId, delta.idempotencyKey) as Row | undefined;
      if (prior && prior.payload_hash !== payloadHash) return this.pending(state, delta, 'idempotency_conflict', 'Idempotency key was already used with a different payload', payloadHash);
      return undefined;
    }
    return row.payload_hash === payloadHash ? { outcome: 'duplicate', state } : this.pending(state, delta, 'idempotency_conflict', 'Idempotency key was already used with a different payload', payloadHash);
  }
  private applyInside(state: ProjectState, delta: ProjectStateDelta, payloadHash: string): MutationResult {
    const replay = this.replay(state, delta, payloadHash); if (replay) return replay;
    // Explicit empty/NO_OP reports are inert even after a concurrent state change.
    if (delta.operations.every(op => op.type === 'NO_OP')) return { outcome: 'no_op', state };
    if (delta.expectedVersion !== state.version) return this.pending(state, delta, 'stale_version', `Expected version ${delta.expectedVersion}; current version is ${state.version}`, payloadHash);
    try {
      if (delta.source !== 'manual') {
        for (const operation of delta.operations) {
          if (operation.type !== 'ADD_NODE' && operation.type !== 'ADD_DECISION') continue;
          const isNode = operation.type === 'ADD_NODE';
          const entity = isNode ? operation.node : operation.decision;
          const semanticKey = isNode ? canonical([operation.node.parentId ?? null, normalizeTitle(entity.title)]) : normalizeTitle(entity.title);
          const exists = isNode
            ? state.nodes.some(node => node.id === entity.id || canonical([node.parentId, normalizeTitle(node.title)]) === semanticKey)
            : state.decisions.some(decision => decision.id === entity.id || normalizeTitle(decision.title) === semanticKey);
          if (exists) continue;
          const guarded = this.db.prepare('SELECT entity_id FROM rollback_guards WHERE project_id = ? AND entity_type = ? AND (entity_id = ? OR semantic_key = ?) LIMIT 1')
            .get(state.projectId, isNode ? 'node' : 'decision', entity.id, semanticKey);
          if (guarded) throw new DomainConflict('rollback_guard', 'This item was removed by a human rollback; restoring it requires review');
        }
      }
      const reduced = reduceDelta(state, delta);
      if (!reduced.changed) return { outcome: 'no_op', state };
      const result: MutationResult = { outcome: 'applied', state: reduced.state };
      this.commitState(reduced.state, delta.source === 'reconcile' ? 'reconcile' : delta.source === 'manual' ? 'manual edit' : 'incremental update');
      this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)').run(state.projectId, delta.idempotencyKey, payloadHash, JSON.stringify(result));
      return result;
    } catch (error) {
      if (error instanceof DomainConflict) return this.pending(state, delta, error.kind, error.message, payloadHash);
      throw error;
    }
  }
  apply(ownerId: string, input: ProjectStateDelta): MutationResult {
    const delta = deltaSchema.parse(input);
    return this.transaction(() => this.applyInside(this.read(ownerId, delta.projectId), delta, hash(delta)));
  }
  assess(ownerId: string, input: TurnAssessment): MutationResult {
    const assessment = assessmentSchema.parse(input); const delta = assessmentToDelta(assessment);
    return this.transaction(() => this.applyInside(this.read(ownerId, delta.projectId), delta, hash(assessment)));
  }
  reconcile(ownerId: string, input: ProjectOverview): MutationResult {
    const overview = overviewSchema.parse(input); const base = overviewDeltaBase(overview); const payloadHash = hash(overview);
    const result = this.transaction(() => {
      const state = this.read(ownerId, overview.projectId); const replay = this.replay(state, base, payloadHash); if (replay) return replay;
      if (overview.expectedVersion !== state.version) return this.pending(state, base, 'stale_version', `Expected version ${overview.expectedVersion}; current version is ${state.version}. Refresh and reconcile again.`, payloadHash);
      try { return this.applyInside(state, planReconcile(state, overview), payloadHash); }
      catch (error) { if (error instanceof DomainConflict) return this.pending(state, base, error.kind, error.message, payloadHash); throw error; }
    });
    return { ...result, checkedAt: now(), coverage: overview.coverage };
  }
  history(ownerId: string, projectId: string): HistoryEntry[] {
    this.read(ownerId, projectId);
    return (this.db.prepare('SELECT * FROM history WHERE project_id = ? ORDER BY version DESC').all(projectId) as Row[]).map(row => ({
      projectId, version: row.version as number, state: JSON.parse(row.state_json as string), reason: row.reason as string, createdAt: row.created_at as string,
    }));
  }
  conflicts(ownerId: string, projectId: string): Conflict[] {
    this.read(ownerId, projectId);
    return (this.db.prepare('SELECT data_json FROM conflicts WHERE project_id = ? ORDER BY rowid DESC').all(projectId) as Row[]).map(row => JSON.parse(row.data_json as string));
  }
  review(ownerId: string, projectId: string, conflictId: string, action: 'approve' | 'reject', expectedVersion: number): MutationResult {
    if (!['approve', 'reject'].includes(action) || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw new StoreError(400, 'invalid_review', 'Invalid review request');
    return this.transaction(() => {
      const state = this.read(ownerId, projectId);
      const row = this.db.prepare('SELECT data_json FROM conflicts WHERE id = ? AND project_id = ?').get(conflictId, projectId) as Row | undefined;
      if (!row) throw new StoreError(404, 'not_found', 'Review record not found');
      const conflict: Conflict = JSON.parse(row.data_json as string);
      if (conflict.status !== 'pending') return { outcome: 'duplicate', state, conflict };
      if (expectedVersion !== state.version) throw new StoreError(409, 'stale_version', 'Reload the current version before reviewing');
      let result: MutationResult = { outcome: 'no_op', state };
      if (action === 'approve') {
        if (!conflict.delta.operations.some(op => op.type !== 'NO_OP')) throw new StoreError(409, 'resolution_required', 'This ambiguous or stale overview needs corrected IDs and a fresh proposal before approval');
        const timestamp = now();
        const approved: ProjectStateDelta = { ...conflict.delta, source: 'manual', confidence: 1, timestamp, expectedVersion,
          idempotencyKey: `review:${conflict.id}`, evidence: [...conflict.delta.evidence.slice(-99), { id: `review:${conflict.id}`, kind: 'manual', label: 'Human approved proposal', timestamp }] };
        result = this.applyInside(state, approved, hash(approved));
        if (result.outcome === 'pending') return result;
      }
      conflict.status = action === 'approve' ? 'approved' : 'rejected'; conflict.reviewedAt = now(); conflict.reviewVersion = result.state.version; conflict.reviewAction = action;
      this.db.prepare('UPDATE conflicts SET status = ?, data_json = ? WHERE id = ?').run(conflict.status, JSON.stringify(conflict), conflict.id);
      return { ...result, conflict };
    });
  }
  rollback(ownerId: string, projectId: string, targetVersion: number, expectedVersion: number): MutationResult {
    if (![targetVersion, expectedVersion].every(value => Number.isInteger(value) && value >= 0)) throw new StoreError(400, 'invalid_version', 'Versions must be nonnegative integers');
    return this.transaction(() => {
      const current = this.read(ownerId, projectId);
      if (expectedVersion !== current.version) throw new StoreError(409, 'stale_version', 'Reload the current version before rollback');
      const row = this.db.prepare('SELECT state_json FROM history WHERE project_id = ? AND version = ?').get(projectId, targetVersion) as Row | undefined;
      if (!row) throw new StoreError(404, 'not_found', 'Snapshot not found');
      if (targetVersion === current.version) return { outcome: 'no_op', state: current };
      const restored: ProjectState = JSON.parse(row.state_json as string); const timestamp = now();
      restored.version = current.version + 1; restored.updatedAt = maxTime(current.updatedAt, timestamp)!;
      restored.lastIncrementalUpdate = maxTime(current.lastIncrementalUpdate, restored.lastIncrementalUpdate);
      restored.lastFullReconcile = maxTime(current.lastFullReconcile, restored.lastFullReconcile);
      restored.manualOverrides = { goal: true, focus: true };
      for (const node of restored.nodes) { node.manualOverride = true; node.updatedAt = maxTime(maxTime(node.updatedAt, current.nodes.find(item => item.id === node.id)?.updatedAt ?? null), timestamp)!; }
      // Remember removed IDs/semantic keys so fresh AI keys cannot resurrect discarded work.
      const guard = this.db.prepare('INSERT OR IGNORE INTO rollback_guards VALUES (?, ?, ?, ?)');
      for (const node of current.nodes) if (!restored.nodes.some(item => item.id === node.id)) guard.run(projectId, 'node', node.id, canonical([node.parentId, normalizeTitle(node.title)]));
      for (const decision of current.decisions) if (!restored.decisions.some(item => item.id === decision.id)) guard.run(projectId, 'decision', decision.id, normalizeTitle(decision.title));
      validateGraph(restored); this.commitState(restored, `rollback to version ${targetVersion}`);
      this.db.prepare('UPDATE bindings SET name = ?, updated_at = ? WHERE project_id = ?').run(restored.name, timestamp, projectId);
      return { outcome: 'applied', state: restored };
    });
  }
  close(): void { this.db.close(); }
}
