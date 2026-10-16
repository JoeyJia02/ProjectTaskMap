import { DomainConflict, reduceDelta } from '../domain/reducer';
import { reviewFamily, reviewParent } from '../domain/review-family';
import type { Conflict as StoredConflict, ProjectState as StoredState, ProjectStateDelta } from '../domain/schema';
import type { Conflict, ProjectState } from './types';

export function pendingReviewGroups(conflicts: Conflict[]) {
  const all = conflicts as unknown as StoredConflict[];
  return conflicts.filter(item => item.status === 'pending' && reviewParent(item as unknown as StoredConflict, all)?.status !== 'pending')
    .map(conflict => ({ conflict, copies: reviewFamily(conflict as unknown as StoredConflict, all).filter(item => item.id !== conflict.id && item.status === 'pending').length }));
}

export function approvalIssue(state: ProjectState, conflict: Conflict): string | undefined {
  if (!conflict.delta.operations.some(op => op.type !== 'NO_OP')) return '此提案没有可执行更改，需要重新核对。';
  try {
    reduceDelta(state as unknown as StoredState, { ...conflict.delta, source: 'manual', confidence: 1, timestamp: new Date().toISOString(), expectedVersion: state.version } as ProjectStateDelta);
  } catch (error) {
    if (error instanceof DomainConflict && error.kind === 'duplicate_task') return '提案中的新增任务已存在。请保留当前，按已有任务 ID 重新核对后生成提案。';
    return '此提案不能应用于当前地图。请保留当前，重新核对任务、依赖与状态后生成提案。';
  }
}
