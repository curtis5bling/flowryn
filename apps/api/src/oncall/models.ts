import { Schema, model } from 'mongoose';
const workspaceId = { type: Schema.Types.ObjectId, required: true };
const human = { type: Schema.Types.ObjectId, required: true };
const config = {
  workspaceId,
  name: { type: String, required: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  enabled: Boolean,
  createdBy: human,
  updatedBy: human,
  version: { type: Number, default: 1 },
  archivedAt: { type: Date, default: null },
};
const schedule = new Schema(
  {
    ...config,
    timezone: { type: String, required: true },
    allowSelfOverrides: Boolean,
    layers: { type: [Schema.Types.Mixed], required: true },
    overrideRevision: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schedule.index({ workspaceId: 1, enabled: 1, archivedAt: 1 });
export const ScheduleModel = model('OncallSchedule', schedule);
const override = new Schema(
  {
    workspaceId,
    scheduleId: { type: Schema.Types.ObjectId, required: true },
    layerId: { type: String, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    originalUserId: Schema.Types.ObjectId,
    replacementUserId: human,
    reason: { type: String, maxlength: 500 },
    createdBy: human,
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);
override.index({
  workspaceId: 1,
  scheduleId: 1,
  layerId: 1,
  cancelledAt: 1,
  startsAt: 1,
  endsAt: 1,
});
export const OverrideModel = model('ScheduleOverride', override);
const policy = new Schema(
  {
    ...config,
    steps: { type: [Schema.Types.Mixed], required: true },
    repeatCount: Number,
    repeatDelayMinutes: Number,
  },
  { timestamps: true },
);
policy.index({ workspaceId: 1, enabled: 1, archivedAt: 1 });
export const PolicyModel = model('EscalationPolicy', policy);
const route = new Schema(
  {
    ...config,
    priority: { type: Number, required: true },
    policyId: human,
    conditions: { type: [Schema.Types.Mixed], required: true },
  },
  { timestamps: true },
);
route.index({ workspaceId: 1, enabled: 1, archivedAt: 1, priority: 1, _id: 1 });
export const RoutingModel = model('AlertRoutingRule', route);
const alert = new Schema(
  {
    workspaceId,
    sourceIntegrationId: Schema.Types.ObjectId,
    externalEventId: { type: String, maxlength: 160 },
    fingerprint: { type: String, required: true, maxlength: 160 },
    title: { type: String, required: true, maxlength: 200 },
    summary: { type: String, maxlength: 4000 },
    severity: { type: String, enum: ['sev1', 'sev2', 'sev3', 'sev4'], required: true },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'resolved', 'suppressed'],
      default: 'open',
    },
    occurrenceCount: { type: Number, default: 1 },
    firstReceivedAt: { type: Date, required: true },
    lastReceivedAt: { type: Date, required: true },
    acknowledgedAt: Date,
    acknowledgedBy: Schema.Types.ObjectId,
    acknowledgedStep: Number,
    resolvedAt: Date,
    resolvedBy: Schema.Types.ObjectId,
    suppressionEndsAt: Date,
    escalationPolicyId: Schema.Types.ObjectId,
    escalationPolicyVersion: Number,
    linkedIncidentId: Schema.Types.ObjectId,
    projectId: Schema.Types.ObjectId,
    serviceId: { type: String, maxlength: 100 },
    labels: { type: Schema.Types.Mixed, default: {} },
    correlationId: { type: String, required: true },
    cycle: { type: Number, default: 0 },
    dispatchRevision: { type: Number, default: 0 },
    createdBy: human,
  },
  { timestamps: true },
);
alert.index({ workspaceId: 1, fingerprint: 1 }, { unique: true });
alert.index({ workspaceId: 1, status: 1, severity: 1, lastReceivedAt: -1 });
alert.index({ workspaceId: 1, escalationPolicyId: 1, lastReceivedAt: -1 });
alert.index({ workspaceId: 1, sourceIntegrationId: 1, externalEventId: 1 });
alert.index({ status: 1, suppressionEndsAt: 1 });
export const AlertModel = model('Alert', alert);
const receipt = new Schema(
  {
    workspaceId,
    operationId: { type: String, required: true },
    requestHash: { type: String, required: true, select: false },
    alertId: human,
    actorId: human,
  },
  { timestamps: true },
);
receipt.index({ workspaceId: 1, operationId: 1 }, { unique: true });
export const AlertReceiptModel = model('AlertReceipt', receipt);
const execution = new Schema(
  {
    workspaceId,
    alertId: human,
    alertCycle: { type: Number, required: true },
    policyId: human,
    policyVersion: Number,
    policySnapshot: { type: Schema.Types.Mixed, required: true, select: false },
    currentStep: { type: Number, default: 0 },
    repeatIndex: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'cancelled', 'dead'],
      default: 'queued',
    },
    nextEscalationAt: { type: Date, required: true },
    attemptCount: { type: Number, default: 0 },
    stepAttemptCount: { type: Number, default: 0 },
    retryDeliveryId: Schema.Types.ObjectId,
    configuredBy: Schema.Types.ObjectId,
    initiatedBy: Schema.Types.ObjectId,
    correlationId: String,
    causationId: String,
    chainDepth: Number,
    rulePath: [String],
    leaseOwner: String,
    leaseExpiresAt: Date,
    error: { type: String, maxlength: 200 },
    completedAt: Date,
  },
  { timestamps: true },
);
execution.index({ workspaceId: 1, alertId: 1, alertCycle: 1 }, { unique: true });
execution.index({ status: 1, nextEscalationAt: 1, leaseExpiresAt: 1 });
execution.index({ workspaceId: 1, alertId: 1, createdAt: -1 });
export const EscalationModel = model('EscalationExecution', execution);
const delivery = new Schema(
  {
    workspaceId,
    alertId: human,
    executionId: human,
    step: Number,
    cycle: Number,
    deliveryKey: { type: String, required: true },
    channel: { type: String, enum: ['notification', 'webhook', 'gap'], required: true },
    recipients: { type: [String], default: [] },
    integrationId: Schema.Types.ObjectId,
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'cancelled', 'dead'],
      default: 'pending',
    },
    attemptCount: { type: Number, default: 0 },
    error: { type: String, maxlength: 200 },
    statusCode: Number,
    deliveredAt: Date,
  },
  { timestamps: true },
);
delivery.index({ workspaceId: 1, deliveryKey: 1 }, { unique: true });
delivery.index({ workspaceId: 1, alertId: 1, createdAt: -1 });
delivery.index({ workspaceId: 1, status: 1, createdAt: -1 });
export const EscalationDeliveryModel = model('EscalationDelivery', delivery);
export const oncallModels = [
  ScheduleModel,
  OverrideModel,
  PolicyModel,
  RoutingModel,
  AlertModel,
  AlertReceiptModel,
  EscalationModel,
  EscalationDeliveryModel,
];
