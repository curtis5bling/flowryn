import { Schema, model } from 'mongoose';

import { installRevocationHooks } from '../auth/model-revocation.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

const workspaceMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], required: true },
    disabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

installRevocationHooks(workspaceMemberSchema, 'membership');
export const WorkspaceMemberModel = model('WorkspaceMember', workspaceMemberSchema);
