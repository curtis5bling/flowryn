import { commentListQuerySchema, createCommentRequestSchema, notificationListQuerySchema, updateCommentRequestSchema } from '@flowryn/shared';
import { Router } from 'express';

import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { CommentModel } from '../models/Comment.js';
import { NotificationModel } from '../models/Notification.js';
import { TaskModel } from '../models/Task.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { publishRealtimeEvent } from '../realtime/gateway.js';
import { createNotification } from '../realtime/notifications.js';

const router = Router();
router.use('/:workspaceId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'));
const serialize = (document: { id?: string; _id?: unknown; [key: string]: unknown }) => ({ ...document, id: document.id ?? String(document._id) });
const page = (items: unknown[], total: number, current: number, limit: number) => ({ items, pagination: { page: current, limit, total, pages: Math.ceil(total / limit) } });

const taskInWorkspace = async (workspaceId: string, projectId: string, taskId: string) => TaskModel.findOne({ _id: taskId, projectId, workspaceId });

router.get('/:workspaceId/projects/:projectId/tasks/:taskId/comments', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const projectId = request.params.projectId as string;
  const task = await taskInWorkspace(workspaceId, projectId, request.params.taskId as string);
  if (!task) return response.status(404).json({ error: 'Task not found' });
  const query = commentListQuerySchema.safeParse(request.query);
  if (!query.success) return response.status(400).json({ error: 'Invalid comment query' });
  const { page: current, limit } = query.data;
  const [comments, total] = await Promise.all([
    CommentModel.find({ workspaceId, projectId, taskId: task._id }).sort({ createdAt: 1 }).skip((current - 1) * limit).limit(limit).populate('authorId', 'name email').lean(),
    CommentModel.countDocuments({ workspaceId, projectId, taskId: task._id }),
  ]);
  return response.json(page(comments.map(serialize), total, current, limit));
});

router.post('/:workspaceId/projects/:projectId/tasks/:taskId/comments', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(createCommentRequestSchema), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const projectId = request.params.projectId as string;
  const task = await taskInWorkspace(workspaceId, projectId, request.params.taskId as string);
  if (!task) return response.status(404).json({ error: 'Task not found' });
  const comment = await CommentModel.create({ workspaceId, projectId, taskId: task.id, authorId: request.auth!.userId, body: request.body.body });
  const result = await CommentModel.findById(comment.id).populate('authorId', 'name email').lean();
  publishRealtimeEvent({ workspaceId, projectId, entityId: comment.id, actorId: request.auth!.userId, type: 'comment.created', payload: { comment: serialize(result!) } });
  if (task.assigneeId) await createNotification({ workspaceId, recipientId: task.assigneeId.toString(), actorId: request.auth!.userId, type: 'task_commented', entityType: 'task', entityId: task.id, title: 'New comment on an assigned task' });
  return response.status(201).json({ comment: serialize(result!) });
});

router.patch('/:workspaceId/comments/:commentId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(updateCommentRequestSchema), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const comment = await CommentModel.findOne({ _id: request.params.commentId, workspaceId });
  if (!comment) return response.status(404).json({ error: 'Comment not found' });
  const isModerator = ['owner', 'admin'].includes(request.workspaceMembership!.role);
  if (!isModerator && comment.authorId.toString() !== request.auth!.userId) return response.status(403).json({ error: 'Comment modification denied' });
  comment.body = request.body.body;
  comment.editedAt = new Date();
  await comment.save();
  publishRealtimeEvent({ workspaceId, projectId: comment.projectId.toString(), entityId: comment.id, actorId: request.auth!.userId, type: 'comment.updated', payload: { comment: serialize(comment.toObject()) } });
  return response.json({ comment: serialize(comment.toObject()) });
});

router.delete('/:workspaceId/comments/:commentId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const comment = await CommentModel.findOne({ _id: request.params.commentId, workspaceId });
  if (!comment) return response.status(404).json({ error: 'Comment not found' });
  const isModerator = ['owner', 'admin'].includes(request.workspaceMembership!.role);
  if (!isModerator && comment.authorId.toString() !== request.auth!.userId) return response.status(403).json({ error: 'Comment deletion denied' });
  await comment.deleteOne();
  publishRealtimeEvent({ workspaceId, projectId: comment.projectId.toString(), entityId: comment.id, actorId: request.auth!.userId, type: 'comment.deleted', payload: {} });
  return response.status(204).send();
});

router.get('/:workspaceId/notifications', requireAuth, async (request, response) => {
  const query = notificationListQuerySchema.safeParse(request.query);
  if (!query.success) return response.status(400).json({ error: 'Invalid notification query' });
  const filter: Record<string, unknown> = { workspaceId: request.params.workspaceId, recipientId: request.auth!.userId };
  if (query.data.unread) filter.readAt = null;
  const [items, total] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).skip((query.data.page - 1) * query.data.limit).limit(query.data.limit).lean(),
    NotificationModel.countDocuments(filter),
  ]);
  return response.json(page(items.map(serialize), total, query.data.page, query.data.limit));
});

router.get('/:workspaceId/notifications/unread-count', requireAuth, async (request, response) => {
  const count = await NotificationModel.countDocuments({ workspaceId: request.params.workspaceId, recipientId: request.auth!.userId, readAt: null });
  response.json({ count });
});

router.patch('/:workspaceId/notifications/:notificationId/read', requireAuth, async (request, response) => {
  const notification = await NotificationModel.findOneAndUpdate({ _id: request.params.notificationId, workspaceId: request.params.workspaceId, recipientId: request.auth!.userId }, { readAt: new Date() }, { new: true });
  if (!notification) return response.status(404).json({ error: 'Notification not found' });
  response.json({ notification: serialize(notification.toObject()) });
});

router.post('/:workspaceId/notifications/read-all', requireAuth, async (request, response) => {
  await NotificationModel.updateMany({ workspaceId: request.params.workspaceId, recipientId: request.auth!.userId, readAt: null }, { readAt: new Date() });
  response.status(204).send();
});

router.get('/:workspaceId/presence', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), async (request, response) => {
  const { getPresenceState } = await import('../realtime/gateway.js');
  const state = await getPresenceState(request.params.workspaceId as string);
  const activeMembers = await WorkspaceMemberModel.find({ workspaceId: request.params.workspaceId, disabled: { $ne: true } }).populate('userId', 'name status').lean();
  const visible = activeMembers.filter((member) => (member.userId as { status?: string } | null)?.status === 'active');
  const entries = visible.map((member) => {
    const user = member.userId as unknown as { _id: unknown; name: string };
    const userId = String(user._id);
    const online = state.users.includes(userId);
    return { userId, name: user.name, online, lastSeen: online ? null : state.lastSeen[userId] ?? null };
  });
  response.json({ members: entries.filter((entry) => entry.online).map((entry) => ({ userId: { _id: entry.userId, name: entry.name } })), presence: entries });
});

export default router;
