import { Schema, model } from 'mongoose';

const authSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenId: { type: String, required: true, unique: true, index: true },
    refreshTokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    version: { type: Number, default: 0 },
    accessDisabled: { type: Boolean, default: false },
    rotationOperationId: { type: String },
    rotationExpiresAt: { type: Date },
  },
  { timestamps: true },
);

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSessionModel = model('AuthSession', authSessionSchema);
