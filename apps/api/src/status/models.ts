import { Schema, model } from 'mongoose';

const objectId = { type: Schema.Types.ObjectId, required: true };
const audit = { workspaceId: objectId, createdBy: objectId, updatedBy: objectId };
const pageSchema = new Schema(
  {
    ...audit,
    name: { type: String, required: true, maxlength: 100 },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, maxlength: 2000 },
    visibility: { type: String, enum: ['public', 'unlisted', 'private-preview'], required: true },
    enabled: { type: Boolean, default: true },
    timezone: { type: String, required: true },
    branding: { logoUrl: String, primaryColor: String },
    supportUrl: String,
    publishedAt: Date,
    archivedAt: Date,
    version: { type: Number, default: 1 },
    previewTokenHash: { type: String, select: false },
    previewTokenExpiresAt: { type: Date, select: false },
  },
  { timestamps: true },
);
pageSchema.index({ workspaceId: 1, archivedAt: 1 });
pageSchema.index({ visibility: 1, enabled: 1, archivedAt: 1 });
export const StatusPageModel = model('StatusPage', pageSchema);

const groupSchema = new Schema(
  {
    ...audit,
    statusPageId: objectId,
    stableId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    slug: { type: String, required: true },
    order: { type: Number, required: true },
    enabled: Boolean,
    archivedAt: Date,
  },
  { timestamps: true },
);
groupSchema.index({ workspaceId: 1, statusPageId: 1, slug: 1 }, { unique: true });
groupSchema.index(
  { workspaceId: 1, statusPageId: 1, order: 1 },
);
export const StatusGroupModel = model('StatusGroup', groupSchema);

const componentSchema = new Schema(
  {
    ...audit,
    statusPageId: objectId,
    stableId: { type: String, required: true },
    groupId: Schema.Types.ObjectId,
    name: { type: String, required: true },
    description: String,
    slug: { type: String, required: true },
    order: { type: Number, required: true },
    status: {
      type: String,
      enum: ['operational', 'degradedPerformance', 'partialOutage', 'majorOutage', 'maintenance'],
      default: 'operational',
    },
    enabled: Boolean,
    hidden: Boolean,
    archivedAt: Date,
    statusRevision: { type: Number, default: 0 },
    maintenanceReservations: [
      { maintenanceId: Schema.Types.ObjectId, startsAt: Date, endsAt: Date },
    ],
  },
  { timestamps: true },
);
componentSchema.index({ workspaceId: 1, statusPageId: 1, slug: 1 }, { unique: true });
componentSchema.index(
  { workspaceId: 1, statusPageId: 1, order: 1 },
);
export const StatusComponentModel = model('StatusComponent', componentSchema);

const historySchema = new Schema(
  {
    workspaceId: objectId,
    statusPageId: objectId,
    componentId: objectId,
    fromStatus: String,
    toStatus: String,
    source: { type: String, enum: ['manual', 'incident', 'maintenance'], required: true },
    sourceId: Schema.Types.ObjectId,
    revision: Number,
    changedAt: { type: Date, required: true },
    createdBy: objectId,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
historySchema.index({ workspaceId: 1, componentId: 1, changedAt: -1 });
export const StatusHistoryModel = model('StatusHistory', historySchema);

const incidentSchema = new Schema(
  {
    ...audit,
    statusPageId: objectId,
    internalIncidentId: Schema.Types.ObjectId,
    publicTitle: { type: String, required: true },
    publicSummary: { type: String, required: true },
    publicImpact: { type: String, required: true },
    impact: { type: String, enum: ['minor', 'major', 'critical'] },
    status: { type: String, enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
    affectedComponentIds: [Schema.Types.ObjectId],
    publishedAt: Date,
    resolvedAt: Date,
    archivedAt: Date,
  },
  { timestamps: true },
);
incidentSchema.index({ workspaceId: 1, statusPageId: 1, publishedAt: -1 });
export const PublicIncidentModel = model('PublicIncident', incidentSchema);
const updateSchema = new Schema(
  {
    workspaceId: objectId,
    statusPageId: objectId,
    publicIncidentId: objectId,
    status: String,
    message: { type: String, required: true },
    publishedAt: { type: Date, required: true },
    createdBy: objectId,
    correctionOf: Schema.Types.ObjectId,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
updateSchema.index({ workspaceId: 1, publicIncidentId: 1, publishedAt: 1 });
export const PublicIncidentUpdateModel = model('PublicIncidentUpdate', updateSchema);

const maintenanceSchema = new Schema(
  {
    ...audit,
    statusPageId: objectId,
    title: String,
    description: String,
    affectedComponentIds: [Schema.Types.ObjectId],
    scheduledStartAt: Date,
    scheduledEndAt: Date,
    status: {
      type: String,
      enum: ['scheduled', 'inProgress', 'completed', 'cancelled'],
      default: 'scheduled',
    },
    reminderMinutes: [Number],
    reminderKeys: [String],
    nextReminderAt: Date,
    componentSnapshots: [{ componentId: Schema.Types.ObjectId, status: String, revision: Number }],
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true },
);
maintenanceSchema.index({ status: 1, scheduledStartAt: 1, scheduledEndAt: 1 });
maintenanceSchema.index({ workspaceId: 1, statusPageId: 1, scheduledStartAt: -1 });
export const MaintenanceModel = model('StatusMaintenance', maintenanceSchema);

const subscriberSchema = new Schema(
  {
    workspaceId: objectId,
    statusPageId: objectId,
    channel: { type: String, enum: ['email', 'webhook'] },
    addressCiphertext: { type: String, required: true, select: false },
    keyVersion: { type: String, required: true, select: false },
    addressHash: { type: String, required: true },
    componentIds: [Schema.Types.ObjectId],
    incidents: Boolean,
    maintenance: Boolean,
    verificationTokenHash: { type: String, select: false },
    verificationTokenCiphertext: { type: String, select: false },
    verificationKeyVersion: { type: String, select: false },
    verificationExpiresAt: { type: Date, select: false },
    unsubscribeTokenHash: { type: String, select: false },
    unsubscribeTokenCiphertext: { type: String, select: false },
    unsubscribeKeyVersion: { type: String, select: false },
    verifiedAt: Date,
    unsubscribedAt: Date,
    locale: String,
    timezone: String,
  },
  { timestamps: true },
);
subscriberSchema.index({ statusPageId: 1, channel: 1, addressHash: 1 }, { unique: true });
export const StatusSubscriberModel = model('StatusSubscriber', subscriberSchema);

const eventSchema = new Schema(
  {
    workspaceId: objectId,
    statusPageId: objectId,
    eventId: { type: String, unique: true },
    type: String,
    publicPayload: Schema.Types.Mixed,
    targetSubscriberId: Schema.Types.ObjectId,
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'dead'],
      default: 'pending',
    },
    availableAt: { type: Date, default: Date.now },
    attemptCount: { type: Number, default: 0 },
    leaseOwner: String,
    leaseExpiresAt: Date,
    error: String,
  },
  { timestamps: true },
);
eventSchema.index({ status: 1, availableAt: 1, leaseExpiresAt: 1 });
eventSchema.index({ statusPageId: 1, createdAt: 1, _id: 1 });
export const StatusEventModel = model('StatusEvent', eventSchema);
const deliverySchema = new Schema(
  {
    workspaceId: objectId,
    statusPageId: objectId,
    subscriberId: objectId,
    eventId: String,
    idempotencyKey: { type: String, unique: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'dead', 'cancelled'],
      default: 'pending',
    },
    attemptCount: { type: Number, default: 0 },
    availableAt: Date,
    deliveredAt: Date,
    errorCode: String,
  },
  { timestamps: true },
);
deliverySchema.index({ workspaceId: 1, statusPageId: 1, status: 1 });
export const StatusDeliveryModel = model('StatusDelivery', deliverySchema);

export const statusModels = [
  StatusPageModel,
  StatusGroupModel,
  StatusComponentModel,
  StatusHistoryModel,
  PublicIncidentModel,
  PublicIncidentUpdateModel,
  MaintenanceModel,
  StatusSubscriberModel,
  StatusEventModel,
  StatusDeliveryModel,
];
