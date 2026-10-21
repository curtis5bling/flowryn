import { Schema, model } from 'mongoose';

const oid = { type: Schema.Types.ObjectId, required: true };
const environment = new Schema({ workspaceId: oid, name: { type: String, maxlength: 100 }, slug: { type: String, maxlength: 80 }, tier: { type: String, enum: ['development', 'staging', 'production'] }, description: { type: String, maxlength: 500 }, serviceIds: [Schema.Types.ObjectId], active: { type: Boolean, default: true }, archivedAt: Date, createdBy: oid }, { timestamps: true });
environment.index({ workspaceId: 1, slug: 1 }, { unique: true });
environment.index({ workspaceId: 1, active: 1, _id: 1 });
export const DeploymentEnvironmentModel = model('DeploymentEnvironment', environment);

const release = new Schema({
  workspaceId: oid, projectId: Schema.Types.ObjectId, serviceIds: [Schema.Types.ObjectId], environmentId: oid,
  version: { type: String, maxlength: 100 }, title: { type: String, maxlength: 200 }, source: String, sourceRevision: { type: String, maxlength: 160 }, externalId: { type: String, maxlength: 160 }, idempotencyKey: { type: String, maxlength: 160 },
  requestHash: { type: String, required: true, select: false },
  revision: { type: Number, default: 1 }, state: { type: String, enum: ['planned', 'ready', 'deploying', 'completed', 'failed', 'cancelled', 'rolled_back'], default: 'planned' }, sequence: { type: Number, default: 0 }, lastEventAt: Date,
  metadata: Schema.Types.Mixed, emergency: Boolean, rollbackPlanRef: { type: String, maxlength: 300 }, plannedAt: Date, completedAt: Date, createdBy: oid, archivedAt: Date,
}, { timestamps: true });
release.index({ workspaceId: 1, externalId: 1 }, { unique: true }); release.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true }); release.index({ workspaceId: 1, environmentId: 1, createdAt: -1, _id: -1 });
export const ChangeReleaseModel = model('ChangeRelease', release);

const history = new Schema({ workspaceId: oid, releaseId: oid, revision: Number, state: String, sourceRevision: String, sequence: Number, occurredAt: Date, eventId: String, actorId: Schema.Types.ObjectId }, { timestamps: true });
history.index({ workspaceId: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } }); history.index({ workspaceId: 1, releaseId: 1, revision: 1 }, { unique: true });
export const ChangeDeploymentHistoryModel = model('ChangeDeploymentHistory', history);

const policy = new Schema({ workspaceId: oid, version: Number, name: String, configuration: Schema.Types.Mixed, createdBy: oid, active: { type: Boolean, default: false }, activatedBy: Schema.Types.ObjectId, activatedAt: Date, replacedAt: Date }, { timestamps: true });
policy.index({ workspaceId: 1, version: 1 }, { unique: true }); policy.index({ workspaceId: 1, active: 1 });
export const ChangePolicyModel = model('ChangePolicy', policy);

const factor = new Schema({ key: String, value: Number, bound: Number, weight: Number, contribution: Number, unknown: Boolean, explanation: { type: String, maxlength: 200 } }, { _id: false });
const risk = new Schema({ workspaceId: oid, releaseId: oid, releaseRevision: Number, policyVersion: Number, observationKey: String, score: { type: Number, min: 0, max: 100 }, band: String, factors: [factor], explanation: { type: String, maxlength: 800 }, evaluatedAt: Date, lastRefreshedAt: Date }, { timestamps: true });
risk.index({ workspaceId: 1, releaseId: 1, releaseRevision: 1, policyVersion: 1, observationKey: 1 }, { unique: true });
export const ChangeRiskModel = model('ChangeRisk', risk);

const approval = new Schema({ workspaceId: oid, releaseId: oid, releaseRevision: Number, riskId: oid, policyVersion: Number, attempt: { type: Number, default: 1 }, state: { type: String, enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'superseded'], default: 'pending' }, requiredCount: Number, requesterId: oid, decisions: [{ actorId: Schema.Types.ObjectId, decision: String, reason: String, operationId: String, decidedAt: Date }], expiresAt: Date }, { timestamps: true });
approval.index({ workspaceId: 1, releaseId: 1, releaseRevision: 1, policyVersion: 1, attempt: 1 }, { unique: true }); approval.index({ workspaceId: 1, state: 1, expiresAt: 1 });
export const ChangeApprovalModel = model('ChangeApproval', approval);

const health = new Schema({ workspaceId: oid, releaseId: oid, releaseRevision: Number, phase: { type: String, enum: ['pre', 'post'] }, observationKey: String, classification: { type: String, enum: ['healthy', 'degraded', 'failed', 'unknown'] }, evidence: Schema.Types.Mixed, sourceRevisions: Schema.Types.Mixed, evaluatedAt: Date, lastRefreshedAt: Date, humanConfirmedBy: Schema.Types.ObjectId }, { timestamps: true });
health.index({ workspaceId: 1, releaseId: 1, releaseRevision: 1, phase: 1, observationKey: 1 }, { unique: true });
export const ChangeHealthModel = model('ChangeHealth', health);

const correlation = new Schema({ workspaceId: oid, releaseId: oid, releaseRevision: Number, deploymentRevision: Number, policyVersion: Number, sourceType: String, sourceId: String, sourceRevision: String, state: { type: String, enum: ['candidate', 'confirmed', 'rejected', 'expired', 'stale'], default: 'candidate' }, confidence: String, evidence: Schema.Types.Mixed, operationId: String, decidedBy: Schema.Types.ObjectId, decidedAt: Date, expiresAt: Date }, { timestamps: true });
correlation.index({ workspaceId: 1, releaseId: 1, releaseRevision: 1, sourceType: 1, sourceId: 1 }, { unique: true });
export const ChangeCorrelationModel = model('ChangeCorrelation', correlation);

const work = new Schema({ workspaceId: oid, kind: String, entityId: oid, operationKey: { type: String, required: true }, sourceRevision: String, retryOperationIds: [String], status: { type: String, enum: ['pending', 'processing', 'completed', 'dead'], default: 'pending' }, availableAt: { type: Date, default: Date.now }, attemptCount: { type: Number, default: 0 }, leaseOwner: String, leaseExpiresAt: Date, error: String, completedAt: Date }, { timestamps: true });
work.index({ workspaceId: 1, operationKey: 1 }, { unique: true }); work.index({ status: 1, availableAt: 1, leaseExpiresAt: 1, _id: 1 });
export const ChangeWorkModel = model('ChangeWork', work);

const receipt = new Schema({ workspaceId: oid, operationId: String, kind: String, entityId: oid, actorId: Schema.Types.ObjectId, payloadHash: String }, { timestamps: true });
receipt.index({ workspaceId: 1, operationId: 1 }, { unique: true });
export const ChangeOperationReceiptModel = model('ChangeOperationReceipt', receipt);
const checkpoint = new Schema({ _id: String, cursor: Schema.Types.ObjectId, lastRunAt: Date, leaseOwner: String, leaseExpiresAt: Date }, { timestamps: true });
export const ChangeCheckpointModel = model('ChangeCheckpoint', checkpoint);
export const changeModels = [DeploymentEnvironmentModel, ChangeReleaseModel, ChangeDeploymentHistoryModel, ChangePolicyModel, ChangeRiskModel, ChangeApprovalModel, ChangeHealthModel, ChangeCorrelationModel, ChangeWorkModel, ChangeOperationReceiptModel, ChangeCheckpointModel];
