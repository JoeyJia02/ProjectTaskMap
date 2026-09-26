# Architecture — Project Task Map

Design baseline: 2026-09-26. Node.js 24 + TypeScript; Express HTTP/MCP adapter; official MCP TypeScript SDK; React component bundled into a self-contained MCP Apps HTML resource; SQLite via `node:sqlite`. No paid model API is needed: ChatGPT performs semantic interpretation. The backend validates explicit structured assessments, never pretends a keyword regex can understand arbitrary conversations.

## Components and repository

```text
ProjectTaskMap/
  requirements.md              product contract
  architecture.md             boundaries and consistency strategy
  data-model.md               schema and API contract
  README.md
  CURRENT_LIMITATIONS.md
  DECISIONS.md
  docs/                       setup, connection, reviews, prototype
  src/domain/                 Zod schemas, graph reducer, assessment/reconcile
  src/store/                  SQLite store, bindings, history, review records
  src/server/                 HTTP, auth, MCP tools and resources
  src/artifacts/              pure Markdown/HTML exporters
  src/ui/                     React tree, cards, host adapter, backend client
  skills/task-manager/        policy, not a datastore
  tests/                      domain, store, HTTP/MCP, UI and acceptance scenarios
  scripts/                    build, bootstrap, artifact export
  examples/                   labelled sample project and turn fixtures
  .github/workflows/          continuous verification
  data/                       ignored persistent database
  dist/                       ignored generated build
```

Dependencies point inward: presentation / host adapter → application store → pure domain. Artifacts are projections of committed state. Future workspace-tab adapters consume the same state/export interfaces, without changing graph storage.

## Binding and authentication

No verified host Project identifier is currently available. First setup creates a random binding key which the user places in Project instructions; it is a **locator, not a credential**. Server uniqueness is `(ownerId, bindingKey)` and optional `(ownerId, hostProjectId)`. Names are mutable labels. Repeating initialization with the same key returns the same UUID. Cross-device continuity requires the same authenticated owner, key, and deployed database. Without the original key or a host ID, recognizing identical ChatGPT Projects is impossible; the UI must ask for/reuse a key rather than infer identity from a title.

The personal deployment uses an operator-configured strong owner secret. HTTP APIs accept a bearer owner credential or a signed short-lived project capability; credentials are never query parameters, source-controlled, or model-visible. MCP uses OAuth authorization-code + PKCE for the single owner; consent requires the owner secret. Authenticated MCP results may provide a short-lived project token to the iframe exclusively in `_meta`. The token is restricted to that project. Direct UI login is a local/operator fallback. Production uses HTTPS, explicit origin allowlists, restrictive iframe CSP, bounded JSON bodies, and no wildcard credential CORS. Local development binds loopback by default. SQLite stores snapshots/evidence, not OAuth bearer tokens. Only OAuth discovery is public; all MCP requests, including initialization/tool discovery, require OAuth.

## State and delta lifecycle

`Host-supplied assessment → schema validation → authorized project lookup → idempotency check → version check → policy/graph validation → atomic SQLite transaction → history + snapshot + receipt → UI/export`.

Each request includes expectedVersion; no blind last-write-wins. An identical accepted key returns its receipt even when the project has advanced. Different content with the same key is rejected. Apply operations to a clone, then validate the whole graph before committing. All operations succeed or none do. Evidence is required for AI changes; confidence below 0.8 creates a pending review. Review records are separate from project revisions. NO_OP or semantically unchanged updates do not bump versions, timestamps or project history. Rejected changes persist a deduplicated conflict record with proposed delta and explanation; accepted receipts persist atomically. Server source identity is derived from the authenticated route, not blindly trusted from client fields.

State event timestamps are monotonic high-water marks while source references retain original event times; late additions cannot regress the temporal guard and enable an older goal to overwrite a newer one. Audit records and reconcile `checkedAt` use server time.

Parent-child links form a forest; dependency links form a DAG independently. Dependencies point from a task to its prerequisite. Status activation/completion is prohibited until required prerequisites are done; dropped prerequisites remain unresolved until removed explicitly. A single active focus is maintained. Moving/parking/completing/dropping focus clears it where appropriate. Parent completion is not inferred from child count, and dependency completion does not silently activate downstream nodes.

Manual edits lock changed node fields conservatively at node level; goal and focus have project-level locks. Human edits may reopen terminal nodes explicitly; AI terminal → open transitions are conflicts. AI cannot sidestep a lock through MOVE, dependency edits, SET_ACTIVE or a replacement ADD. Reviewed approval runs the proposal as a human decision against the latest expected version. Approval/rejection leaves an audit trail. Rollback copies a prior snapshot into a **new** revision, preserving history, idempotency receipts and bindings, and protects the restored state from automatic reversal.

## Detection, Level A and Level B

The Skill instructs the model to compare only newly established outcomes with the last persisted state. It emits a structured `TurnAssessment`: no-change or meaningful operations with stable source references. The deterministic detector removes literal no-ops and converts deferred ideas into PARK_NODE/parking additions. It does not ingest or enumerate an entire project. Only supplied snippets/source IDs leave ChatGPT.

**Level A:** host/model calls the update tool after a meaningful turn. The backend can persist through authenticated MCP, or a staging tool can return a proposed delta to the active iframe, which persists via HTTPS. Staging is annotated as a write-intent tool, never disguised as read-only. Direct UI edits use the same pipeline with server-assigned human source. UI polls scoped state while visible and responds to host tool-result events. There is no claim that loading an iframe grants access to conversation turns or forces the model to call tools.

**Level B:** closed/inactive app has no autonomous watcher. Reopening reads persisted state and exposes a recovery prompt. Refresh sends a follow-up request asking ChatGPT to summarize available goal/tasks/decisions/evidence, then call reconcile. Reconciliation retains old IDs and omitted nodes, resolves exact IDs first and unique normalized semantic keys second, and stages ambiguous matches. Lack of visible history is displayed as incomplete coverage. This is eventual consistency conditional on evidence, not invented full-history synchronization.

## Reconciliation

Overview contains goal, task observations, decisions, focus, coverage statement and source references. The planner matches existing IDs before semantic keys `(parentId, normalized title)`. Matching by title is conservative; uncertainty produces a review, never an automatic merge of distinct tasks. It builds ordinary delta operations and submits them to the same transaction pipeline. Omission never means deletion/drop/completion. Goal changes, terminal contradictions, manual locks and stale observations are reviewable. A successful meaningful reconcile sets lastFullReconcile on the same revision. A no-change reconcile returns its checked time without creating a state revision.

## UI and artifacts

Single-project UI: first-time binding/login, then goal/focus/tree/decisions/parking and compact pending-review controls. Real tree connectors, nested groups, disclosure controls and keyboard interaction; status is conveyed in text and color. Node detail shows evidence, dependencies and manual edits. Errors do not replace the last known state. UI status distinguishes connected, pending and stale; refresh acknowledgement never falsely says reconciliation is complete before a committed result arrives.

MCP Apps `_meta.ui.resourceUri` and `ui/*` bridge are the primary host protocol, with feature-detected `window.openai` compatibility. Inline/fullscreen are requested only when supported. No internal Markdown/JSON/code tabs mimicking host tabs. `task-map.md` and static escaped HTML are generated on demand from a versioned snapshot; MCP may return Markdown content/resource and UI offers export. Automatic native file/tab attachment is not established by public APIs.

## Operations and limits

One personal owner per deployment, multiple isolated projects, one SQLite writer with WAL and busy timeout. Backup uses a consistent SQLite backup/checkpoint procedure. PostgreSQL can replace Store without modifying the reducer. No multi-user collaboration, billing, task scheduler or background LLM. Configure stable signing/owner secrets across restarts; expiring sessions require reconnect. Repository creation is private; deployment and a live ChatGPT connection require runtime secrets and an HTTPS origin supplied by the operator.

## Official capability sources

Inspected 2026-09-26; capability availability remains account-dependent:
- https://developers.openai.com/plugins/build/chatgpt-ui — MCP Apps UI/bridge and durable state boundary.
- https://developers.openai.com/plugins/build/app-quickstart — official server/UI quickstart.
- https://developers.openai.com/plugins/deploy/connect-chatgpt — HTTPS or secure tunnel; developer mode connection/testing.
- https://developers.openai.com/chatgpt — Plus/Pro developer-mode read/write support.
- https://developers.openai.com/plugins/guides/security-privacy — iframe network and privacy boundaries.

Absence of host project IDs, global turn hooks and tab registration in inspected public interfaces is treated as an implementation limitation, not proof that OpenAI will never offer them.
