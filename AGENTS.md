# Project Task Map development

This repository uses its own task map for explicitly requested project tracking.

- The configured local MCP server is `project_task_map`.
- This repository's bindingKey is `project-task-map-development`; its display name is `Project Task Map`.
- Reuse that key with `bind_project`. Never use the separate `taskmap-local-verification` binding for real project work.
- Before project tracking or progress synchronization, read `skills/task-manager/SKILL.md` and the saved map. Preserve existing task IDs, human changes, and terminal states.
- Track only evidence-backed changes relevant to this repository. Ordinary questions do not by themselves require writes. If tools are unavailable, say that synchronization did not occur.
- For “打开任务地图”, call `bind_project` with the above key, then `get_project_map` with the returned projectId. If the host does not render the component, return the actual state and report that UI rendering is unverified.
- Do not read or expose `.env`, tokens, or local credential files to answer project status questions. Application scripts may use the configured secrets internally when performing explicitly authorized setup or verification; never put them in output or artifacts.

Use `npm run check` for changes affecting domain/server behavior. Local setup verification is `node scripts/verify-local-mcp.mjs --refresh-check`; it writes only a separate verification project. The verification evidence and runtime logs stay under ignored `.tmp/`.
