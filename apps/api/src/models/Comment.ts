import { Schema, model } from 'mongoose';

const commentSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true, maxlength: 2000 },
  editedAt: { type: Date, default: null },
}, { timestamps: true });
commentSchema.index({ workspaceId: 1, taskId: 1, createdAt: 1 });
export const CommentModel = model('Comment', commentSchema);
