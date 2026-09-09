import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { AuthSessionModel } from '../models/AuthSession.js';
import { UserModel } from '../models/User.js';

import { authorizationChanged } from './revocation.js';

const accessTokenLifetime = '15m';
const refreshTokenLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const jwtSecret = process.env.JWT_SECRET ?? 'flowryn-development-secret-change-me';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) throw new Error('JWT_SECRET must contain at least 32 characters');

type TokenPayload = { sub: string; type: 'access' | 'refresh'; jti?: string; exp?: number };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const issueTokens = async (userId: string) => {
  const tokenId = randomUUID();
  const accessToken = jwt.sign({ sub: userId, type: 'access', jti: tokenId } satisfies TokenPayload, jwtSecret, {
    expiresIn: accessTokenLifetime,
  });
  const refreshToken = jwt.sign({ sub: userId, type: 'refresh', jti: tokenId } satisfies TokenPayload, jwtSecret, {
    expiresIn: Math.floor(refreshTokenLifetimeMs / 1000),
  });

  await AuthSessionModel.create({
    userId,
    tokenId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + refreshTokenLifetimeMs),
  });

  return { accessToken, refreshToken };
};

export const rotateRefreshToken = async (refreshToken: string) => {
  const payload = jwt.verify(refreshToken, jwtSecret) as TokenPayload;
  if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
    throw new Error('Invalid refresh token');
  }

  const user = await getUserForAuth(payload.sub);
  if (!user || user.status !== 'active') throw new Error('Invalid refresh token');
  const session = await AuthSessionModel.findOneAndUpdate({ tokenId: payload.jti, userId: payload.sub, revokedAt: null, expiresAt: { $gt: new Date() }, refreshTokenHash: hashToken(refreshToken) }, { revokedAt: new Date() });
  if (!session) {
    throw new Error('Invalid refresh token');
  }

  await authorizationChanged({ kind: 'session', userId: payload.sub, tokenId: payload.jti });
  return issueTokens(payload.sub);
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
    AuthSessionModel.exists({ userId: payload.sub, tokenId: payload.jti, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  if (!user || user.status !== 'active' || !session) throw new Error('Authentication required');
  return { user, payload };
};
