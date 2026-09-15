import { Schema, model } from 'mongoose';

const workspaceId = { type: Schema.Types.ObjectId, required: true };
const human = { type: Schema.Types.ObjectId, required: true };
const lease = {
  leaseOwner: String,
  leaseExpiresAt: Date,
  availableAt: { type: Date, default: Date.now },
  attemptCount: { type: Number, default: 0 },
  error: { type: String, maxlength: 200 },
};
const rule = new Schema(
  {
    workspaceId,
    name: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 2000 },
    enabled: Boolean,
    triggerType: { type: String, required: true },
    triggerVersion: { type: Number, required: true },
    inboundIntegrationId: Schema.Types.ObjectId,
    conditions: { type: Schema.Types.Mixed, required: true },
    actions: { type: [Schema.Types.Mixed], required: true },
    createdBy: human,
    updatedBy: human,
    version: { type: Number, default: 1 },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
rule.index({ workspaceId: 1, enabled: 1, archivedAt: 1, triggerType: 1 });
rule.index({ workspaceId: 1, updatedAt: -1 });
export const AutomationRuleModel = model('AutomationRule', rule);
const outbox = new Schema(
  {
    workspaceId,
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    requestHash: { type: String, select: false },
    schemaVersion: { type: Number, default: 1 },
    aggregateType: { type: String, required: true },
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    correlationId: { type: String, required: true },
    causationId: String,
    chainDepth: { type: Number, default: 0 },
    rulePath: { type: [String], default: [] },
    targetRuleId: Schema.Types.ObjectId,
    initiatedBy: Schema.Types.ObjectId,
    status: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'dead'],
      default: 'pending',
    },
    ...lease,
    processedAt: Date,
    cleanupAt: Date,
  },
  { timestamps: true },
);
outbox.index({ workspaceId: 1, eventId: 1 }, { unique: true });
outbox.index({ status: 1, availableAt: 1, leaseExpiresAt: 1 });
outbox.index({ workspaceId: 1, status: 1, createdAt: -1 });
outbox.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });
export const OutboxEventModel = model('OutboxEvent', outbox);
const run = new Schema(
  {
    workspaceId,
    ruleId: { type: Schema.Types.ObjectId, required: true },
    ruleVersion: { type: Number, required: true },
    ruleSnapshot: { type: Schema.Types.Mixed, required: true, select: false },
    triggerEventId: { type: String, required: true },
    correlationId: String,
    causationId: String,
    chainDepth: Number,
    rulePath: [String],
    configuredBy: human,
    initiatedBy: Schema.Types.ObjectId,
    executionIdentity: { type: String, default: 'flowryn:automation:v1' },
    status: {
      type: String,
      enum: ['queued', 'running', 'skipped', 'succeeded', 'partiallyFailed', 'failed', 'cancelled'],
      default: 'queued',
    },
    triggerSnapshot: { type: Schema.Types.Mixed, required: true },
    actionResults: { type: [Schema.Types.Mixed], required: true },
    cycleAttemptCount: { type: Number, default: 0 },
    ...lease,
    startedAt: Date,
    completedAt: Date,
    failedAt: Date,
    cancelledAt: Date,
    cleanupAt: Date,
  },
  { timestamps: true },
);
run.index({ workspaceId: 1, ruleId: 1, triggerEventId: 1 }, { unique: true });
run.index({ status: 1, availableAt: 1, leaseExpiresAt: 1 });
run.index({ workspaceId: 1, ruleId: 1, createdAt: -1 });
run.index({ workspaceId: 1, status: 1, createdAt: -1 });
run.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });
export const AutomationRunModel = model('AutomationRun', run);
const integration = new Schema(
  {
    workspaceId,
    name: { type: String, required: true, maxlength: 200 },
    type: { type: String, default: 'genericWebhook' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    endpoint: { type: String, maxlength: 2048 },
    inboundEvents: [String],
    outboundEvents: [String],
    credentials: { type: String, required: true, select: false },
    keyVersion: { type: String, required: true },
    secretVersion: { type: Number, default: 1 },
    createdBy: human,
    updatedBy: human,
    lastDeliveryAt: Date,
    lastDeliveryStatus: String,
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
integration.index({ workspaceId: 1, status: 1, archivedAt: 1 });
export const IntegrationModel = model('Integration', integration);
const delivery = new Schema(
  {
    workspaceId,
    integrationId: { type: Schema.Types.ObjectId, required: true },
    deliveryId: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: String,
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
    statusCode: Number,
    ...lease,
    cleanupAt: Date,
  },
  { timestamps: true },
);
delivery.index({ workspaceId: 1, integrationId: 1, direction: 1, deliveryId: 1 }, { unique: true });
delivery.index({ workspaceId: 1, integrationId: 1, createdAt: -1 });
delivery.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });
export const WebhookDeliveryModel = model('WebhookDelivery', delivery);
const bucket = new Schema({ _id: String, count: Number, expiresAt: Date }, { versionKey: false });
bucket.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const InboundBucketModel = model('InboundBucket', bucket);
export const automationModels = [
  AutomationRuleModel,
  AutomationRunModel,
  OutboxEventModel,
  IntegrationModel,
  WebhookDeliveryModel,
  InboundBucketModel,
];
