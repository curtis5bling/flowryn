import type { RequestHandler } from 'express';

import { getUserForAuth, verifyAccessToken } from '../auth/tokens.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

export const requireAuth: RequestHandler = async (request, response, next) => {
  const bearerToken = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : undefined;
  const token = request.cookies?.accessToken ?? bearerToken;
  if (!token) {
    response.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    const user = await getUserForAuth(payload.sub);
    if (!user || user.status !== 'active') {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    request.auth = { userId: user.id, status: user.status };
    next();
  } catch {
    response.status(401).json({ error: 'Authentication required' });
  }
};

export const requireWorkspaceRole = (...roles: Array<'owner' | 'admin' | 'member'>): RequestHandler => async (
  request,
  response,
  next,
) => {
  if (!request.auth) {
    response.status(401).json({ error: 'Authentication required' });
    return;
  }
  const workspaceId = request.params.workspaceId;
  if (typeof workspaceId !== 'string') {
    response.status(400).json({ error: 'Workspace id is required' });
    return;
  }
  const membership = await WorkspaceMemberModel.findOne({ workspaceId, userId: request.auth.userId }).select('role');
  if (!membership || !roles.includes(membership.role)) {
    response.status(403).json({ error: 'Workspace access denied' });
    return;
  }
  request.workspaceMembership = { workspaceId, role: membership.role };
  next();
};
