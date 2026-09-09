import { Schema, model } from 'mongoose';

const notificationSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['task_assigned', 'task_status_changed', 'task_commented', 'project_archived'], required: true },
  entityType: { type: String, enum: ['project', 'task'], required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, required: true, maxlength: 240 },
  readAt: { type: Date, default: null },
}, { timestamps: true });
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ workspaceId: 1, recipientId: 1, createdAt: -1 });
export const NotificationModel = model('Notification', notificationSchema);
