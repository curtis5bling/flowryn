import { randomUUID } from 'node:crypto';

import {
  automationLimits,
  automationPayloadSchema,
  automationTriggerSchema,
  type AutomationPayload,
  type AutomationCondition,
} from '@flowryn/shared';
import type { ClientSession } from 'mongoose';

import { OutboxEventModel } from './models.js';
import type { AutomationContext } from './principal.js';

export const emitDomainEvent = async (
  session: ClientSession,
  input: {
    workspaceId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: AutomationPayload;
    eventId?: string;
    context?: AutomationContext;
    targetRuleId?: string;
    initiatedBy?: string;
    requestHash?: string;
  },
) => {
  const type = automationTriggerSchema.safeParse(input.eventType);
  if (!type.success) return;
  const payload = automationPayloadSchema.parse(input.payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > automationLimits.snapshotBytes)
    throw new Error('Trigger snapshot too large');
  const eventId = input.eventId ?? randomUUID();
  await OutboxEventModel.create(
    [
      {
        workspaceId: input.workspaceId,
        eventId,
        eventType: type.data,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: JSON.parse(JSON.stringify(payload)),
        requestHash: input.requestHash,
        correlationId: input.context?.correlationId ?? eventId,
        causationId: input.context?.causationId,
        chainDepth: input.context?.chainDepth ?? 0,
        rulePath: input.context?.rulePath ?? [],
        targetRuleId: input.targetRuleId,
        initiatedBy: input.initiatedBy ?? input.context?.initiatedBy,
      },
    ],
    { session },
  );
};
export const evaluateCondition = (
  condition: AutomationCondition,
  payload: AutomationPayload,
  now = Date.now(),
): boolean => {
  if (!('field' in condition))
    return condition.mode === 'all'
      ? condition.children.every((c) => evaluateCondition(c, payload, now))
      : condition.children.some((c) => evaluateCondition(c, payload, now));
  const fields: Record<string, unknown> = {
    'incident.severity': payload.severity,
    'incident.status': payload.incidentStatus,
    projectId: payload.projectIds ?? payload.projectId,
    commanderId: payload.commanderId,
    responderIds: payload.responderIds,
    'task.status': payload.taskStatus,
    assigneeId: payload.assigneeId,
    actorId: payload.actorId,
    integrationId: payload.integrationId,
    'incident.ageMinutes': payload.declaredAt
      ? Math.max(0, Math.floor((now - Date.parse(payload.declaredAt)) / 60000))
      : undefined,
  };
  const actual = fields[condition.field];
  if (actual === undefined) return false;
  return Array.isArray(actual)
    ? actual.some((value) => condition.values.includes(value))
    : condition.values.includes(actual as string | number | null);
};
export const incidentTriggerNames: Record<string, string> = {
  'incident.severity_changed': 'incident.severityChanged',
  'incident.status_changed': 'incident.statusChanged',
  'incident.commander_changed': 'incident.commanderChanged',
  'incident.responder_changed': 'incident.responderChanged',
  'incident.timeline_added': 'incident.timelineAdded',
};
