import { Schema, model } from 'mongoose';

const activitySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    entityType: { type: String, enum: ['project', 'task'], required: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    action: { type: String, required: true, maxlength: 80 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
  },
  { _id: true, versionKey: false },
);

activitySchema.index({ workspaceId: 1, entityId: 1, timestamp: -1 });

export const ActivityModel = model('Activity', activitySchema);
