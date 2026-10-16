import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectStore } from '../src/store/index.js';
import { deltaSchema } from '../src/domain/schema.js';
import { ProjectStore as LegacyProjectStore } from './fixtures/store-fe168d0/src/store/index.js';
import { deltaSchema as legacyDeltaSchema } from './fixtures/store-fe168d0/src/domain/schema.js';

const commit = 'fe168d0cc1d5fe6108b6e7f9c678f59fb4ac8157';
const fixtureRoot = new URL('./fixtures/store-fe168d0/', import.meta.url);
const owner = 'synthetic-upgrade-owner';
const binding = { bindingKey: 'synthetic-version-compat', name: 'Synthetic version compatibility', goal: 'Preserve saved work', hostProjectId: 'synthetic-host-project' };
let directory: string;
let databasePath: string;
let active: { close(): void } | undefined;

// Both versions parse their own requests. This prevents accidentally passing a
// new-only operation to the old API through a TypeScript compatibility cast.
function proposal(projectId: string, expectedVersion: number, idempotencyKey: string, operations: unknown[]) {
  return { projectId, expectedVersion, idempotencyKey, operations,
    timestamp: '2026-10-01T00:00:00Z', source: 'manual', confidence: 1, evidence: [] };
}

function close() { active?.close(); active = undefined; }
function openLegacy() { close(); const store = new LegacyProjectStore(databasePath); active = store; return store; }
function openCurrent() { close(); const store = new ProjectStore(databasePath); active = store; return store; }

function snapshot() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      projects: db.prepare('SELECT * FROM projects ORDER BY project_id').all(),
      bindings: db.prepare('SELECT * FROM bindings ORDER BY project_id').all(),
      history: db.prepare('SELECT * FROM history ORDER BY project_id, version').all(),
      receipts: db.prepare('SELECT * FROM receipts ORDER BY project_id, idempotency_key').all(),
      rollbackGuards: db.prepare('SELECT * FROM rollback_guards ORDER BY project_id, entity_type, entity_id').all(),
      foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally { db.close(); }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'taskmap-version-compat-'));
  databasePath = join(directory, 'synthetic.sqlite');
});
afterEach(() => {
  close();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('taskmap-version-compat-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(target, { recursive: true, force: true });
});

describe('ProjectStore compatibility with the frozen fe168d0 implementation', () => {
  it('uses the verbatim historical implementation identified by the fixture manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8')) as {
      commit: string; files: { sourcePath: string; fixturePath: string; bytes: number; sha256: string }[];
    };
    expect(manifest.commit).toBe(commit);
    expect(manifest.files.map(file => file.sourcePath).sort()).toEqual([
      'src/domain/assessment.ts', 'src/domain/reconcile.ts', 'src/domain/reducer.ts', 'src/domain/schema.ts', 'src/store/index.ts',
    ]);
    for (const file of manifest.files) {
      expect(file.fixturePath).toBe(file.sourcePath);
      const content = readFileSync(new URL(file.fixturePath, fixtureRoot));
      expect(content.length).toBe(file.bytes);
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256);
    }
  });

  it('preserves bindings, revisions and receipts through old to current to old writes using compatible operations', () => {
    let legacy = openLegacy();
    const bound = legacy.bind(owner, binding);
    const projectId = bound.state.projectId;
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const seed = legacyDeltaSchema.parse(proposal(projectId, 0, 'legacy-seed', [
      { type: 'ADD_NODE', node: { id: 'baseline-task', title: 'Baseline task', summary: 'Saved by old code' } },
    ]));
    const initial = legacy.apply(owner, seed);
    expect(initial.outcome).toBe('applied');
    expect(initial.state.version).toBe(1);
    const legacyHistory = legacy.history(owner, projectId);
    const legacyData = snapshot();

    let current = openCurrent();
    expect(current.bind(owner, binding)).toEqual({ binding: bound.binding, state: initial.state });
    expect(current.history(owner, projectId)).toEqual(legacyHistory);
    expect(snapshot()).toEqual(legacyData);
    expect(current.apply(owner, deltaSchema.parse(seed)).outcome).toBe('duplicate');
    expect(snapshot()).toEqual(legacyData);
    const ideaMetadata = { relatedNodeIds: ['baseline-task'], ideaPriority: 'high', ideaPinned: true, nextStep: 'Review the captured idea' };
    const addition = deltaSchema.parse(proposal(projectId, 1, 'current-addition', [
      { type: 'UPDATE_NODE', nodeId: 'baseline-task', changes: { metadata: { newCompatibleField: { revision: 2, labels: ['preserve'] } } } },
      { type: 'ADD_NODE', node: { id: 'new-idea', title: 'Idea added by current code', status: 'parking', metadata: ideaMetadata } },
    ]));
    const upgraded = current.apply(owner, addition);
    expect(upgraded.outcome).toBe('applied');
    expect(upgraded.state.version).toBe(2);
    const upgradedHistory = current.history(owner, projectId);
    const upgradedData = snapshot();
    for (const row of legacyData.history) expect(upgradedData.history).toContainEqual(row);
    for (const row of legacyData.receipts) expect(upgradedData.receipts).toContainEqual(row);

    legacy = openLegacy();
    expect(legacy.bind(owner, binding)).toEqual({ binding: bound.binding, state: upgraded.state });
    expect(legacy.history(owner, projectId)).toEqual(upgradedHistory);
    expect(snapshot()).toEqual(upgradedData);
    expect(legacy.get(owner, projectId).nodes.find(node => node.id === 'new-idea')?.metadata).toEqual(ideaMetadata);
    expect(legacy.apply(owner, legacyDeltaSchema.parse(addition)).outcome).toBe('duplicate');
    expect(snapshot()).toEqual(upgradedData);
    const oldEdit = legacyDeltaSchema.parse(proposal(projectId, 2, 'legacy-after-upgrade', [
      { type: 'UPDATE_NODE', nodeId: 'new-idea', changes: { summary: 'Edited after returning to old code' } },
      { type: 'ADD_NODE', node: { id: 'old-after-upgrade', title: 'Task added after returning to old code' } },
    ]));
    const reverted = legacy.apply(owner, oldEdit);
    expect(reverted.outcome).toBe('applied');
    expect(reverted.state.version).toBe(3);
    expect(reverted.state.nodes.find(node => node.id === 'new-idea')?.metadata).toEqual(ideaMetadata);
    expect(reverted.state.nodes.find(node => node.id === 'baseline-task')?.metadata.newCompatibleField).toEqual({ revision: 2, labels: ['preserve'] });
    const revertedHistory = legacy.history(owner, projectId);
    const revertedData = snapshot();
    expect(revertedData.receipts).toHaveLength(3);
    expect(revertedData.foreignKeyErrors).toEqual([]);

    current = openCurrent();
    expect(current.bind(owner, binding)).toEqual({ binding: bound.binding, state: reverted.state });
    expect(current.history(owner, projectId)).toEqual(revertedHistory);
    expect(revertedHistory.map(entry => entry.version)).toEqual([3, 2, 1, 0]);
    for (const request of [seed, addition, oldEdit]) {
      const replay = current.apply(owner, deltaSchema.parse(request));
      expect(replay.outcome).toBe('duplicate');
      expect(replay.state).toEqual(reverted.state);
    }
    expect(snapshot()).toEqual(revertedData);
  });

  it('refuses an old-version mutation of a new multiple-active state without changing its state, history or receipts', () => {
    let legacy = openLegacy();
    const projectId = legacy.bind(owner, binding).state.projectId;
    const seed = legacyDeltaSchema.parse(proposal(projectId, 0, 'legacy-focused-seed', [
      { type: 'ADD_NODE', node: { id: 'first', title: 'First task' } },
      { type: 'ADD_NODE', node: { id: 'second', title: 'Second task' } },
      { type: 'SET_ACTIVE_NODE', nodeId: 'first' },
    ]));
    expect(legacy.apply(owner, seed).outcome).toBe('applied');
    let current = openCurrent();
    const start = deltaSchema.parse(proposal(projectId, 1, 'current-parallel-start', [{ type: 'START_NODE', nodeId: 'second' }]));
    const parallel = current.apply(owner, start);
    expect(parallel.outcome).toBe('applied');
    expect(parallel.state.version).toBe(2);
    expect(parallel.state.activeNodeId).toBe('first');
    expect(parallel.state.nodes.filter(node => node.status === 'active').map(node => node.id)).toEqual(['first', 'second']);
    const history = current.history(owner, projectId);
    const saved = snapshot();

    legacy = openLegacy();
    expect(legacy.get(owner, projectId)).toEqual(parallel.state);
    expect(legacyDeltaSchema.safeParse(start).success).toBe(false);
    const oldMutation = legacyDeltaSchema.parse(proposal(projectId, 2, 'legacy-unsupported-parallel-edit', [
      { type: 'UPDATE_GOAL', goal: 'This rejected goal must not be persisted' },
      { type: 'UPDATE_NODE', nodeId: 'second', changes: { summary: 'This rejected summary must not be persisted' } },
    ]));
    const refused = legacy.apply(owner, oldMutation);
    expect(refused.outcome).toBe('pending');
    expect(refused.conflict?.kind).toBe('invalid_focus');
    expect(refused.state).toEqual(parallel.state);
    expect(legacy.get(owner, projectId)).toEqual(parallel.state);
    expect(legacy.history(owner, projectId)).toEqual(history);
    expect(snapshot()).toEqual(saved);
    // A rejected proposal is retained for review; it is not a project revision.
    expect(legacy.conflicts(owner, projectId)).toHaveLength(1);
    expect(legacy.apply(owner, oldMutation).conflict?.id).toBe(refused.conflict?.id);
    expect(legacy.conflicts(owner, projectId)).toHaveLength(1);
    expect(snapshot()).toEqual(saved);

    current = openCurrent();
    expect(current.get(owner, projectId)).toEqual(parallel.state);
    expect(current.history(owner, projectId)).toEqual(history);
    expect(snapshot()).toEqual(saved);
    const resumed = current.apply(owner, deltaSchema.parse(proposal(projectId, 2, 'current-after-refused-downgrade', [
      { type: 'UPDATE_NODE', nodeId: 'second', changes: { summary: 'Current code can continue without losing parallel work' } },
    ])));
    expect(resumed.outcome).toBe('applied');
    expect(resumed.state.version).toBe(3);
    expect(resumed.state.nodes.filter(node => node.status === 'active').map(node => node.id)).toEqual(['first', 'second']);
    expect(current.history(owner, projectId)).toHaveLength(4);
  });
});
