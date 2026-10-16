import { z } from 'zod';

export const idSchema = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(300);
const text = z.string().max(10000);
export const timestampSchema = z.iso.datetime({ offset: true });
export const statusSchema = z.enum(['todo', 'active', 'blocked', 'done', 'parking', 'dropped']);
export const sourceRefSchema = z.object({
  id: idSchema, kind: z.enum(['turn', 'file', 'manual', 'overview']), label: shortText,
  timestamp: timestampSchema, excerpt: z.string().max(2000).optional(),
}).strict();
export const metadataSchema = z.object({ nextStep: z.string().max(2000).optional(), semanticKey: z.string().max(300).optional(),
  relatedNodeIds: z.array(idSchema).max(100).optional(),
  ideaPriority: z.enum(['high', 'normal', 'low']).optional(), ideaPinned: z.boolean().optional(),
})
  .catchall(z.json()).refine(value => Object.keys(value).every(key => key.length <= 100), 'Metadata keys must be at most 100 characters')
  .refine(value => JSON.stringify(value).length <= 12000, 'Metadata must be at most 12000 characters');
const evidenceSchema = z.array(sourceRefSchema).max(100);
export const nodeInputSchema = z.object({
  id: idSchema, title: shortText, summary: text.optional(), parentId: idSchema.nullable().optional(),
  status: statusSchema.optional(), dependencies: z.array(idSchema).max(100).optional(), metadata: metadataSchema.optional(),
}).strict();
export const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NO_OP'), reason: text.optional() }).strict(),
  z.object({ type: z.literal('ADD_NODE'), node: nodeInputSchema }).strict(),
  z.object({ type: z.literal('UPDATE_NODE'), nodeId: idSchema, changes: z.object({
    title: shortText.optional(), summary: text.optional(), metadata: metadataSchema.optional(), manualOverride: z.boolean().optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('COMPLETE_NODE'), nodeId: idSchema }).strict(),
  z.object({ type: z.literal('BLOCK_NODE'), nodeId: idSchema, reason: shortText }).strict(),
  z.object({ type: z.literal('UNBLOCK_NODE'), nodeId: idSchema }).strict(),
  z.object({ type: z.literal('MOVE_NODE'), nodeId: idSchema, parentId: idSchema.nullable() }).strict(),
  z.object({ type: z.literal('PARK_NODE'), nodeId: idSchema, reason: shortText }).strict(),
  z.object({ type: z.literal('DROP_NODE'), nodeId: idSchema, reason: text.optional() }).strict(),
  z.object({ type: z.literal('START_NODE'), nodeId: idSchema }).strict(),
  z.object({ type: z.literal('SET_ACTIVE_NODE'), nodeId: idSchema.nullable() }).strict(),
  z.object({ type: z.literal('ADD_DECISION'), decision: z.object({ id: idSchema, title: shortText, rationale: text.optional() }).strict() }).strict(),
  z.object({ type: z.literal('UPDATE_GOAL'), goal: text }).strict(),
  z.object({ type: z.literal('ADD_DEPENDENCY'), nodeId: idSchema, dependencyId: idSchema }).strict(),
  z.object({ type: z.literal('REMOVE_DEPENDENCY'), nodeId: idSchema, dependencyId: idSchema }).strict(),
]);
const commonRequest = {
  projectId: idSchema, expectedVersion: z.number().int().nonnegative(), timestamp: timestampSchema,
  confidence: z.number().min(0).max(1), evidence: evidenceSchema,
};
export const deltaSchema = z.object({ ...commonRequest, idempotencyKey: idSchema,
  source: z.enum(['ai', 'manual', 'reconcile']), operations: z.array(operationSchema).max(300),
}).strict();
export const assessmentSchema = z.object({ ...commonRequest, turnId: idSchema,
  meaningful: z.boolean(), operations: z.array(operationSchema).max(300),
}).strict().refine(value => value.meaningful || value.operations.every(op => op.type === 'NO_OP'), {
  message: 'A NO_OP assessment cannot contain mutations', path: ['operations'],
});
export const overviewSchema = z.object({ ...commonRequest, reconcileId: idSchema, coverage: shortText,
  goal: text.optional(), activeNodeId: idSchema.nullable().optional(),
  nodes: z.array(nodeInputSchema.partial({ id: true })).max(1000),
  decisions: z.array(z.object({ id: idSchema.optional(), title: shortText, rationale: text.optional() }).strict()).max(300).optional(),
}).strict();
export const bindSchema = z.object({ bindingKey: idSchema, name: shortText, goal: text.optional(), hostProjectId: idSchema.optional() }).strict();
export const taskNodeSchema = z.object({
  id: idSchema, title: shortText, summary: text, parentId: idSchema.nullable(), dependencies: z.array(idSchema),
  status: statusSchema, createdAt: timestampSchema, updatedAt: timestampSchema, sourceRefs: evidenceSchema,
  manualOverride: z.boolean(), metadata: metadataSchema,
}).strict();
export const decisionSchema = z.object({ id: idSchema, title: shortText, rationale: text,
  createdAt: timestampSchema, sourceRefs: evidenceSchema }).strict();
export const projectStateSchema = z.object({
  projectId: idSchema, name: shortText, goal: text, activeNodeId: idSchema.nullable(),
  nodes: z.array(taskNodeSchema), decisions: z.array(decisionSchema),
  parkingLot: z.array(z.object({ nodeId: idSchema, reason: text, parkedAt: timestampSchema }).strict()),
  version: z.number().int().nonnegative(), createdAt: timestampSchema, updatedAt: timestampSchema,
  lastIncrementalUpdate: timestampSchema.nullable(), lastFullReconcile: timestampSchema.nullable(),
  manualOverrides: z.object({ goal: z.boolean(), focus: z.boolean() }).strict(),
}).strict();
export const bindingSchema = z.object({ projectId: idSchema, ownerId: idSchema, bindingKey: idSchema,
  hostProjectId: idSchema.nullable(), name: shortText, createdAt: timestampSchema, updatedAt: timestampSchema }).strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type TaskStatus = z.infer<typeof statusSchema>;
export type TaskNode = z.infer<typeof taskNodeSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type ProjectBinding = z.infer<typeof bindingSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type ProjectStateDelta = z.infer<typeof deltaSchema>;
export type TurnAssessment = z.infer<typeof assessmentSchema>;
export type ProjectOverview = z.infer<typeof overviewSchema>;
export type BindInput = z.infer<typeof bindSchema>;
export interface Conflict {
  id: string; projectId: string; kind: string; message: string; delta: ProjectStateDelta;
  createdAt: string; status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string; reviewVersion?: number; reviewAction?: 'approve' | 'reject';
}
export interface MutationResult { outcome: 'applied' | 'no_op' | 'duplicate' | 'pending'; state: ProjectState; conflict?: Conflict; checkedAt?: string; coverage?: string }
export interface HistoryEntry { projectId: string; version: number; state: ProjectState; reason: string; createdAt: string }
