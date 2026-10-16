import { canonical } from './reducer.js';
import type { Conflict } from './schema.js';

/** Identify only duplicates produced by the old failed-approval path. */
export function reviewParent(conflict: Conflict, all: Conflict[]): Conflict | undefined {
  if (conflict.delta.source !== 'manual' || !conflict.delta.idempotencyKey.startsWith('review:')) return;
  const parentId = conflict.delta.idempotencyKey.slice('review:'.length);
  const parent = all.find(item => item.id === parentId && item.projectId === conflict.projectId && item.id !== conflict.id);
  if (parent && conflict.delta.evidence.some(ref => ref.kind === 'manual' && ref.id === `review:${parentId}`)
    && canonical(parent.delta.operations) === canonical(conflict.delta.operations)) return parent;
}

export function reviewFamily(root: Conflict, all: Conflict[]): Conflict[] {
  const ids = new Set([root.id]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of all) {
      if (ids.has(item.id)) continue;
      const parent = reviewParent(item, all);
      if (parent && ids.has(parent.id)) { ids.add(item.id); expanded = true; }
    }
  }
  return all.filter(item => ids.has(item.id));
}
