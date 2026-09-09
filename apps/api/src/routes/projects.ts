import {
  assignTaskRequestSchema,
  createProjectRequestSchema,
  createTaskRequestSchema,
  moveTaskRequestSchema,
  projectListQuerySchema,
  reorderTaskRequestSchema,
  taskListQuerySchema,
  updateProjectRequestSchema,
  updateTaskRequestSchema,
} from '@flowryn/shared';
import { Router } from 'express';
import { Types } from 'mongoose';

import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validation.js';
import { ActivityModel } from '../models/Activity.js';
import { CommentModel } from '../models/Comment.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { publishRealtimeEvent } from '../realtime/gateway.js';
import { createNotification } from '../realtime/notifications.js';

const router = Router();

const invalidId = (value: unknown) => typeof value !== 'string' || !Types.ObjectId.isValid(value);
const parseQuery = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } }, query: unknown) => {
  const result = schema.safeParse(query);
  return result.success ? result.data : undefined;
};
const safeMetadata = (metadata: Record<string, unknown>) => Object.fromEntries(
  Object.entries(metadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value === null),
);
const recordActivity = async (workspaceId: string, actorId: string, entityType: 'project' | 'task', entityId: string, action: string, metadata: Record<string, unknown> = {}) => {
  await ActivityModel.create({ workspaceId, actorId, entityType, entityId, action, metadata: safeMetadata(metadata) });
};
const serialize = (document: { id?: string; _id?: unknown; [key: string]: unknown }) => ({ ...document, id: document.id ?? String(document._id) });

const getProject = (workspaceId: string, projectId: string) => ProjectModel.findOne({ _id: projectId, workspaceId });
const getTask = (workspaceId: string, taskId: string) => TaskModel.findOne({ _id: taskId, workspaceId });
const ensureProject = async (workspaceId: string, projectId: string) => {
  if (invalidId(projectId)) return undefined;
  return getProject(workspaceId, projectId);
};
const ensureAssignee = async (workspaceId: string, assigneeId: string | null | undefined) => {
  if (assigneeId === undefined || assigneeId === null) return true;
  if (invalidId(assigneeId)) return false;
  const [membership, user] = await Promise.all([
    WorkspaceMemberModel.exists({ workspaceId, userId: assigneeId, disabled: { $ne: true } }),
    UserModel.exists({ _id: assigneeId, status: 'active' }),
  ]);
  return Boolean(membership && user);
};
const pageResponse = (items: unknown[], total: number, page: number, limit: number) => ({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });

router.get(
  '/:workspaceId/projects',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
  async (request, response) => {
    const query = parseQuery(projectListQuerySchema, request.query);
    if (!query) return response.status(400).json({ error: 'Invalid project filters' });
    const workspaceId = request.params.workspaceId as string;
    const filter = { workspaceId, status: query.status };
    const [projects, total] = await Promise.all([
      ProjectModel.find(filter).sort({ [query.sort]: query.direction === 'asc' ? 1 : -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      ProjectModel.countDocuments(filter),
    ]);
    const counts = await TaskModel.aggregate([
      { $match: { workspaceId: new Types.ObjectId(workspaceId), projectId: { $in: projects.map((project) => project._id) } } },
      { $group: { _id: '$projectId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } } } },
    ]);
    const countMap = new Map(counts.map((count) => [count._id.toString(), count]));
    return response.json(pageResponse(projects.map((project) => ({ ...serialize(project), taskTotal: countMap.get(project._id.toString())?.total ?? 0, completedTasks: countMap.get(project._id.toString())?.done ?? 0 })), total, query.page, query.limit));
  },
);

router.post(
  '/:workspaceId/projects',
  requireAuth,
  requireWorkspaceRole('owner', 'admin'),
  validateBody(createProjectRequestSchema),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const project = await ProjectModel.create({ ...request.body, workspaceId, createdBy: request.auth!.userId });
    await recordActivity(workspaceId, request.auth!.userId, 'project', project.id, 'project.created', { name: project.name });
    publishRealtimeEvent({ workspaceId, projectId: project.id, entityId: project.id, actorId: request.auth!.userId, type: 'project.created', payload: { project: serialize(project.toObject()) } });
    return response.status(201).json({ project: serialize(project.toObject()) });
  },
);

router.get(
  '/:workspaceId/projects/:projectId',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
  async (request, response) => {
    const project = await ensureProject(request.params.workspaceId as string, request.params.projectId as string);
    if (!project) return response.status(404).json({ error: 'Project not found' });
    return response.json({ project: serialize(project.toObject()) });
  },
);

router.patch(
  '/:workspaceId/projects/:projectId',
  requireAuth,
  requireWorkspaceRole('owner', 'admin'),
  validateBody(updateProjectRequestSchema),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const project = await ProjectModel.findOneAndUpdate({ _id: request.params.projectId, workspaceId }, { $set: request.body }, { new: true, runValidators: true });
    if (!project) return response.status(404).json({ error: 'Project not found' });
    await recordActivity(workspaceId, request.auth!.userId, 'project', project.id, 'project.updated', { fields: Object.keys(request.body) });
    publishRealtimeEvent({ workspaceId, projectId: project.id, entityId: project.id, actorId: request.auth!.userId, type: 'project.updated', payload: { project: serialize(project.toObject()) } });
    return response.json({ project: serialize(project.toObject()) });
  },
);

router.delete(
  '/:workspaceId/projects/:projectId',
  requireAuth,
  requireWorkspaceRole('owner', 'admin'),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const project = await ProjectModel.findOneAndUpdate({ _id: request.params.projectId, workspaceId }, { status: 'archived' }, { new: true });
    if (!project) return response.status(404).json({ error: 'Project not found' });
    await recordActivity(workspaceId, request.auth!.userId, 'project', project.id, 'project.archived');
    publishRealtimeEvent({ workspaceId, projectId: project.id, entityId: project.id, actorId: request.auth!.userId, type: 'project.archived', payload: { project: serialize(project.toObject()) } });
    const recipients = await TaskModel.find({ workspaceId, projectId: project.id, assigneeId: { $ne: null } }).distinct('assigneeId');
    await Promise.all(recipients.map((recipientId) => createNotification({ workspaceId, recipientId: String(recipientId), actorId: request.auth!.userId, type: 'project_archived', entityType: 'project', entityId: project.id, title: `Project archived: ${project.name}` })));
    return response.json({ project: serialize(project.toObject()) });
  },
);

router.get(
  '/:workspaceId/projects/:projectId/activity',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const project = await ensureProject(workspaceId, request.params.projectId as string);
    if (!project) return response.status(404).json({ error: 'Project not found' });
    const taskIds = await TaskModel.find({ workspaceId, projectId: project._id }).distinct('_id');
    const activities = await ActivityModel.find({ workspaceId, $or: [{ entityId: project._id }, { entityType: 'task', entityId: { $in: taskIds } }] }).sort({ timestamp: -1 }).limit(100).lean();
    return response.json({ activities: activities.map(serialize) });
  },
);

router.get(
  '/:workspaceId/projects/:projectId/tasks',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const project = await ensureProject(workspaceId, request.params.projectId as string);
    if (!project) return response.status(404).json({ error: 'Project not found' });
    const query = parseQuery(taskListQuerySchema, request.query);
    if (!query) return response.status(400).json({ error: 'Invalid task filters' });
    const filter: Record<string, unknown> = { workspaceId, projectId: project._id };
    if (query.status) filter.status = query.status;
    if (query.priority) filter.priority = query.priority;
    if (query.assigneeId) filter.assigneeId = query.assigneeId;
    if (query.dueDate === 'overdue') filter.dueDate = { $lt: new Date() };
    if (query.dueDate === 'today') { const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1); filter.dueDate = { $gte: start, $lt: end }; }
    if (query.dueDate === 'upcoming') filter.dueDate = { $gte: new Date() };
    const [tasks, total] = await Promise.all([
      TaskModel.find(filter).sort({ [query.sort]: query.direction === 'asc' ? 1 : -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      TaskModel.countDocuments(filter),
    ]);
    return response.json(pageResponse(tasks.map(serialize), total, query.page, query.limit));
  },
);

router.post(
  '/:workspaceId/projects/:projectId/tasks',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
  validateBody(createTaskRequestSchema.omit({ projectId: true })),
  async (request, response) => {
    const workspaceId = request.params.workspaceId as string;
    const projectId = request.params.projectId as string;
    const project = await ensureProject(workspaceId, projectId);
    if (!project || project.status === 'archived') return response.status(404).json({ error: 'Active project not found' });
    const body = request.body as Record<string, unknown>;
    if (!await ensureAssignee(workspaceId, body.assigneeId as string | null | undefined)) return response.status(400).json({ error: 'Assignee is not an active workspace member' });
    const position = typeof body.position === 'number' ? body.position : ((await TaskModel.find({ workspaceId, projectId, status: body.status }).sort({ position: -1 }).limit(1).lean())[0]?.position ?? -1) + 1;
    const task = await TaskModel.create({ ...body, workspaceId, projectId, position, createdBy: request.auth!.userId });
    await recordActivity(workspaceId, request.auth!.userId, 'task', task.id, 'task.created', { projectId, title: task.title });
    publishRealtimeEvent({ workspaceId, projectId, entityId: task.id, actorId: request.auth!.userId, type: 'task.created', payload: { task: serialize(task.toObject()) } });
    if (task.assigneeId) await createNotification({ workspaceId, recipientId: task.assigneeId.toString(), actorId: request.auth!.userId, type: 'task_assigned', entityType: 'task', entityId: task.id, title: `You were assigned ${task.title}` });
    return response.status(201).json({ task: serialize(task.toObject()) });
  },
);

router.get('/:workspaceId/tasks/:taskId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), async (request, response) => {
  const task = await getTask(request.params.workspaceId as string, request.params.taskId as string);
  if (!task) return response.status(404).json({ error: 'Task not found' });
  return response.json({ task: serialize(task.toObject()) });
});

router.patch('/:workspaceId/tasks/:taskId', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(updateTaskRequestSchema), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const body = request.body as Record<string, unknown>;
  const previous = await getTask(workspaceId, request.params.taskId as string);
  if (!previous) return response.status(404).json({ error: 'Task not found' });
  if (!await ensureAssignee(workspaceId, body.assigneeId as string | null | undefined)) return response.status(400).json({ error: 'Assignee is not an active workspace member' });
  const task = await TaskModel.findOneAndUpdate({ _id: request.params.taskId, workspaceId }, { $set: body }, { new: true, runValidators: true });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  await recordActivity(workspaceId, request.auth!.userId, 'task', task.id, 'task.updated', { fields: Object.keys(body) });
  publishRealtimeEvent({ workspaceId, projectId: task.projectId.toString(), entityId: task.id, actorId: request.auth!.userId, type: 'task.updated', payload: { task: serialize(task.toObject()) } });
  if (task.assigneeId && String(previous.assigneeId) !== String(task.assigneeId)) await createNotification({ workspaceId, recipientId: String(task.assigneeId), actorId: request.auth!.userId, type: 'task_assigned', entityType: 'task', entityId: task.id, title: `You were assigned ${task.title}` });
  if (task.assigneeId && previous.status !== task.status) await createNotification({ workspaceId, recipientId: String(task.assigneeId), actorId: request.auth!.userId, type: 'task_status_changed', entityType: 'task', entityId: task.id, title: `Task moved to ${task.status}` });
  return response.json({ task: serialize(task.toObject()) });
});

router.delete('/:workspaceId/tasks/:taskId', requireAuth, requireWorkspaceRole('owner', 'admin'), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const task = await TaskModel.findOneAndDelete({ _id: request.params.taskId, workspaceId });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  await recordActivity(workspaceId, request.auth!.userId, 'task', task.id, 'task.deleted', { projectId: task.projectId.toString() });
  await CommentModel.deleteMany({ workspaceId, taskId: task.id });
  publishRealtimeEvent({ workspaceId, projectId: task.projectId.toString(), entityId: task.id, actorId: request.auth!.userId, type: 'task.deleted', payload: { taskId: task.id } });
  return response.status(204).send();
});

router.patch('/:workspaceId/tasks/:taskId/status', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(moveTaskRequestSchema), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const task = await getTask(workspaceId, request.params.taskId as string);
  if (!task) return response.status(404).json({ error: 'Task not found' });
  const nextStatus = request.body.status as 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
  const nextPosition = ((await TaskModel.find({ workspaceId, projectId: task.projectId, status: nextStatus }).sort({ position: -1 }).limit(1).lean())[0]?.position ?? -1) + 1;
  const previousStatus = task.status;
  task.status = nextStatus;
  task.position = nextPosition;
  await task.save();
  await recordActivity(workspaceId, request.auth!.userId, 'task', task.id, 'task.moved', { fromStatus: previousStatus, toStatus: nextStatus });
  publishRealtimeEvent({ workspaceId, projectId: task.projectId.toString(), entityId: task.id, actorId: request.auth!.userId, type: 'task.moved', payload: { task: serialize(task.toObject()) } });
  if (task.assigneeId) await createNotification({ workspaceId, recipientId: task.assigneeId.toString(), actorId: request.auth!.userId, type: 'task_status_changed', entityType: 'task', entityId: task.id, title: `Task moved to ${nextStatus}` });
  return response.json({ task: serialize(task.toObject()) });
});

router.patch('/:workspaceId/tasks/:taskId/reorder', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(reorderTaskRequestSchema), async (request, response) => {
  const task = await TaskModel.findOneAndUpdate({ _id: request.params.taskId, workspaceId: request.params.workspaceId }, { position: request.body.position }, { new: true });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  await recordActivity(request.params.workspaceId as string, request.auth!.userId, 'task', task.id, 'task.reordered', { position: task.position });
  publishRealtimeEvent({ workspaceId: request.params.workspaceId as string, projectId: task.projectId.toString(), entityId: task.id, actorId: request.auth!.userId, type: 'task.reordered', payload: { task: serialize(task.toObject()) } });
  return response.json({ task: serialize(task.toObject()) });
});

router.patch('/:workspaceId/tasks/:taskId/assignee', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'), validateBody(assignTaskRequestSchema), async (request, response) => {
  const workspaceId = request.params.workspaceId as string;
  const assigneeId = request.body.assigneeId as string | null | undefined;
  if (!await ensureAssignee(workspaceId, assigneeId)) return response.status(400).json({ error: 'Assignee is not an active workspace member' });
  const task = await TaskModel.findOneAndUpdate({ _id: request.params.taskId, workspaceId }, { assigneeId: assigneeId ?? null }, { new: true });
  if (!task) return response.status(404).json({ error: 'Task not found' });
  await recordActivity(workspaceId, request.auth!.userId, 'task', task.id, assigneeId ? 'task.assigned' : 'task.unassigned', { assigneeId: assigneeId ?? null });
  publishRealtimeEvent({ workspaceId, projectId: task.projectId.toString(), entityId: task.id, actorId: request.auth!.userId, type: 'task.assigned', payload: { task: serialize(task.toObject()) } });
  if (assigneeId) await createNotification({ workspaceId, recipientId: assigneeId, actorId: request.auth!.userId, type: 'task_assigned', entityType: 'task', entityId: task.id, title: `You were assigned ${task.title}` });
  return response.json({ task: serialize(task.toObject()) });
});

export default router;
