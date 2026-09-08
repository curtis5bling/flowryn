import { Schema, model } from 'mongoose';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

const workspaceMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], required: true },
  },
  { timestamps: true },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const WorkspaceMemberModel = model('WorkspaceMember', workspaceMemberSchema);
