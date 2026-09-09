import { Schema, model } from 'mongoose';

import { installRevocationHooks } from '../auth/model-revocation.js';
import { onAuthorizationChange } from '../auth/revocation.js';

import { AuthSessionModel } from './AuthSession.js';

export type UserStatus = 'active' | 'suspended';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  },
  { timestamps: true },
);

installRevocationHooks(userSchema, 'user');
export const UserModel = model('User', userSchema);
// Session invalidation also applies when no gateway is running.
onAuthorizationChange(async (change) => {
  if (change.kind === 'user' && !await UserModel.exists({ _id: change.userId, status: 'active' })) {
    await AuthSessionModel.updateMany({ userId: change.userId }, { revokedAt: new Date() });
  }
});
