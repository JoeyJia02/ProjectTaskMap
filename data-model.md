# Data model and integration contract

All IDs are stable opaque strings (UUID recommended). Dates are ISO-8601 UTC. Strings/arrays/body sizes are bounded by validation. Runtime schemas in `src/domain/schema.ts` are authoritative; API is JSON with camelCase fields. Source evidence preserves its original event timestamps. State/node `updatedAt`, `lastIncrementalUpdate`, and `lastFullReconcile` are monotonic event-time high-water marks: accepting a previously unknown historical task cannot lower stale-evidence protection. History/conflict/review audit timestamps and reconcile response `checkedAt` use server time. A no-change reconcile returns `checkedAt` and supplied `coverage` without writing state.

## Entities

- **SourceRef**: `{ id, kind: 'turn'|'file'|'manual'|'overview', label, timestamp, excerpt? }`. References are evidence descriptions, not authorization. No arbitrary source URL fetching.
- **TaskNode**: `{ id, title, summary, parentId: string|null, dependencies: string[], status, createdAt, updatedAt, sourceRefs: SourceRef[], manualOverride: boolean, metadata: { nextStep?, semanticKey?, [key]: unknown } }`.
- **Decision**: `{ id, title, rationale, createdAt, sourceRefs }`.
- **ParkingItem**: `{ nodeId, reason, parkedAt }`; maintained from parking transitions, not a separate competing node state.
- **ProjectBinding**: `{ projectId, ownerId, bindingKey, hostProjectId: string|null, name, createdAt, updatedAt }`; unique owner+bindingKey and optional owner+hostProjectId.
- **ProjectState**: `{ projectId, name, goal, activeNodeId: string|null, nodes, decisions, parkingLot, version, createdAt, updatedAt, lastIncrementalUpdate: string|null, lastFullReconcile: string|null, manualOverrides: { goal: boolean, focus: boolean } }`.
- **ProjectStateDelta**: `{ projectId, idempotencyKey, expectedVersion, timestamp, source: 'ai'|'manual'|'reconcile', confidence, evidence: SourceRef[], operations: Operation[] }`.
- **Conflict**: `{ id, projectId, kind, message, delta, createdAt, status: 'pending'|'approved'|'rejected' }`. Separate review log; does not mutate project state just by existing.

## Operations (discriminated by `type`)

| type | remaining fields |
|---|---|
| NO_OP | reason? |
| ADD_NODE | node: { id, title, summary?, parentId?, status?, dependencies?, metadata? } |
| UPDATE_NODE | nodeId, changes: { title?, summary?, metadata?, manualOverride? } |
| COMPLETE_NODE | nodeId |
| BLOCK_NODE | nodeId, reason |
| UNBLOCK_NODE | nodeId |
| MOVE_NODE | nodeId, parentId: string|null |
| PARK_NODE | nodeId, reason |
| DROP_NODE | nodeId, reason? |
| SET_ACTIVE_NODE | nodeId: string|null |
| ADD_DECISION | decision: { id, title, rationale? } |
| UPDATE_GOAL | goal |
| ADD_DEPENDENCY | nodeId, dependencyId |
| REMOVE_DEPENDENCY | nodeId, dependencyId |

Status: todo, active, blocked, done, parking, dropped. Activation is explicit SET_ACTIVE_NODE (parking/todo → active when prerequisites done); UNBLOCK_NODE returns blocked → todo. Open states can move to blocked, parking, done or dropped. Terminal states stay terminal under AI; explicit human SET_ACTIVE_NODE/UNBLOCK_NODE may reopen. Invalid transitions return conflicts. A focus change demotes the previous active node to todo, subject to its lock; null clears focus. All implicit edits receive the same lock checks as explicit edits.

## Detection and overview

`TurnAssessment = { projectId, turnId, expectedVersion, timestamp, meaningful: boolean, confidence, evidence, operations }`. For meaningful=false, operations must be empty/NO_OP; contradictions are invalid. Assessment normalization uses turnId for idempotency. Semantic interpretation is performed by ChatGPT following Skill policy; transport is not a chat scraper.

`ProjectOverview = { projectId, reconcileId, expectedVersion, timestamp, confidence, evidence, coverage: string, goal?, activeNodeId?, nodes: [{ id?, title, summary?, parentId?, status?, dependencies?, metadata? }], decisions?: [{ id?, title, rationale? }] }`.

`MutationResult = { outcome: 'applied'|'no_op'|'duplicate'|'pending', state: ProjectState, conflict?: Conflict }`. Auth/invalid schema/not found use HTTP errors; reviewable consistency issues use pending. Runtime store public interface:

```ts
new ProjectStore(databasePath)
bind(ownerId, { bindingKey, name, goal?, hostProjectId? }): { binding, state }
get(ownerId, projectId): ProjectState
apply(ownerId, delta): MutationResult
assess(ownerId, assessment): MutationResult
reconcile(ownerId, overview): MutationResult
history(ownerId, projectId): HistoryEntry[]
conflicts(ownerId, projectId): Conflict[]
review(ownerId, projectId, conflictId, action, expectedVersion): MutationResult
rollback(ownerId, projectId, targetVersion, expectedVersion): MutationResult
close(): void
```

## SQLite

Bindings table with composite uniqueness; projects table `(project_id, owner_id, version, state_json)`; history table `(project_id, version, state_json, reason, created_at)`; receipts `(project_id, idempotency_key, payload_hash, result_json)`; conflicts include `(id, project_id, fingerprint, status, data_json, request_key, payload_hash)` with unique project+fingerprint. Pending request keys also retain their payload identity. `rollback_guards` records IDs/semantic identities removed by an explicit rollback so later AI replay cannot revive them under a new delta key. Foreign keys enabled; atomic `BEGIN IMMEDIATE` transactions. Snapshot at version 0 allows initial rollback. Rejected proposals leave state/version unchanged. NO_OP need not store a receipt because replay is semantically inert.

## HTTP boundary

- `GET /health` — non-sensitive readiness.
- `POST /api/bind` — owner bearer only, create/load binding.
- `GET /api/projects/:id` — state.
- `POST /api/projects/:id/deltas` — AI/reconcile source enforced; widget autonomous writes cannot claim manual authority.
- `POST /api/projects/:id/manual` — human UI actions; server assigns manual source.
- `POST /api/projects/:id/turns` / `reconcile` — structured assessment/overview.
- `GET /api/projects/:id/history` / `conflicts` — scoped audit.
- `POST /api/projects/:id/reviews/:conflictId` — explicit human approve/reject with expectedVersion.
- `POST /api/projects/:id/rollback` — explicit human targetVersion + expectedVersion.
- `GET /api/projects/:id/artifact.md` / `artifact.html` — state projections, authenticated.
- `/mcp` — streamable HTTP, tools for bind/read/delta/turn/reconcile/export; UI staging result where needed.

Owner identity comes from authentication. Route project IDs must equal body IDs. A signed project token carries owner/project/expiry/scope and cannot bind another project. All write routes enforce JSON content type and origin policy. Raw secrets and capabilities must never enter `structuredContent`, logs or exported artifacts.
