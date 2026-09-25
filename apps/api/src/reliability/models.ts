import { Schema, model } from 'mongoose';

const objectId = { type: Schema.Types.ObjectId, required: true };
const audit = { workspaceId: objectId, createdBy: objectId, updatedBy: objectId };
const serviceSchema = new Schema({ ...audit, name: { type: String, required: true }, slug: { type: String, required: true }, description: String, lifecycle: { type: String, enum: ['active', 'deprecated', 'retired'], index: true }, criticality: { type: String, enum: ['tier1', 'tier2', 'tier3', 'tier4'], index: true }, ownerIds: [Schema.Types.ObjectId], projectIds: [Schema.Types.ObjectId], labels: Schema.Types.Mixed, links: [{ label: String, url: String }], version: { type: Number, default: 1 }, archivedAt: Date }, { timestamps: true });
serviceSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });
serviceSchema.index({ workspaceId: 1, ownerIds: 1, archivedAt: 1 });
export const ServiceModel = model('Service', serviceSchema);

const dependencySchema = new Schema({ workspaceId: objectId, upstreamServiceId: objectId, downstreamServiceId: objectId, type: String, criticality: String, description: String, enabled: Boolean, createdBy: objectId, archivedAt: Date }, { timestamps: true });
dependencySchema.index({ workspaceId: 1, upstreamServiceId: 1, downstreamServiceId: 1 }, { unique: true });
dependencySchema.index({ workspaceId: 1, downstreamServiceId: 1, enabled: 1 });
export const ServiceDependencyModel = model('ServiceDependency', dependencySchema);

const graphLockSchema = new Schema({ workspaceId: { ...objectId, unique: true }, revision: { type: Number, default: 0 } }, { timestamps: true });
export const ReliabilityGraphLockModel = model('ReliabilityGraphLock', graphLockSchema);

const relationshipSchema = new Schema({ workspaceId: objectId, serviceId: objectId, targetType: String, targetId: objectId, createdBy: objectId, archivedAt: Date }, { timestamps: true });
relationshipSchema.index({ workspaceId: 1, serviceId: 1, targetType: 1, targetId: 1 }, { unique: true });
export const ServiceRelationshipModel = model('ServiceRelationship', relationshipSchema);

const sloSchema = new Schema({ ...audit, objectiveKey: { type: String, required: true }, serviceId: objectId, name: String, description: String, enabled: Boolean, indicatorType: String, objectiveTarget: Number, rollingWindowDays: Number, latencyThresholdMs: Number, percentile: Number, dataSource: Schema.Types.Mixed, missingDataPolicy: String, burnRateAlerts: [Schema.Types.Mixed], version: { type: Number, required: true }, nextEvaluationAt: Date, lastEvaluationAt: Date, evaluationLeaseOwner: String, evaluationLeaseExpiresAt: Date, archivedAt: Date }, { timestamps: true });
sloSchema.index({ workspaceId: 1, serviceId: 1, archivedAt: 1 });
sloSchema.index({ workspaceId: 1, objectiveKey: 1, version: 1 }, { unique: true });
sloSchema.index({ enabled: 1, archivedAt: 1, nextEvaluationAt: 1, evaluationLeaseExpiresAt: 1 });
export const ServiceLevelObjectiveModel = model('ServiceLevelObjective', sloSchema);

const sampleSchema = new Schema({ workspaceId: objectId, serviceId: objectId, sloId: objectId, sloVersion: Number, bucketAt: Date, timestamp: Date, good: Number, total: Number, latencyMs: [Number], source: String, sourceId: String, idempotencyKey: String, metadata: Schema.Types.Mixed, expiresAt: Date }, { timestamps: true });
sampleSchema.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true });
sampleSchema.index({ workspaceId: 1, sloId: 1, timestamp: 1 });
sampleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SliSampleModel = model('SliSample', sampleSchema);

const evaluationSchema = new Schema({ workspaceId: objectId, serviceId: objectId, sloId: objectId, objectiveKey: String, sloVersion: Number, windowStart: Date, windowEnd: Date, shortWindowStart: Date, longWindowStart: Date, burnWindows: [Schema.Types.Mixed], state: String, good: Number, total: Number, compliance: Number, remainingBudget: Number, consumption: Number, shortBurnRate: Number, longBurnRate: Number, breaching: Boolean, breachedAt: Date, recoveredAt: Date }, { timestamps: true });
evaluationSchema.index({ workspaceId: 1, sloId: 1, windowEnd: -1 });
evaluationSchema.index({ sloId: 1, sloVersion: 1, windowEnd: 1 }, { unique: true });
export const SloEvaluationModel = model('SloEvaluation', evaluationSchema);

const monitorSchema = new Schema({ ...audit, serviceId: objectId, sloId: Schema.Types.ObjectId, name: String, enabled: Boolean, url: String, method: String, intervalSeconds: Number, timeoutMs: Number, maxRedirects: Number, expectedStatusMin: Number, expectedStatusMax: Number, textAssertion: String, secretCiphertext: { type: String, select: false }, secretKeyVersion: { type: String, select: false }, configVersion: { type: Number, default: 1 }, nextRunAt: Date, retryScheduledAt: Date, leaseOwner: String, leaseExpiresAt: Date, failureCount: { type: Number, default: 0 }, health: { type: String, default: 'unknown' }, archivedAt: Date }, { timestamps: true });
monitorSchema.index({ enabled: 1, archivedAt: 1, nextRunAt: 1, leaseExpiresAt: 1 });
monitorSchema.index({ workspaceId: 1, serviceId: 1, archivedAt: 1 });
export const SyntheticMonitorModel = model('SyntheticMonitor', monitorSchema);

const runSchema = new Schema({ workspaceId: objectId, serviceId: objectId, monitorId: objectId, scheduledAt: Date, idempotencyKey: String, status: { type: String, enum: ['queued', 'running', 'completed', 'retrying', 'deadLetter'] }, endpointHealthy: Boolean, statusCode: Number, latencyMs: Number, errorCode: String, attemptCount: { type: Number, default: 0 }, nextAttemptAt: Date, leaseOwner: String, leaseExpiresAt: Date, startedAt: Date, completedAt: Date }, { timestamps: true });
runSchema.index({ monitorId: 1, idempotencyKey: 1 }, { unique: true });
runSchema.index({ workspaceId: 1, monitorId: 1, scheduledAt: -1 });
runSchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });
export const SyntheticMonitorRunModel = model('SyntheticMonitorRun', runSchema);

export const reliabilityModels = [ServiceModel, ServiceDependencyModel, ReliabilityGraphLockModel, ServiceRelationshipModel, ServiceLevelObjectiveModel, SliSampleModel, SloEvaluationModel, SyntheticMonitorModel, SyntheticMonitorRunModel];
