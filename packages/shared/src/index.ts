import { z } from 'zod';

export const appName = 'Flowryn';
export const appDescription = 'Intelligent Work Orchestration';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('flowryn-api'),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const userStatusSchema = z.enum(['active', 'suspended']);
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  status: userStatusSchema,
});

export const authResponseSchema = z.object({ user: userSchema });

export const registerRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
});

export const loginRequestSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const addWorkspaceMemberRequestSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  role: workspaceRoleSchema.exclude(['owner']),
});

export type User = z.infer<typeof userSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const projectStatusSchema = z.enum(['active', 'archived']);
export const taskStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']);
export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const activityEntityTypeSchema = z.enum(['project', 'task']);

const mongoIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const optionalDateSchema = z.string().datetime().optional().nullable();

export const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  status: projectStatusSchema,
  color: z.string(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const taskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  assigneeId: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  position: z.number(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const activitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  actorId: z.string(),
  entityType: activityEntityTypeSchema,
  entityId: z.string(),
  action: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  timestamp: z.string().datetime(),
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).default(''),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#d7674d'),
});

export const updateProjectRequestSchema = createProjectRequestSchema.partial();
export const projectListQuerySchema = z.object({
  status: projectStatusSchema.default('active'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['createdAt', 'name', 'updatedAt']).default('updatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const createTaskRequestSchema = z.object({
  projectId: mongoIdSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  status: taskStatusSchema.default('backlog'),
  priority: taskPrioritySchema.default('medium'),
  assigneeId: mongoIdSchema.optional().nullable(),
  dueDate: optionalDateSchema,
  position: z.number().finite().optional(),
});

export const updateTaskRequestSchema = createTaskRequestSchema.omit({ projectId: true }).partial();
export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assigneeId: mongoIdSchema.optional().nullable(),
  dueDate: z.enum(['overdue', 'today', 'upcoming']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  sort: z.enum(['position', 'createdAt', 'dueDate', 'priority']).default('position'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const moveTaskRequestSchema = z.object({ status: taskStatusSchema });
export const reorderTaskRequestSchema = z.object({ position: z.number().finite().min(0) });
export const assignTaskRequestSchema = z.object({ assigneeId: mongoIdSchema.optional().nullable() });

export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const commentSchema = z.object({
  id: z.string(), workspaceId: z.string(), projectId: z.string(), taskId: z.string(), authorId: z.string(),
  body: z.string(), editedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const notificationTypeSchema = z.enum(['task_assigned', 'task_status_changed', 'task_commented', 'project_archived']);
export const notificationSchema = z.object({
  id: z.string(), workspaceId: z.string(), recipientId: z.string(), actorId: z.string(), type: notificationTypeSchema,
  entityType: activityEntityTypeSchema, entityId: z.string(), title: z.string(), readAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const realtimeEventNameSchema = z.enum(['task.created', 'task.updated', 'task.moved', 'task.reordered', 'task.assigned', 'task.deleted', 'project.created', 'project.updated', 'project.archived', 'comment.created', 'comment.updated', 'comment.deleted', 'notification.created', 'presence.updated']);
export const realtimeEventSchema = z.object({ eventId: z.string(), timestamp: z.string().datetime(), workspaceId: mongoIdSchema, projectId: mongoIdSchema.optional(), entityId: mongoIdSchema.optional(), actorId: mongoIdSchema, type: realtimeEventNameSchema, payload: z.record(z.string(), z.unknown()) });
export const createCommentRequestSchema = z.object({ body: z.string().trim().min(1).max(2000) });
export const updateCommentRequestSchema = createCommentRequestSchema;
export const notificationListQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional() });
export const commentListQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });
export type Comment = z.infer<typeof commentSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export const socketPayloadSchemas = {
  'workspace:join': mongoIdSchema,
  'workspace:leave': mongoIdSchema,
  'project:join': mongoIdSchema,
  'project:leave': mongoIdSchema,
  'presence:list': mongoIdSchema,
} as const;
export type SocketRequest = keyof typeof socketPayloadSchemas;
export type SocketAcknowledgement = { ok: true; users?: string[] } | { ok: false; error: { code: 'INVALID_PAYLOAD' | 'UNAUTHORIZED' | 'UNAVAILABLE'; message: string } };
