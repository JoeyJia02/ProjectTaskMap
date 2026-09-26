export type TaskStatus = 'todo' | 'active' | 'blocked' | 'done' | 'parking' | 'dropped';
export interface SourceRef { id: string; kind: 'turn' | 'file' | 'manual' | 'overview'; label: string; timestamp: string; excerpt?: string }
export interface TaskNode {
  id: string; title: string; summary: string; parentId: string | null; dependencies: string[];
  status: TaskStatus; createdAt: string; updatedAt: string; sourceRefs: SourceRef[];
  manualOverride: boolean; metadata: { nextStep?: string; [key: string]: unknown };
}
export interface ProjectState {
  projectId: string; name: string; goal: string; activeNodeId: string | null;
  nodes: TaskNode[]; decisions: { id: string; title: string; rationale: string; createdAt: string; sourceRefs: SourceRef[] }[];
  parkingLot: { nodeId: string; reason: string; parkedAt: string }[]; version: number;
  createdAt: string; updatedAt: string; lastIncrementalUpdate: string | null; lastFullReconcile: string | null;
  manualOverrides: { goal: boolean; focus: boolean };
}
export type Operation = { type: string; [key: string]: unknown };
export interface Delta { projectId: string; idempotencyKey: string; expectedVersion: number; timestamp: string; source: 'ai' | 'manual' | 'reconcile'; confidence: number; evidence: SourceRef[]; operations: Operation[] }
export interface Conflict { id: string; projectId: string; kind: string; message: string; delta: Delta; createdAt: string; status: 'pending' | 'approved' | 'rejected' }
export interface HistoryEntry { version: number; reason: string; createdAt: string }
export interface MutationResult { outcome: 'applied' | 'no_op' | 'duplicate' | 'pending'; state: ProjectState; conflict?: Conflict }
export interface HostContext { state?: ProjectState; bindingKey?: string; projectToken?: string; apiBaseUrl?: string; pendingDelta?: Delta }
export interface HostAdapter { connect(onContext: (context: HostContext) => void): Promise<void>; sendRefresh(prompt: string): Promise<boolean>; close(): void }
