import { Schema, model } from 'mongoose';

const projectSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', required: true },
    color: { type: String, default: '#d7674d', match: /^#[0-9a-f]{6}$/i },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

projectSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
projectSchema.index({ workspaceId: 1, name: 1 });

export const ProjectModel = model('Project', projectSchema);
