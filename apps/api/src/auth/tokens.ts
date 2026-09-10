import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { AuthSessionModel } from '../models/AuthSession.js';
import { UserModel } from '../models/User.js';
import { CoordinationUnavailable, coordinationLog } from '../realtime/coordination.js';

import { authorizationChanged } from './revocation.js';

const accessTokenLifetime = '15m';
const refreshTokenLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const jwtSecret = process.env.JWT_SECRET ?? 'flowryn-development-secret-change-me';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) throw new Error('JWT_SECRET must contain at least 32 characters');

type TokenPayload = { sub: string; type: 'access' | 'refresh'; jti?: string; exp?: number };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const credentials = (userId: string, tokenId: string) => {
  const accessToken = jwt.sign({ sub: userId, type: 'access', jti: tokenId } satisfies TokenPayload, jwtSecret, {
    expiresIn: accessTokenLifetime,
  });
  const refreshToken = jwt.sign({ sub: userId, type: 'refresh', jti: tokenId } satisfies TokenPayload, jwtSecret, {
    expiresIn: Math.floor(refreshTokenLifetimeMs / 1000),
  });

  return { accessToken, refreshToken };
};

export const issueTokens = async (userId: string) => {
  const tokenId = randomUUID();
  const { accessToken, refreshToken } = credentials(userId, tokenId);
  await AuthSessionModel.create({
    userId,
    tokenId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + refreshTokenLifetimeMs),
  });

  return { accessToken, refreshToken };
};

export const rotationLeaseMs = 30000;
export class RotationUnavailable extends CoordinationUnavailable {
  readonly code = 'ROTATION_UNAVAILABLE';
  constructor() { super(); this.message = 'Session rotation temporarily unavailable; retry the same refresh token'; }
}

export const rotateRefreshToken = async (refreshToken: string) => {
  const payload = jwt.verify(refreshToken, jwtSecret) as TokenPayload;
  if (payload.type !== 'refresh' || !payload.jti || !/^[a-f\d]{24}$/i.test(payload.sub)) throw new Error('Invalid refresh token');
  let user;
  try { user = await getUserForAuth(payload.sub); } catch { throw new RotationUnavailable(); }
  if (!user || user.status !== 'active') throw new Error('Invalid refresh token');
  const operationId = randomUUID();
  const identity = { tokenId: payload.jti, userId: payload.sub, revokedAt: null, refreshTokenHash: hashToken(refreshToken), $expr: { $gt: ['$expiresAt', '$$NOW'] } };
  let session;
  try {
    session = await AuthSessionModel.findOneAndUpdate({ ...identity, $or: [
      { rotationOperationId: { $exists: false } }, { $expr: { $lte: ['$rotationExpiresAt', '$$NOW'] } },
    ] }, [{ $set: { rotationOperationId: operationId, rotationExpiresAt: { $add: ['$$NOW', rotationLeaseMs] }, accessDisabled: true } }], { new: true }).maxTimeMS(5000);
  } catch { throw new RotationUnavailable(); }
  if (!session) {
    // A live claim is retryable, not evidence of token replay.
    let active;
    try { active = await AuthSessionModel.exists(identity).maxTimeMS(5000); } catch { throw new RotationUnavailable(); }
    if (active) throw new RotationUnavailable();
    throw new Error('Invalid refresh token');
  }
  const tokenId = randomUUID();
  const replacement = credentials(payload.sub, tokenId);
  let commitAttempted = false;
  try {
    await authorizationChanged({ kind: 'session', userId: payload.sub, tokenId: payload.jti });
    // One compare-and-swap commits the generation and hash on the SAME session.
    // A stale lease owner, concurrent logout, or another winner cannot commit.
    commitAttempted = true;
    const committed = await AuthSessionModel.findOneAndUpdate({ ...identity, rotationOperationId: operationId,
      $expr: { $and: [{ $gt: ['$expiresAt', '$$NOW'] }, { $gt: ['$rotationExpiresAt', '$$NOW'] }] },
    }, { $set: { tokenId, refreshTokenHash: hashToken(replacement.refreshToken), accessDisabled: false, expiresAt: new Date(Date.now() + refreshTokenLifetimeMs) },
      $inc: { version: 1 }, $unset: { rotationOperationId: '', rotationExpiresAt: '' },
    }, { new: true }).maxTimeMS(5000);
    if (!committed) throw new RotationUnavailable();
    return replacement;
  } catch (error) {
    // A write response can be lost after MongoDB committed. Return credentials
    // only if a read confirms this exact candidate generation was committed.
    if (commitAttempted) {
      try {
        const confirmed = await AuthSessionModel.exists({ _id: session._id, tokenId, refreshTokenHash: hashToken(replacement.refreshToken), revokedAt: null, accessDisabled: false }).maxTimeMS(5000);
        if (confirmed) return replacement;
      } catch { /* An unconfirmed commit must never issue credentials. */ }
    }
    // Never restore old access credentials: only the refresh hash remains valid.
    // A new generation on retry cannot match quarantine for the old token ID.
    try { await AuthSessionModel.updateOne({ _id: session._id, rotationOperationId: operationId }, { $unset: { rotationOperationId: '', rotationExpiresAt: '' } }).maxTimeMS(5000); }
    catch { coordinationLog('rotation_cleanup_deferred_to_lease'); }
    coordinationLog('rotation_retry_required');
    if (error instanceof CoordinationUnavailable) throw error;
    throw new RotationUnavailable();
  }
};

export const revokeRefreshToken = async (refreshToken?: string) => {
  if (!refreshToken) return;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(refreshToken, jwtSecret) as TokenPayload;
  } catch { return; }
  if (payload.jti) {
    await AuthSessionModel.updateOne({ tokenId: payload.jti }, { revokedAt: new Date() });
    await authorizationChanged({ kind: 'session', userId: payload.sub, tokenId: payload.jti });
  }
};

export const verifyAccessToken = (token: string) => {
  const payload = jwt.verify(token, jwtSecret) as TokenPayload;
  if (payload.type !== 'access' || !/^[a-f\d]{24}$/i.test(payload.sub) || !payload.jti || !Number.isFinite(payload.exp) || payload.exp! * 1000 <= Date.now()) throw new Error('Invalid access token');
  return payload;
};

export const getUserForAuth = (userId: string) => UserModel.findById(userId).select('_id status');

export const authenticateAccessToken = async (token: string) => {
  const payload = verifyAccessToken(token);
  const [user, session] = await Promise.all([
    getUserForAuth(payload.sub),
    AuthSessionModel.exists({ userId: payload.sub, tokenId: payload.jti, accessDisabled: { $ne: true }, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  if (!user || user.status !== 'active' || !session) throw new Error('Authentication required');
  return { user, payload };
};
