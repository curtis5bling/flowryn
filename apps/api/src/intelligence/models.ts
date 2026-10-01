import { Schema, model } from 'mongoose';

const oid = { type: Schema.Types.ObjectId, required: true };
const factor = new Schema({ key: String, value: Number, weight: Number, contribution: Number, explanation: { type: String, maxlength: 160 }, unknown: Boolean }, { _id: false });
const policy = new Schema({ workspaceId: oid, version: Number, name: String, configuration: Schema.Types.Mixed, createdBy: oid, activatedBy: Schema.Types.ObjectId, active: { type: Boolean, default: false }, activatedAt: Date, replacedAt: Date }, { timestamps: true });
policy.index({ workspaceId: 1, version: 1 }, { unique: true }); policy.index({ workspaceId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
export const IntelligencePolicyModel = model('IntelligencePolicy', policy);

const signal = new Schema({
  workspaceId: oid, sourceType: { type: String, required: true }, sourceId: { type: String, required: true, maxlength: 160 }, deduplicationKey: { type: String, required: true, maxlength: 240 },
  serviceId: Schema.Types.ObjectId, projectId: Schema.Types.ObjectId, incidentId: Schema.Types.ObjectId, alertId: Schema.Types.ObjectId, taskId: Schema.Types.ObjectId, sloId: Schema.Types.ObjectId,
  assigneeIds: [Schema.Types.ObjectId], state: { type: String, enum: ['active', 'resolved', 'stale'], default: 'active' }, severity: String, urgency: String, impact: String, confidence: String,
  detectedAt: Date, lastObservedAt: Date, resolvedAt: Date, sourceRevision: { type: String, required: true }, scoreRevision: String, facts: Schema.Types.Mixed,
  score: { type: Number, min: 0, max: 100 }, scoreGroup: { type: String, enum: ['now', 'soon', 'watch'] }, factors: [factor], explanation: { type: String, maxlength: 600 }, policyVersion: Number,
  observationVersion: { type: Number, default: 1 }, expiresAt: Date,
}, { timestamps: true });
signal.index({ workspaceId: 1, deduplicationKey: 1 }, { unique: true }); signal.index({ workspaceId: 1, state: 1, score: -1, detectedAt: 1, _id: 1 }); signal.index({ workspaceId: 1, assigneeIds: 1, state: 1, score: -1 }); signal.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const OperationalSignalModel = model('OperationalSignal', signal);

const scoreSnapshot = new Schema({ workspaceId: oid, signalId: oid, sourceRevision: String, policyVersion: Number, score: Number, scoreGroup: String, factors: [factor], explanation: String, evaluatedAt: Date, expiresAt: Date }, { timestamps: true });
scoreSnapshot.index({ workspaceId: 1, signalId: 1, sourceRevision: 1, policyVersion: 1 }, { unique: true }); scoreSnapshot.index({ workspaceId: 1, evaluatedAt: -1 }); scoreSnapshot.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const IntelligenceScoreSnapshotModel = model('IntelligenceScoreSnapshot', scoreSnapshot);

const recommendation = new Schema({
  workspaceId: oid, signalId: oid, deduplicationKey: { type: String, required: true }, type: String, explanation: { type: String, maxlength: 400 }, facts: Schema.Types.Mixed, requiredPermission: String, preconditions: [String], deepLink: { type: String, maxlength: 300 },
  state: { type: String, enum: ['open', 'accepted', 'dismissed', 'snoozed', 'completed', 'stale'], default: 'open' }, staleReason: { type: String, enum: ['source', 'expired', 'capacity'] }, operationId: String, policyVersion: Number, sourceVersion: String,
  acceptedAt: Date, dismissedAt: Date, snoozedUntil: Date, completedAt: Date, staleAt: Date, expiresAt: Date, actedBy: Schema.Types.ObjectId,
}, { timestamps: true });
recommendation.index({ workspaceId: 1, deduplicationKey: 1 }, { unique: true }); recommendation.index({ workspaceId: 1, state: 1, expiresAt: 1 });
export const IntelligenceRecommendationModel = model('IntelligenceRecommendation', recommendation);

const evaluation = new Schema({ workspaceId: oid, sourceType: String, sourceId: String, workKey: { type: String, required: true }, sourceRevision: String, retryOperationIds: [String], status: { type: String, enum: ['pending', 'processing', 'completed', 'dead'], default: 'pending' }, availableAt: { type: Date, default: Date.now }, attemptCount: { type: Number, default: 0 }, leaseOwner: String, leaseExpiresAt: Date, error: String, completedAt: Date }, { timestamps: true });
evaluation.index({ workspaceId: 1, workKey: 1 }, { unique: true }); evaluation.index({ status: 1, availableAt: 1, leaseExpiresAt: 1, _id: 1 });
export const IntelligenceEvaluationModel = model('IntelligenceEvaluation', evaluation);

const feedback = new Schema({ workspaceId: oid, recommendationId: oid, operationId: { type: String, required: true }, actorId: oid, action: String, reason: String }, { timestamps: true });
feedback.index({ workspaceId: 1, operationId: 1 }, { unique: true });
export const IntelligenceFeedbackModel = model('IntelligenceFeedback', feedback);

const checkpoint = new Schema({ _id: String, cursor: Schema.Types.ObjectId, lastRunAt: Date, leaseOwner: String, leaseExpiresAt: Date }, { timestamps: true });
export const IntelligenceCheckpointModel = model('IntelligenceCheckpoint', checkpoint);
export const intelligenceModels = [IntelligencePolicyModel, OperationalSignalModel, IntelligenceScoreSnapshotModel, IntelligenceRecommendationModel, IntelligenceEvaluationModel, IntelligenceFeedbackModel, IntelligenceCheckpointModel];
