import { createHash } from 'node:crypto';

import {
  canTransitionIncident,
  type IncidentCommand,
  type IncidentStatus,
  type RealtimeEvent,
  type declareIncidentSchema,
} from '@flowryn/shared';
import mongoose, { type ClientSession } from 'mongoose';
import type { z } from 'zod';

import { ActivityModel } from '../models/Activity.js';
import { IncidentCounterModel, IncidentModel } from '../models/Incident.js';
import { IncidentEventModel } from '../models/IncidentEvent.js';
import { NotificationModel } from '../models/Notification.js';
import { ProjectModel } from '../models/Project.js';
import { RunbookModel } from '../models/Runbook.js';
import { TaskModel } from '../models/Task.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { publishNotification, publishRealtimeEvent } from '../realtime/gateway.js';

export class IncidentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assertIncident(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new IncidentError(status, message);
}
export const serializeIncident = (document: {
  toObject(options?: { flattenMaps?: boolean }): object;
  _id: { toString(): string };
}) => ({ ...document.toObject({ flattenMaps: true }), id: document._id.toString() });
export const incidentActor = async (
  workspaceId: string,
  actorId: string,
  session?: ClientSession,
) => {
  const user = await UserModel.findOne({ _id: actorId, status: 'active' }).session(session ?? null);
  const member = await WorkspaceMemberModel.findOne({
    workspaceId,
    userId: actorId,
    disabled: { $ne: true },
  }).session(session ?? null);
  assertIncident(user && member, 403, 'Workspace access denied');
  return { admin: ['owner', 'admin'].includes(member.role) };
};
export const validateIncidentMembers = async (
  workspaceId: string,
  ids: string[],
  session?: ClientSession,
) => {
  const unique = [...new Set(ids)];
  const members = await WorkspaceMemberModel.find({
    workspaceId,
    userId: { $in: unique },
    disabled: { $ne: true },
  }).session(session ?? null);
  const users = await UserModel.find({ _id: { $in: unique }, status: 'active' }).session(
    session ?? null,
  );
  assertIncident(
    unique.every(
      (id) =>
        members.some((member) => String(member.userId) === id) &&
        users.some((user) => user.id === id),
    ),
    400,
    'Assignments must be active workspace members',
  );
};
const validateLinks = async (
  workspaceId: string,
  projects: string[],
  tasks: string[],
  session: ClientSession,
) => {
  assertIncident(
    (await ProjectModel.countDocuments({ workspaceId, _id: { $in: projects } }).session(
      session,
    )) === projects.length,
    400,
    'Invalid workspace project link',
  );
  assertIncident(
    (await TaskModel.countDocuments({ workspaceId, _id: { $in: tasks } }).session(session)) ===
      tasks.length,
    400,
    'Invalid workspace task link',
  );
};

type Declaration = z.infer<typeof declareIncidentSchema>;
type CommandInput = {
  workspaceId: string;
  actorId: string;
  incidentId?: string;
  declaration?: Declaration;
  mutation?: IncidentCommand;
};
export const executeIncident = async (input: CommandInput) => {
  const { workspaceId, actorId, incidentId, declaration, mutation } = input;
  const operationId = declaration?.operationId ?? mutation!.operationId;
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  if (declaration) {
    // Seed outside the transaction; increments themselves are transactional.
    try {
      await IncidentCounterModel.updateOne(
        { _id: workspaceId },
        { $setOnInsert: { value: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const actor = await incidentActor(workspaceId, actorId, session);
      const previous = await IncidentEventModel.findOne({ workspaceId, operationId })
        .select('+requestHash')
        .session(session);
      if (previous) {
        assertIncident(
          previous.actorId === actorId && previous.requestHash === requestHash,
          409,
          'Operation ID already used',
        );
        const incident = await IncidentModel.findOne({
          workspaceId,
          _id: previous.incidentId,
        }).session(session);
        assertIncident(incident, 404, 'Incident not found');
        return {
          incident,
          replay: true,
          type: previous.eventType as RealtimeEvent['type'],
          recipients: [] as string[],
        };
      }
      let incident;
      let type: RealtimeEvent['type'] = 'incident.updated';
      let message = 'Incident updated';
      let previousValue: string | null = null;
      let nextValue: string | null = null;
      let mentions: string[] = [];
      const metadata: Record<string, string> = {};
      if (declaration) {
        assertIncident(
          actor.admin || (!declaration.commanderId && !declaration.responderIds.length),
          403,
          'Only workspace administrators may assign a response team during declaration',
        );
        await validateIncidentMembers(
          workspaceId,
          [
            ...declaration.responderIds,
            ...(declaration.commanderId ? [declaration.commanderId] : []),
          ],
          session,
        );
        await validateLinks(
          workspaceId,
          declaration.linkedProjectIds,
          declaration.linkedTaskIds,
          session,
        );
        const counter = await IncidentCounterModel.findOneAndUpdate(
          { _id: workspaceId },
          { $inc: { value: 1 } },
          { new: true, session },
        );
        assertIncident(counter, 503, 'Incident counter unavailable');
        incident = new IncidentModel({
          workspaceId,
          incidentNumber: `INC-${String(counter.value).padStart(6, '0')}`,
          title: declaration.title,
          summary: declaration.summary,
          impact: declaration.impact,
          severity: declaration.severity,
          commanderId: declaration.commanderId ?? null,
          responderIds: declaration.responderIds,
          linkedProjectIds: declaration.linkedProjectIds,
          linkedTaskIds: declaration.linkedTaskIds,
          declaredBy: actorId,
          declaredAt: new Date(),
        });
        type = 'incident.declared';
        message = 'Incident declared';
      } else {
        incident = await IncidentModel.findOne({ workspaceId, _id: incidentId }).session(session);
        assertIncident(incident, 404, 'Incident not found');
        const command = mutation!.command;
        const control = actor.admin || incident.commanderId === actorId;
        assertIncident(
          !incident.archivedAt || command.action === 'archive',
          409,
          'Archived incidents are read-only',
        );
        if (command.action === 'archive')
          assertIncident(actor.admin, 403, 'Only workspace administrators may archive incidents');
        else if (command.action === 'step')
          assertIncident(
            control || incident.responderIds.includes(actorId),
            403,
            'Response team access required',
          );
        else if (command.action !== 'timeline')
          assertIncident(control, 403, 'Incident commander or workspace administrator required');
        switch (command.action) {
          case 'edit':
            if (command.fields.severity && command.fields.severity !== incident.severity) {
              type = 'incident.severity_changed';
              previousValue = incident.severity;
              nextValue = command.fields.severity;
              message = 'Severity changed';
            }
            incident.set(command.fields);
            break;
          case 'acknowledge':
          case 'transition': {
            const target = command.action === 'acknowledge' ? 'investigating' : command.status;
            if (command.action === 'acknowledge' && incident.acknowledgedAt) break;
            if (target === incident.status) break;
            assertIncident(
              canTransitionIncident(incident.status as IncidentStatus, target),
              409,
              'Invalid incident status transition',
            );
            if (target === 'resolved') {
              assertIncident(
                command.action === 'transition' && command.resolutionSummary?.trim(),
                400,
                'Resolution summary is required',
              );
              incident.resolutionSummary = command.resolutionSummary!;
              incident.resolvedAt = new Date();
              type = 'incident.resolved';
            } else if (incident.status === 'resolved') {
              incident.resolvedAt = null;
              incident.resolutionSummary = null;
              type = 'incident.reopened';
            } else type = 'incident.status_changed';
            previousValue = incident.status;
            nextValue = target;
            incident.status = target;
            if (target === 'investigating' && !incident.acknowledgedAt)
              incident.acknowledgedAt = new Date();
            message =
              target === 'resolved' && command.action === 'transition'
                ? command.resolutionSummary!
                : `Status changed to ${target}`;
            break;
          }
          case 'commander':
            await validateIncidentMembers(
              workspaceId,
              command.userId ? [command.userId] : [],
              session,
            );
            previousValue = incident.commanderId ?? null;
            nextValue = command.userId;
            incident.commanderId = command.userId;
            type = 'incident.commander_changed';
            message = 'Commander changed';
            break;
          case 'responders':
            await validateIncidentMembers(workspaceId, command.userIds, session);
            previousValue = incident.responderIds.join(',');
            nextValue = command.userIds.join(',');
            incident.responderIds = command.userIds;
            type = 'incident.responder_changed';
            message = 'Responders changed';
            break;
          case 'links':
            await validateLinks(workspaceId, command.projectIds, command.taskIds, session);
            incident.linkedProjectIds = command.projectIds;
            incident.linkedTaskIds = command.taskIds;
            message = 'Linked work updated';
            break;
          case 'timeline':
            await validateIncidentMembers(workspaceId, command.mentionIds, session);
            mentions = command.mentionIds;
            type = 'incident.timeline_added';
            message = command.message;
            break;
          case 'archive':
            assertIncident(
              incident.status === 'resolved',
              409,
              'Resolve the incident before archiving',
            );
            if (!incident.archivedAt) incident.archivedAt = new Date();
            message = 'Incident archived';
            break;
          case 'attach-runbook': {
            if (incident.runbooks.some((book) => book.runbookId === command.runbookId)) break;
            const book = await RunbookModel.findOne({
              workspaceId,
              _id: command.runbookId,
              status: 'active',
            }).session(session);
            assertIncident(book, 404, 'Active workspace runbook not found');
            incident.runbooks.push({
              runbookId: book.id,
              name: book.name,
              steps: book.steps.map((step) => ({
                id: step.id,
                title: step.title,
                instructions: step.instructions,
                position: step.position,
                completedAt: null,
                completedBy: null,
              })),
            });
            metadata.runbookId = command.runbookId;
            type = 'incident.runbook_attached';
            message = 'Runbook attached';
            break;
          }
          case 'step': {
            const book = incident.runbooks.find((item) => item.runbookId === command.runbookId);
            const step = book?.steps.find((item) => item.id === command.stepId);
            assertIncident(step, 404, 'Incident runbook step not found');
            metadata.runbookId = command.runbookId;
            metadata.stepId = command.stepId;
            previousValue = step.completedAt ? 'completed' : 'incomplete';
            nextValue = command.completed ? 'completed' : 'incomplete';
            if (Boolean(step.completedAt) !== command.completed) {
              step.completedAt = command.completed ? new Date() : null;
              step.completedBy = command.completed ? actorId : null;
            }
            type = 'incident.step_completed';
            message = command.completed ? 'Runbook step completed' : 'Runbook step reopened';
            break;
          }
        }
      }
      // Force a write even for timeline-only commands so concurrent archive/state
      // changes conflict and retry against fresh incident state.
      if (!incident.isNew) incident.increment();
      await incident.save({ session });
      await IncidentEventModel.create(
        [
          {
            workspaceId,
            incidentId: incident.id,
            actorId,
            eventType: type,
            message,
            previousValue,
            nextValue,
            operationId,
            requestHash,
            metadata: { ...metadata, severity: incident.severity, status: incident.status },
          },
        ],
        { session },
      );
      await ActivityModel.create(
        [
          {
            workspaceId,
            actorId,
            entityType: 'incident',
            entityId: incident.id,
            action: type,
            metadata: { severity: incident.severity, status: incident.status },
          },
        ],
        { session },
      );
      const candidates = new Set(
        mentions.length
          ? mentions
          : [...incident.responderIds, ...(incident.commanderId ? [incident.commanderId] : [])],
      );
      if (
        (type === 'incident.declared' || type === 'incident.severity_changed') &&
        ['sev1', 'sev2'].includes(incident.severity)
      ) {
        const admins = await WorkspaceMemberModel.find({
          workspaceId,
          role: { $in: ['owner', 'admin'] },
          disabled: { $ne: true },
        }).session(session);
        admins.forEach((admin) => candidates.add(String(admin.userId)));
      }
      candidates.delete(actorId);
      const members = await WorkspaceMemberModel.find({
        workspaceId,
        userId: { $in: [...candidates] },
        disabled: { $ne: true },
      }).session(session);
      const active = await UserModel.find({
        _id: { $in: members.map((member) => member.userId) },
        status: 'active',
      }).session(session);
      const recipients = active.map((user) => user.id);
      if (recipients.length)
        await NotificationModel.create(
          recipients.map((recipientId) => ({
            workspaceId,
            recipientId,
            actorId,
            type: 'incident_response',
            entityType: 'incident',
            entityId: incident.id,
            operationId,
            title: `${incident.incidentNumber}: incident response update`,
          })),
          { session, ordered: true },
        );
      return { incident, type, recipients, replay: false };
    });
    assertIncident(result, 503, 'Incident transaction unavailable');
    if (!result.replay) {
      const event = {
        workspaceId,
        incidentId: result.incident.id,
        entityId: result.incident.id,
        actorId,
        type: result.type,
        payload: {},
      };
      publishRealtimeEvent({
        ...event,
        type: result.type as Exclude<RealtimeEvent['type'], 'notification.created'>,
      });
      result.recipients.forEach((recipientId) =>
        publishNotification(recipientId, { ...event, type: 'notification.created' }),
      );
    }
    return result.incident;
  } finally {
    await session.endSession();
  }
};
