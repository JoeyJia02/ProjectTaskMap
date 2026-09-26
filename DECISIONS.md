# Architecture decisions

| ID | Decision | Rationale / consequence |
|---|---|---|
| ADR-001 | Single-project surface | ChatGPT owns cross-project navigation. No global dashboard. |
| ADR-002 | Parent forest + dependency DAG | Real work crosses branches; tree is a view, not the storage model. |
| ADR-003 | Structured model assessment, deterministic backend | ChatGPT supplies semantic judgments; a regex cannot reliably infer arbitrary conversation intent. Backend never claims hidden-chat access. |
| ADR-004 | Stable external UUID and owner+bindingKey | Public host Project ID is not established; labels cannot be identity. Explicit recovery key is durable across devices and renames. |
| ADR-005 | SQLite and whole-state snapshots | Personal scope favors auditable transactions and simple restore over event-sourcing infrastructure. |
| ADR-006 | Atomic deltas with expectedVersion and idempotency | Prevent lost updates, partial batches and duplicate writes; no-op never creates a state revision. |
| ADR-007 | Conservative human precedence | Node-level manual locks + project goal/focus locks. AI terminal reopening and ambiguity require review. |
| ADR-008 | Reconcile through the same reducer | Refresh merges evidence; omission never erases work. Stable IDs and checks remain intact. |
| ADR-009 | Standards-first MCP Apps UI | Current official interface uses resourceUri + ui bridge. Legacy OpenAI aliases are feature-detected compatibility only. |
| ADR-010 | OAuth PKCE + scoped ephemeral iframe tokens | No secrets in model-visible results. Personal deployment avoids team/enterprise dependencies. |
| ADR-011 | Active UI HTTPS and direct MCP paths | Both use the same store; staging is truthfully annotated write-intent. No bypass of host authorization. |
| ADR-012 | Markdown/HTML projections, no fabricated workspace tabs | Artifacts can be exported and host-rendered when supported; core does not depend on unpublished registration APIs. |
| ADR-013 | Policy-driven Level A, evidence-driven Level B | Ordinary Chat has no guaranteed per-turn hook. Work/Codex hooks can be a future adapter, not a prerequisite. |
| ADR-014 | Explicit iframe origin, not broad wildcard CORS | Independent review exposed local-vs-host fetch differences. Resource domain and backend allowlist share configuration. |
| ADR-015 | Full personal OAuth grant only | V1 requires read+write and rejects partial-scope requests rather than silently granting more than requested. |
| ADR-016 | No automatic live deployment | An HTTPS domain, secrets and real ChatGPT authorization are operator configuration; local proof is kept separate from hosted acceptance. |
| ADR-017 | Rollback removal guards | Restored nodes are human-protected; removed node/decision identities cannot be automatically revived with new request keys. |
| ADR-018 | Monotonic event timestamps | Late evidence remains timestamped honestly, but project/node update watermarks never move backward and weaken stale-evidence checks. |
