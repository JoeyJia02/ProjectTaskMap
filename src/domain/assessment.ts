import { assessmentSchema, type ProjectStateDelta, type TurnAssessment } from './schema.js';

/** Semantic judgement belongs to the host; the detector validates its explicit contract. */
export function assessmentToDelta(input: TurnAssessment): ProjectStateDelta {
  const assessment = assessmentSchema.parse(input);
  return {
    projectId: assessment.projectId, idempotencyKey: `turn:${assessment.turnId}`,
    expectedVersion: assessment.expectedVersion, timestamp: assessment.timestamp, source: 'ai',
    confidence: assessment.confidence, evidence: assessment.evidence,
    operations: assessment.meaningful ? assessment.operations.filter(op => op.type !== 'NO_OP') : [],
  };
}
