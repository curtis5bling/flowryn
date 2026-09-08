import { addWorkspaceMemberRequestSchema, createWorkspaceRequestSchema } from '@flowryn/shared';
import { Router } from 'express';

import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { UserModel } from '../models/User.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

const router = Router();

router.get('/', requireAuth, async (request, response) => {
  const memberships = await WorkspaceMemberModel.find({ userId: request.auth!.userId }).select('workspaceId role');
  const workspaces = await WorkspaceModel.find({ _id: { $in: memberships.map((membership) => membership.workspaceId) } }).select('name');
  response.json({
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: memberships.find((membership) => membership.workspaceId.equals(workspace._id))?.role,
    })),
  });
});

router.post('/', requireAuth, validateBody(createWorkspaceRequestSchema), async (request, response) => {
  const { name } = request.body as { name: string };
  const workspace = await WorkspaceModel.create({ name, createdBy: request.auth!.userId });
  const membership = await WorkspaceMemberModel.create({ workspaceId: workspace.id, userId: request.auth!.userId, role: 'owner' });
  response.status(201).json({ workspace: { id: workspace.id, name: workspace.name }, role: membership.role });
});

router.get('/:workspaceId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), async (request, response) => {
  const workspace = await WorkspaceModel.findById(request.params.workspaceId).select('name createdBy');
  if (!workspace) {
    response.status(404).json({ error: 'Workspace not found' });
    return;
  }
  response.json({ workspace: { id: workspace.id, name: workspace.name, createdBy: workspace.createdBy }, role: request.workspaceMembership!.role });
});

router.post(
  '/:workspaceId/members',
  requireAuth,
  requireWorkspaceRole('owner', 'admin'),
  validateBody(addWorkspaceMemberRequestSchema),
  async (request, response) => {
    const { email, role } = request.body as { email: string; role: 'admin' | 'member' };
    const user = await UserModel.findOne({ email });
    if (!user) {
      response.status(404).json({ error: 'User not found' });
      return;
    }
    const existingMember = await WorkspaceMemberModel.exists({ workspaceId: request.params.workspaceId, userId: user.id });
    if (existingMember) {
      response.status(409).json({ error: 'User is already a workspace member' });
      return;
    }
    const membership = await WorkspaceMemberModel.create({ workspaceId: request.params.workspaceId, userId: user.id, role });
    response.status(201).json({ member: { userId: membership.userId, role: membership.role } });
  },
);

export default router;
