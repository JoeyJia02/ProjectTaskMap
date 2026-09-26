// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHtml, renderMarkdown } from "../src/artifacts/index.js";
import type { ProjectState } from "../src/domain/schema.js";

const timestamp = "2026-09-26T00:00:00.000Z";
const evidence = { id: "turn-7", kind: "turn" as const, label: "User decision", timestamp, excerpt: "Keep the first release small." };

function fixture(): ProjectState {
  return {
    projectId: "project-a", name: "任务地图", goal: "Deliver a useful first version", version: 4,
    activeNodeId: "task-1", createdAt: timestamp, updatedAt: timestamp,
    lastIncrementalUpdate: timestamp, lastFullReconcile: null,
    manualOverrides: { goal: false, focus: false },
    nodes: (["todo", "active", "blocked", "done", "parking", "dropped"] as const).map((status, index) => ({
      id: `task-${index}`, title: `Task ${index}`, summary: `Summary ${index}`,
      parentId: index === 0 ? null : "task-0", status,
      dependencies: index === 1 ? ["task-3"] : [], createdAt: timestamp, updatedAt: timestamp,
      sourceRefs: [evidence], manualOverride: index === 5,
      metadata: { nextStep: index === 1 ? "Review the implementation" : "", privateCredential: "must-not-export-secret" },
    })),
    decisions: [{ id: "decision-1", title: "Keep local persistence", rationale: "Recover state after restart", createdAt: timestamp, sourceRefs: [evidence] }],
    parkingLot: [{ nodeId: "task-4", reason: "之后再看", parkedAt: timestamp }],
  };
}

function parse(content: string): Document {
  return new DOMParser().parseFromString(content, "text/html");
}

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

describe("committed-state artifact exports", () => {
  it("retains real hierarchy, all six states, focus, dependencies and human protection", () => {
    const state = fixture();
    const document = parse(renderHtml(state));
    const root = document.querySelector(".tree.root")!;
    expect(root.children).toHaveLength(1);
    expect(root.querySelectorAll(".node")).toHaveLength(6);
    expect(root.querySelector(".branch > .tree")!.children).toHaveLength(5);
    expect(document.querySelector(".focused h3")?.textContent).toBe("Task 1");
    expect(document.querySelector(".focused")?.textContent).toContain("Task 3（task-3）");
    expect(document.querySelectorAll(".status")).toHaveLength(6);
    for (const label of ["待开始", "进行中", "受阻", "已完成", "暂存", "已放弃"]) {
      expect(document.body.textContent).toContain(label);
      expect(renderMarkdown(state)).toContain(label);
    }
    expect(document.querySelector(".lock")?.textContent).toBe("人工保护");
    expect(renderMarkdown(state)).toMatch(/\n  - \*\*Task 1\*\*/);
  });

  it("exports evidence and decisions with their source IDs and honest snapshot metadata", () => {
    const state = fixture();
    for (const content of [parse(renderHtml(state)).body.textContent!, renderMarkdown(state)]) {
      expect(content).toContain("User decision");
      expect(content).toContain("Keep local persistence");
      expect(content).toContain("Recover state after restart");
      expect(content).toContain("之后再看");
      expect(content).toContain("尚未核对");
      expect(content).not.toContain("must-not-export-secret");
    }
    const text = parse(renderHtml(state)).body.textContent!;
    expect(text).toContain(evidence.id);
    expect(text).toContain(evidence.timestamp);
    expect(text).toContain(evidence.excerpt);
    expect(text).toContain("静态快照");
  });

  it("treats markup and links in every user-controlled field as text", () => {
    const state = fixture();
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>[open](javascript:alert(3))';
    state.name = payload;
    state.goal = payload;
    state.nodes[0]!.title = payload;
    state.nodes[0]!.summary = payload;
    state.nodes[0]!.metadata.nextStep = payload;
    state.nodes[0]!.sourceRefs = [{ ...evidence, label: payload, excerpt: payload }];
    state.decisions[0]!.title = payload;
    state.decisions[0]!.rationale = payload;
    state.parkingLot[0]!.reason = payload;
    const output = renderHtml(state);
    const document = parse(output);
    expect(document.querySelectorAll("script, img, iframe, a, form, link")).toHaveLength(0);
    expect(document.title).toContain(payload);
    expect(document.body.textContent).toContain(payload);
    expect([...document.querySelectorAll("*")].some((node) => [...node.attributes].some((attribute) => attribute.name.startsWith("on")))).toBe(false);
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("default-src 'none'");
    const markdown = renderMarkdown(state);
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("<script");
    expect(markdown).not.toContain("[open](javascript:");
    expect(markdown).toContain("&lt;img");
    expect(markdown).toContain("\\[open\\]\\(javascript:");
  });

  it("is deterministic without mutating or reordering the supplied snapshot", () => {
    const state = fixture();
    state.nodes.reverse();
    const before = JSON.stringify(state);
    freeze(state);
    const html = renderHtml(state);
    const markdown = renderMarkdown(state);
    expect(renderHtml(state)).toBe(html);
    expect(renderMarkdown(state)).toBe(markdown);
    expect(renderHtml({ ...state, nodes: [...state.nodes].reverse() })).toBe(html);
    expect(renderMarkdown({ ...state, nodes: [...state.nodes].reverse() })).toBe(markdown);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("renders a new empty project without inventing tasks, progress or evidence", () => {
    const state = { ...fixture(), nodes: [], decisions: [], parkingLot: [], activeNodeId: null, goal: "", version: 0 };
    const document = parse(renderHtml(state));
    expect(document.querySelectorAll(".node")).toHaveLength(0);
    expect(document.body.textContent).toContain("尚未设定目标");
    expect(document.body.textContent).toContain("尚未选择当前任务");
    expect(document.body.textContent).toContain("暂无任务");
    expect(renderMarkdown(state)).toContain("主分支：0 · 任务总数：0");
  });
});
