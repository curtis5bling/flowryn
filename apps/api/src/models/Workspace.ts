import { Schema, model } from 'mongoose';

const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    automationRevision: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const WorkspaceModel = model('Workspace', workspaceSchema);
