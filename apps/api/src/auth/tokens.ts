import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { AuthSessionModel } from '../models/AuthSession.js';
import { UserModel } from '../models/User.js';

const accessTokenLifetime = '15m';
const refreshTokenLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const jwtSecret = process.env.JWT_SECRET ?? 'flowryn-development-secret-change-me';

type TokenPayload = { sub: string; type: 'access' | 'refresh'; jti?: string };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const issueTokens = async (userId: string) => {
  const accessToken = jwt.sign({ sub: userId, type: 'access' } satisfies TokenPayload, jwtSecret, {
    expiresIn: accessTokenLifetime,
  });
  const tokenId = randomUUID();
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

  const session = await AuthSessionModel.findOne({ tokenId: payload.jti, userId: payload.sub });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.refreshTokenHash !== hashToken(refreshToken)) {
    throw new Error('Invalid refresh token');
  }

  session.revokedAt = new Date();
  await session.save();
  return issueTokens(payload.sub);
};

export const revokeRefreshToken = async (refreshToken?: string) => {
  if (!refreshToken) return;
  try {
    const payload = jwt.verify(refreshToken, jwtSecret) as TokenPayload;
    if (payload.jti) await AuthSessionModel.updateOne({ tokenId: payload.jti }, { revokedAt: new Date() });
  } catch {
    // Logout is intentionally idempotent for expired or malformed cookies.
  }
};

export const verifyAccessToken = (token: string) => {
  const payload = jwt.verify(token, jwtSecret) as TokenPayload;
  if (payload.type !== 'access' || !payload.sub) throw new Error('Invalid access token');
  return payload;
};

export const getUserForAuth = (userId: string) => UserModel.findById(userId).select('_id status');
