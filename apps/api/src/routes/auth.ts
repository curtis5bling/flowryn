import { loginRequestSchema, registerRequestSchema } from '@flowryn/shared';
import bcrypt from 'bcryptjs';
import { Router, type Response } from 'express';

import { issueTokens, revokeRefreshToken, rotateRefreshToken, RotationUnavailable } from '../auth/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { UserModel } from '../models/User.js';
import { CoordinationUnavailable, RevocationIncomplete } from '../realtime/coordination.js';

const router = Router();
const accessCookie = 'accessToken';
const refreshCookie = 'refreshToken';
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
};

const publicUser = (user: { _id?: unknown; id?: string; name: string; email: string; status: string }) => ({
  id: user.id ?? String(user._id),
  name: user.name,
  email: user.email,
  status: user.status,
});

const setAuthCookies = (response: Response, tokens: { accessToken: string; refreshToken: string }) => {
  response.cookie(accessCookie, tokens.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
  response.cookie(refreshCookie, tokens.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth' });
};

router.post('/register', validateBody(registerRequestSchema), async (request, response) => {
  const { name, email, password } = request.body as { name: string; email: string; password: string };
  const existingUser = await UserModel.exists({ email });
  if (existingUser) {
    response.status(409).json({ error: 'An account with that email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await UserModel.create({ name, email, passwordHash });
  const tokens = await issueTokens(user.id);
  setAuthCookies(response, tokens);
  response.status(201).json({ user: publicUser(user) });
});

router.post('/login', validateBody(loginRequestSchema), async (request, response) => {
  const { email, password } = request.body as { email: string; password: string };
  const user = await UserModel.findOne({ email }).select('+passwordHash');
  const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordMatches || user.status !== 'active') {
    response.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const tokens = await issueTokens(user.id);
  setAuthCookies(response, tokens);
  response.json({ user: publicUser(user) });
});

router.post('/refresh', async (request, response) => {
  try {
    const tokens = await rotateRefreshToken(request.cookies?.[refreshCookie]);
    setAuthCookies(response, tokens);
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof CoordinationUnavailable) { response.status(503).json({ error: error.message, code: error instanceof RevocationIncomplete || error instanceof RotationUnavailable ? error.code : 'COORDINATION_UNAVAILABLE' }); return; }
    response.status(401).json({ error: 'Refresh token expired or invalid' });
  }
});

router.post('/logout', async (request, response) => {
  await revokeRefreshToken(request.cookies?.[refreshCookie]);
  response.clearCookie(accessCookie, cookieOptions);
  response.clearCookie(refreshCookie, { ...cookieOptions, path: '/api/auth' });
  response.status(204).send();
});

router.get('/me', requireAuth, async (request, response) => {
  const user = await UserModel.findById(request.auth!.userId);
  if (!user) {
    response.status(401).json({ error: 'Authentication required' });
    return;
  }
  response.json({ user: publicUser(user) });
});

export default router;
