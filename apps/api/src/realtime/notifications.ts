import { NotificationModel } from '../models/Notification.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';

import { publishNotification } from './gateway.js';

export const createNotification = async (input: {
  workspaceId: string; recipientId: string; actorId: string; type: 'task_assigned' | 'task_status_changed' | 'task_commented' | 'project_archived';
  entityType: 'project' | 'task'; entityId: string; title: string;
}) => {
  if (input.recipientId === input.actorId) return undefined;
  const [membership, activeUser] = await Promise.all([
    WorkspaceMemberModel.exists({ workspaceId: input.workspaceId, userId: input.recipientId, disabled: { $ne: true } }),
    UserModel.exists({ _id: input.recipientId, status: 'active' }),
  ]);
  if (!membership || !activeUser) return undefined;
  const notification = await NotificationModel.create(input);
  publishNotification(input.recipientId, {
    workspaceId: input.workspaceId,
    projectId: input.entityType === 'project' ? input.entityId : undefined,
    entityId: input.entityId,
    actorId: input.actorId,
    type: 'notification.created',
    payload: { notificationId: notification.id, title: input.title },
  });
  return notification;
};
