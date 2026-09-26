# Project Task Map — V1 requirements

Status: design baseline, 2026-09-26. Product: a human-facing task state layer for a **single ChatGPT Project**. This is a persistent application, not a generated tree demo.

## Outcomes and scope

Within ten seconds of opening the map, a person should be able to identify the goal, current task and next step, completed work, blockers, parked ideas, recent decisions, and number of main branches. Cross-project navigation belongs to ChatGPT. No global dashboard, scheduling, time estimates, teams, notifications, Jira/Slack/email integrations, or automated priority scores.

The workspace contains: “项目任务框架”; tabs 概览 / 任务树 / 决策日志 / Parking Lot; “刷新项目地图”; concise Goal and Current Focus cards; a real collapsible tree with connector lines, active-branch emphasis and six status labels; recent decisions; parked branches. White/gray surfaces, restrained green, rounded cards and compact readable hierarchy. No simulated host file tabs. Only this written visual specification was supplied; no prior screenshot is available.

## Required behavior

| ID | Requirement | Acceptance |
|---|---|---|
| R01 | Durable binding | External UUID + persistent binding key, never project name as identity; rename/restart/reconnect reuse the map. Optional future verified host ID. |
| R02 | Project isolation | Every storage/API operation is scoped to an authenticated principal and project. Another project cannot be addressed through its token. |
| R03 | Graph model | Parent forest plus cross-branch dependencies; reject missing endpoints, self edges, hierarchy and dependency cycles. |
| R04 | Incremental state | Structured operations, evidence, source, confidence, timestamp, idempotency key, expected version. No meaningful change means no state/version/history write. |
| R05 | Human precedence | Manual edits protect affected nodes/goal/focus. AI cannot undo explicit dropped/done outcomes without reviewed reopening. |
| R06 | Consistency | Atomic batches; retries replay; key reuse with different payload conflicts; stale versions and ambiguity are visible review records. |
| R07 | Full reconcile | Merge overview/evidence into existing IDs; never delete by omission or replace entire state. Detect duplicate ambiguity, stale evidence and conflicting outcomes. |
| R08 | Level A | For delivered turns, a lightweight structured assessment produces NO_OP or a delta; active UI syncs accepted changes and refreshes persisted state. Host invocation is policy-driven, not a guaranteed callback. |
| R09 | Level B | Reopen/refresh requests an overview of available context, then reconciles missed changes. No background access to other chats. |
| R10 | MCP Apps | Real streamable HTTP MCP server, JSON schemas and truthful annotations, embedded UI resource; compatible ChatGPT extensions only when detected. |
| R11 | Persistence | SQLite transactions, stable IDs, version snapshots, history, rollback as a new version, same database across restarts. |
| R12 | Artifact | Deterministic Markdown and safe static HTML generated from committed state, served as authenticated exports. No fabricated native file registration. |
| R13 | Pro compatibility | Personal account, no enterprise API; UI HTTPS fetch to backend is available with scoped session credentials and explicit CSP/CORS. |
| R14 | Explainability | Node source references, last successful delta/reconcile times, conflicts with reasons; no raw transcript retention by default. |
| R15 | Recoverability | Rejected mutations leave previous graph intact. Network errors are visible. Retrying an accepted delta does not apply it twice. |

## Platform boundary

Official documentation was inspected on 2026-09-26. MCP Apps iframe UI and tool bridge are supported. Stable ChatGPT Project ID, arbitrary project-chat enumeration, a universal turn-completed callback, and third-party host workspace-tab registration are **not established by the public interface inspected**. They are not prerequisites or invented features. An adapter boundary keeps future support additive. See CURRENT_LIMITATIONS.md and architecture.md. A model cannot promise access to every prior chat: reconciliation reports the evidence actually supplied.

## Delivery and verification

Design documents precede code. Deliver backend, UI, MCP integration, task-manager Skill, exports, setup and ChatGPT connection guides, limitations and decisions. Unit/integration/UI tests must cover bindings, state machine, idempotency, duplicate nodes, human overrides, conflicts, delta/no-op, recovery, reconciliation, artifacts, and multi-project isolation.

Scenario A: 20 delivered turns / 4 changes = exactly 4 state revisions. B: “之后再看” produces parking, not active. C: a completed task mentioned again does not duplicate/reopen. D: manually dropped work survives old AI context. E: ten unobserved turns are recovered from an explicitly supplied overview. F: “输出我们任务概况目前进度，并更新 TaskBoardApp” requests overview then reconcile. Tests establish deterministic contracts, not the reliability of an untested model invocation or a live ChatGPT installation.

Release acceptance includes independent code review and a product review against the eight questions. Real ChatGPT account connection and hosted HTTPS verification must be reported separately from local integration tests.
