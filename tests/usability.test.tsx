// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskBrowser } from '../src/ui/TaskBrowser';
import { QuickIdea } from '../src/ui/QuickIdea';
import { demoState } from '../src/ui/demo';
import { describeChanges } from '../src/ui/ReviewChanges';
import { approvalIssue, pendingReviewGroups } from '../src/ui/review-model';
import type { Conflict } from '../src/ui/types';
afterEach(cleanup);

it('groups generated review copies but preserves independent proposals and blocks duplicate ADD approval', () => {
  const state = structuredClone(demoState);
  const task = state.nodes[0];
  const root: Conflict = { id: 'root', projectId: state.projectId, status: 'pending', kind: 'duplicate_task', message: 'duplicate', createdAt: state.updatedAt,
    delta: { projectId: state.projectId, expectedVersion: state.version, source: 'ai', idempotencyKey: 'original', confidence: 1, timestamp: state.updatedAt, evidence: [], operations: [{ type: 'ADD_NODE', node: { id: task.id, title: task.title, summary: 'different' } }] } };
  const copies: Conflict[] = Array.from({ length: 6 }, (_, i) => ({ ...root, id: `copy-${i}`, delta: { ...root.delta, source: 'manual', idempotencyKey: 'review:root', evidence: [{ id: 'review:root', kind: 'manual', label: 'Human approved proposal', timestamp: state.updatedAt }] } }));
  expect(pendingReviewGroups([root, ...copies])).toEqual([{ conflict: root, copies: 6 }]);
  expect(pendingReviewGroups([root, ...copies, { ...root, id: 'independent' }])).toHaveLength(2);
  expect(approvalIssue(state, root)).toContain('已有任务 ID');
  expect(describeChanges(state, root.delta.operations)[0].before).toContain(task.title);
});

it('filters completed tasks and retains parent context for search results', async () => {
  const user = userEvent.setup();
  const state = structuredClone(demoState);
  state.nodes[0].status = 'done';
  state.nodes[1].parentId = state.nodes[0].id;
  state.nodes[1].status = 'todo';
  render(<TaskBrowser state={state} onSelect={() => {}} />);
  await user.type(screen.getByLabelText('搜索任务'), state.nodes[1].title);
  expect(screen.getByRole('treeitem', { name: `${state.nodes[0].title}，已完成` })).toBeTruthy();
  expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  await user.clear(screen.getByLabelText('搜索任务'));
  await user.selectOptions(screen.getByLabelText('筛选任务'), 'blocked');
  expect(screen.getByText(/匹配 1 项/)).toBeTruthy();
});

it('retains a quick idea on failure and clears it only after successful save', async () => {
  const user = userEvent.setup(); const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<QuickIdea busy={false} onSave={save} />);
  await user.type(screen.getByLabelText('随手记想法'), '临时想法{Enter}');
  expect((screen.getByLabelText('随手记想法') as HTMLInputElement).value).toBe('临时想法');
  await user.click(screen.getByRole('button', { name: '记下' }));
  expect((screen.getByLabelText('随手记想法') as HTMLInputElement).value).toBe('');
  expect(save.mock.calls[0][0][0].node.status).toBe('parking');
});

it('shows sequential before/after values without mutating the saved state', () => {
  const state = structuredClone(demoState); const old = state.goal;
  const rows = describeChanges(state, [{ type: 'UPDATE_GOAL', goal: '第一版' }, { type: 'UPDATE_GOAL', goal: '第二版' }]);
  expect(rows[0].before).toBe(old); expect(rows[1].before).toBe('第一版'); expect(rows[1].after).toBe('第二版');
  expect(state.goal).toBe(old);
});
