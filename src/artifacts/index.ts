import type { ProjectState } from "../domain/schema.js";

type Task = ProjectState["nodes"][number];
type Evidence = Task["sourceRefs"][number];

const statusLabels = {
  todo: "待开始", active: "进行中", blocked: "受阻",
  done: "已完成", parking: "暂存", dropped: "已放弃",
} as const;

/** Render only explicit business fields; tokens and arbitrary metadata never enter exports. */
function html(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function md(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&")
    .replace(/[\r\n]+/g, " ");
}

function ordered<T extends { id: string; createdAt?: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const a = `${left.createdAt ?? ""}\u0000${left.id}`;
    const b = `${right.createdAt ?? ""}\u0000${right.id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function nextStep(node: Task): string {
  return typeof node.metadata.nextStep === "string" ? node.metadata.nextStep : "";
}

function forest(state: ProjectState): { children: Map<string | null, Task[]>; roots: Task[] } {
  const ids = new Set(state.nodes.map((node) => node.id));
  const children = new Map<string | null, Task[]>();
  for (const node of ordered(state.nodes)) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  return { children, roots: children.get(null) ?? [] };
}

function evidenceMarkdown(ref: Evidence): string {
  return `${md(ref.label)} · ${md(ref.kind)} · ${md(ref.id)} · ${md(ref.timestamp)}`
    + (ref.excerpt ? ` — ${md(ref.excerpt)}` : "");
}

function evidenceHtml(ref: Evidence): string {
  return `<li><strong>${html(ref.label)}</strong> <span class="muted">${html(ref.kind)} · ${html(ref.id)} · ${html(ref.timestamp)}</span>`
    + (ref.excerpt ? `<p class="excerpt">${html(ref.excerpt)}</p>` : "") + "</li>";
}

/** Deterministic snapshot projection. Does not read storage or mutate the supplied state. */
export function renderMarkdown(state: ProjectState): string {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const active = state.activeNodeId ? byId.get(state.activeNodeId) : undefined;
  const { children, roots } = forest(state);
  const lines = [
    `# ${md(state.name)} — 项目任务框架`, "",
    `项目 ID：${md(state.projectId)} · 版本：${state.version}`, "",
    `更新时间：${md(state.updatedAt)}`, "",
    `最近增量同步：${md(state.lastIncrementalUpdate ?? "尚未同步")}`, "",
    `最近全量核对：${md(state.lastFullReconcile ?? "尚未核对")}`, "",
    "## 目标", "", md(state.goal || "尚未设定目标"), "",
    "## 当前焦点", "", active ? `${md(active.title)}（${md(active.id)}）` : "尚未选择当前任务", "",
    `下一步：${md(active && nextStep(active) ? nextStep(active) : "尚未明确")}`, "",
    `主分支：${roots.length} · 任务总数：${state.nodes.length}`, "",
    Object.entries(statusLabels).map(([status, label]) => `${label} ${state.nodes.filter((node) => node.status === status).length}`).join(" · "), "",
    "## 任务树", "",
  ];
  const seen = new Set<string>();
  function visit(node: Task, depth: number): void {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- **${md(node.title)}** · ${statusLabels[node.status]}${node.manualOverride ? " · 人工保护" : ""}（${md(node.id)}）`);
    if (node.summary) lines.push(`${indent}  - 说明：${md(node.summary)}`);
    if (nextStep(node)) lines.push(`${indent}  - 下一步：${md(nextStep(node))}`);
    if (node.dependencies.length) lines.push(`${indent}  - 前置依赖：${node.dependencies.map((id) => `${md(byId.get(id)?.title ?? id)}（${md(id)}）`).join("、")}`);
    lines.push(`${indent}  - 更新：${md(node.updatedAt)}`);
    for (const ref of node.sourceRefs) lines.push(`${indent}  - 依据：${evidenceMarkdown(ref)}`);
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
  }
  for (const node of roots) visit(node, 0);
  // Valid committed graphs are forests. Retain every record even for damaged imports.
  for (const node of ordered(state.nodes)) if (!seen.has(node.id)) visit(node, 0);
  if (!state.nodes.length) lines.push("暂无任务。");
  lines.push("", "## 决策日志", "");
  for (const decision of ordered(state.decisions)) {
    lines.push(`- **${md(decision.title)}**（${md(decision.id)}）· ${md(decision.createdAt)}`);
    if (decision.rationale) lines.push(`  - 原因：${md(decision.rationale)}`);
    for (const ref of decision.sourceRefs) lines.push(`  - 依据：${evidenceMarkdown(ref)}`);
  }
  if (!state.decisions.length) lines.push("暂无决策。");
  lines.push("", "## Parking Lot", "");
  for (const item of [...state.parkingLot].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)) {
    lines.push(`- **${md(byId.get(item.nodeId)?.title ?? item.nodeId)}**（${md(item.nodeId)}）· ${md(item.parkedAt)}`);
    lines.push(`  - 暂存原因：${md(item.reason)}`);
  }
  if (!state.parkingLot.length) lines.push("暂无暂存分支。");
  lines.push("", "---", "", "此文件是已提交项目状态的静态快照。对话覆盖范围以实际提供的依据为准。", "");
  return lines.join("\n");
}

/** Safe standalone HTML: no script, external asset, live capability, or raw user markup. */
export function renderHtml(state: ProjectState): string {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const active = state.activeNodeId ? byId.get(state.activeNodeId) : undefined;
  const { children, roots } = forest(state);
  const seen = new Set<string>();
  function visit(node: Task): string {
    if (seen.has(node.id)) return "";
    seen.add(node.id);
    const nested = (children.get(node.id) ?? []).map(visit).join("");
    return `<li class="branch"><article class="node${node.id === state.activeNodeId ? " focused" : ""}">`
      + `<div class="node-heading"><h3>${html(node.title)}</h3><span class="status ${html(node.status)}">${html(statusLabels[node.status])}</span>${node.manualOverride ? '<span class="lock">人工保护</span>' : ""}</div>`
      + (node.summary ? `<p>${html(node.summary)}</p>` : "")
      + (nextStep(node) ? `<p><strong>下一步：</strong>${html(nextStep(node))}</p>` : "")
      + (node.dependencies.length ? `<p><strong>前置依赖：</strong>${node.dependencies.map((id) => `${html(byId.get(id)?.title ?? id)}（${html(id)}）`).join("、")}</p>` : "")
      + `<p class="muted">${html(node.id)} · 更新 ${html(node.updatedAt)}</p>`
      + (node.sourceRefs.length ? `<details><summary>查看依据（${node.sourceRefs.length}）</summary><ul class="evidence">${node.sourceRefs.map(evidenceHtml).join("")}</ul></details>` : "")
      + `</article>${nested ? `<ul class="tree">${nested}</ul>` : ""}</li>`;
  }
  let tree = roots.map(visit).join("");
  tree += ordered(state.nodes).filter((node) => !seen.has(node.id)).map(visit).join("");
  const decisions = ordered(state.decisions).map((decision) => `<li><h3>${html(decision.title)}</h3><p>${html(decision.rationale)}</p><p class="muted">${html(decision.id)} · ${html(decision.createdAt)}</p>${decision.sourceRefs.length ? `<ul class="evidence">${decision.sourceRefs.map(evidenceHtml).join("")}</ul>` : ""}</li>`).join("");
  const parking = [...state.parkingLot].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0).map((item) => `<li><h3>${html(byId.get(item.nodeId)?.title ?? item.nodeId)}</h3><p>${html(item.reason)}</p><p class="muted">${html(item.nodeId)} · ${html(item.parkedAt)}</p></li>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(state.name)} — 项目任务框架</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c2925;background:#f5f7f6;line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:0 auto;padding:40px 24px}h1{font-size:30px;line-height:1.25;margin:8px 0}h2{font-size:20px;margin:0 0 16px}h3{font-size:16px;margin:0}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.eyebrow{color:#347255;font-size:13px;letter-spacing:.12em}.muted{font-size:12px;color:#64736c;overflow-wrap:anywhere}.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:26px 0}.card,section{background:#fff;border:1px solid #dde4df;border-radius:14px;padding:22px}section{margin:20px 0}.counts{display:flex;gap:10px;flex-wrap:wrap}.counts span,.status,.lock{border-radius:6px;padding:2px 8px;font-size:12px;background:#eef2ef}.status.active{background:#dff4e7;color:#155a36}.status.blocked{background:#fff1d6;color:#765418}.status.done{background:#e4eee8;color:#34674a}.status.parking{background:#ece8f7;color:#64538a}.status.dropped{background:#eee;color:#646464}.lock{background:#f5ebdf;color:#75592e}.tree{list-style:none;margin:0;padding-left:24px;border-left:1px solid #d4ded7}.tree.root{padding-left:0;border-left:0}.branch{position:relative;margin:12px 0}.tree:not(.root)>.branch:before{content:"";position:absolute;left:-24px;top:28px;width:24px;border-top:1px solid #d4ded7}.node{border:1px solid #e1e7e3;border-radius:10px;padding:16px;background:#fff}.focused{border:2px solid #429469;background:#f3faf5}.node-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.node-heading h3{margin-right:auto;overflow-wrap:anywhere}.evidence{padding-left:20px;font-size:13px}.evidence li{margin:8px 0}.excerpt{border-left:2px solid #d6e5db;padding-left:10px}.plain{padding-left:20px}.plain>li{padding:10px 0}summary{cursor:pointer;color:#347255;font-size:13px}footer{font-size:12px;color:#64736c;margin-top:28px}@media(max-width:650px){main{padding:24px 14px}.cards{grid-template-columns:1fr}.card,section{padding:16px}.tree{padding-left:14px}.tree:not(.root)>.branch:before{left:-14px;width:14px}}@media print{body{background:#fff}main{padding:0}.node{break-inside:avoid}details>*{display:block}}
</style></head><body><main><header><span class="eyebrow">PROJECT TASK MAP · 静态快照</span><h1>${html(state.name)}</h1><p>项目任务框架</p><p class="muted">项目 ${html(state.projectId)} · 版本 ${state.version} · 更新 ${html(state.updatedAt)}</p></header>
<div class="cards"><article class="card"><h2>目标</h2><p>${html(state.goal || "尚未设定目标")}</p></article><article class="card"><h2>当前焦点</h2><h3>${html(active?.title ?? "尚未选择当前任务")}</h3><p>下一步：${html(active && nextStep(active) ? nextStep(active) : "尚未明确")}</p></article></div>
<div class="counts"><span>主分支 ${roots.length}</span><span>任务 ${state.nodes.length}</span>${Object.entries(statusLabels).map(([status, label]) => `<span>${label} ${state.nodes.filter((node) => node.status === status).length}</span>`).join("")}</div>
<section aria-labelledby="tree-heading"><h2 id="tree-heading">任务树</h2>${tree ? `<ul class="tree root">${tree}</ul>` : "<p>暂无任务。</p>"}</section>
<section aria-labelledby="decisions-heading"><h2 id="decisions-heading">决策日志</h2>${decisions ? `<ol class="plain">${decisions}</ol>` : "<p>暂无决策。</p>"}</section>
<section aria-labelledby="parking-heading"><h2 id="parking-heading">Parking Lot</h2>${parking ? `<ul class="plain">${parking}</ul>` : "<p>暂无暂存分支。</p>"}</section>
<footer><p>最近增量同步：${html(state.lastIncrementalUpdate ?? "尚未同步")} · 最近全量核对：${html(state.lastFullReconcile ?? "尚未核对")}</p><p>此文件是已提交项目状态的静态快照，不会自动刷新。对话覆盖范围以实际提供的依据为准。</p></footer></main></body></html>\n`;
}
