import { Schema, model } from 'mongoose';

const taskSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 5000 },
    status: { type: String, enum: ['backlog', 'todo', 'in_progress', 'review', 'done'], default: 'backlog', required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium', required: true },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dueDate: { type: Date, default: null },
    position: { type: Number, required: true, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

taskSchema.index({ workspaceId: 1, projectId: 1, status: 1, position: 1 });
taskSchema.index({ workspaceId: 1, status: 1, priority: 1, assigneeId: 1 });
taskSchema.index({ workspaceId: 1, dueDate: 1 });

export const TaskModel = model('Task', taskSchema);
