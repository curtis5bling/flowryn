import { randomUUID } from 'node:crypto';

import {
  createTaskRequestSchema,
  incidentIdSchema,
  updateTaskRequestSchema,
} from '@flowryn/shared';
import mongoose, { type ClientSession } from 'mongoose';

import { assertIncident, incidentActor, validateIncidentMembers } from '../incidents/service.js';
import { ActivityModel } from '../models/Activity.js';
import { NotificationModel } from '../models/Notification.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';
import { publishNotification, publishRealtimeEvent } from '../realtime/gateway.js';

import { emitDomainEvent } from './outbox.js';
import { automationActorId, automationPrincipal, type AutomationContext } from './principal.js';

export const executeTask = async (input: {
  workspaceId: string;
  actorId: string;
  projectId?: string;
  taskId?: string;
  fields: unknown;
  session?: ClientSession;
  automation?: AutomationContext;
  operationId?: string;
  realtimeType?: 'task.updated' | 'task.assigned' | 'task.moved';
}) => {
  incidentIdSchema.parse(input.workspaceId);
  if (input.taskId) incidentIdSchema.parse(input.taskId);
  if (input.projectId) incidentIdSchema.parse(input.projectId);
  const fields = input.taskId
    ? updateTaskRequestSchema.strict().parse(input.fields)
    : createTaskRequestSchema
        .strict()
        .parse({ ...(input.fields as object), projectId: input.projectId });
  const session = input.session ?? (await mongoose.startSession());
  const operationId = input.operationId ?? randomUUID();
  try {
    const transaction = async () => {
      const system =
        input.automation?.principal === automationPrincipal && input.actorId === automationActorId;
      if (input.automation) assertIncident(system, 403, 'System action denied');
      if (system && input.taskId)
        assertIncident(
          Object.keys(fields).every((key) =>
            ['title', 'priority', 'status', 'assigneeId'].includes(key),
          ),
          403,
          'System task field denied',
        );
      if (!system) await incidentActor(input.workspaceId, input.actorId, session);
      if (fields.assigneeId)
        await validateIncidentMembers(input.workspaceId, [fields.assigneeId], session);
      const previous = input.taskId
        ? await TaskModel.findOne({ workspaceId: input.workspaceId, _id: input.taskId }).session(
            session,
          )
        : null;
      if (input.taskId) assertIncident(previous, 404, 'Task not found');
      const projectId = previous ? String(previous.projectId) : input.projectId!;
      const project = await ProjectModel.findOne({
        workspaceId: input.workspaceId,
        _id: projectId,
      }).session(session);
      assertIncident(project && project.status === 'active', 404, 'Active project not found');
      await ProjectModel.updateOne(
        { workspaceId: input.workspaceId, _id: project._id, status: 'active' },
        { $inc: { __v: 1 } },
        { session },
      );
      const priorStatus = previous?.status;
      const priorAssignee = previous?.assigneeId ? String(previous.assigneeId) : null;
      const task =
        previous ??
        new TaskModel({ workspaceId: input.workspaceId, projectId, createdBy: input.actorId });
      task.set(fields);
      if (!previous || (fields.status && fields.status !== priorStatus)) {
        const last = await TaskModel.findOne({
          workspaceId: input.workspaceId,
          projectId,
          status: task.status,
        })
          .sort({ position: -1 })
          .session(session);
        if (fields.position === undefined) task.position = (last?.position ?? -1) + 1;
      }
      if (previous) task.increment();
      await task.save({ session });
      await ActivityModel.create(
        [
          {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            entityType: 'task',
            entityId: task.id,
            action: previous ? 'task.updated' : 'task.created',
            metadata: {
              projectId,
              ...(system
                ? {
                    executionIdentity: 'flowryn:automation:v1',
                    configuredBy: input.automation!.configuredBy,
                    initiatedBy: input.automation!.initiatedBy,
                  }
                : {}),
            },
          },
        ],
        { session },
      );
      const payload = {
        actorId: input.actorId,
        taskId: task.id,
        projectId,
        taskStatus: task.status,
        assigneeId: task.assigneeId ? String(task.assigneeId) : null,
      };
      const types = previous
        ? [
            ...(priorAssignee !== payload.assigneeId ? ['task.assigned'] : []),
            ...(priorStatus !== task.status ? ['task.statusChanged'] : []),
          ]
        : ['task.created', ...(payload.assigneeId ? ['task.assigned'] : [])];
      for (const eventType of types)
        await emitDomainEvent(session, {
          workspaceId: input.workspaceId,
          aggregateType: 'task',
          aggregateId: task.id,
          eventType,
          eventId: `${operationId}:${eventType}`,
          payload,
          context: input.automation,
        });
      const notify =
        payload.assigneeId &&
        (priorAssignee !== payload.assigneeId || priorStatus !== task.status) &&
        payload.assigneeId !== input.actorId;
      if (notify)
        await NotificationModel.create(
          [
            {
              workspaceId: input.workspaceId,
              recipientId: payload.assigneeId,
              actorId: input.actorId,
              entityType: 'task',
              entityId: task.id,
              operationId,
              type: priorAssignee !== payload.assigneeId ? 'task_assigned' : 'task_status_changed',
              title:
                priorAssignee !== payload.assigneeId
                  ? `You were assigned ${task.title}`
                  : `Task moved to ${task.status}`,
            },
          ],
          { session },
        );
      return { task, recipient: notify ? payload.assigneeId : null };
    };
    const result = input.session ? await transaction() : await session.withTransaction(transaction);
    assertIncident(result, 503, 'Task transaction unavailable');
    if (!input.session) {
      publishRealtimeEvent({
        workspaceId: input.workspaceId,
        projectId: String(result.task.projectId),
        entityId: result.task.id,
        actorId: input.actorId,
        type: input.taskId ? (input.realtimeType ?? 'task.updated') : 'task.created',
        payload: { task: { ...result.task.toObject(), id: result.task.id } },
      });
      if (result.recipient)
        publishNotification(result.recipient, {
          workspaceId: input.workspaceId,
          entityId: result.task.id,
          actorId: input.actorId,
          type: 'notification.created',
          payload: {},
        });
    }
    return result.task;
  } finally {
    if (!input.session) await session.endSession();
  }
};
