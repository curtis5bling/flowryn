import { createHash, randomUUID } from 'node:crypto';

import { alertInputSchema, policySchema, type AlertInput, type PolicyInput } from '@flowryn/shared';
import mongoose, { type ClientSession } from 'mongoose';

import { IntegrationModel } from '../automation/models.js';
import { emitDomainEvent } from '../automation/outbox.js';
import {
  type AutomationContext,
  automationActorId,
  automationPrincipal,
} from '../automation/principal.js';
import { assertIncident, incidentActor } from '../incidents/service.js';
import { ActivityModel } from '../models/Activity.js';
import { IncidentModel } from '../models/Incident.js';
import { ProjectModel } from '../models/Project.js';
import { WorkspaceModel } from '../models/Workspace.js';

import {
  AlertModel,
  AlertReceiptModel,
  EscalationModel,
  EscalationDeliveryModel,
  PolicyModel,
  RoutingModel,
} from './models.js';
import { matchesRoute } from './schedules.js';

export const transact = async <T>(work: (session: ClientSession) => Promise<T>) => {
  // Unique-key ingestion races may abort an upsert transaction; retry the whole unit.
  for (let attempt = 0; ; attempt++) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => work(session));
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || attempt >= 4) throw error;
    } finally {
      await session.endSession();
    }
  }
};
export const recordOncallActivity = (
  workspaceId: string,
  actorId: string,
  entityId: string,
  action: string,
  session: ClientSession,
  metadata: Record<string, string | number | boolean> = {},
) =>
  ActivityModel.create(
    [{ workspaceId, actorId, entityId, entityType: 'oncall', action, metadata }],
    { session },
  );
export const validateAlertReferences = async (
  workspaceId: string,
  input: AlertInput,
  session?: ClientSession,
) => {
  if (input.escalationPolicyId)
    assertIncident(
      await PolicyModel.exists({
        workspaceId,
        _id: input.escalationPolicyId,
        enabled: true,
        archivedAt: null,
      }).session(session ?? null),
      400,
      'Active workspace policy required',
    );
  if (input.sourceIntegrationId)
    assertIncident(
      await IntegrationModel.exists({
        workspaceId,
        _id: input.sourceIntegrationId,
        status: 'active',
        archivedAt: null,
      }).session(session ?? null),
      400,
      'Active workspace integration required',
    );
  if (input.linkedIncidentId)
    assertIncident(
      await IncidentModel.exists({
        workspaceId,
        _id: input.linkedIncidentId,
        archivedAt: null,
      }).session(session ?? null),
      400,
      'Active workspace incident required',
    );
  if (input.projectId)
    assertIncident(
      await ProjectModel.exists({ workspaceId, _id: input.projectId, status: 'active' }).session(
        session ?? null,
      ),
      400,
      'Active workspace project required',
    );
};
export const selectPolicy = async (
  workspaceId: string,
  input: AlertInput,
  at: Date,
  session?: ClientSession,
) => {
  if (input.escalationPolicyId) {
    const policy = await PolicyModel.findOne({
      workspaceId,
      _id: input.escalationPolicyId,
      enabled: true,
      archivedAt: null,
    }).session(session ?? null);
    assertIncident(policy, 400, 'Active workspace policy required');
    return { policy, routingRuleId: null };
  }
  const routes = await RoutingModel.find({ workspaceId, enabled: true, archivedAt: null })
    .sort({ priority: 1, _id: 1 })
    .limit(100)
    .session(session ?? null);
  for (const rule of routes)
    if (matchesRoute(rule.toObject() as unknown as Parameters<typeof matchesRoute>[0], input, at)) {
      const policy = await PolicyModel.findOne({
        workspaceId,
        _id: rule.policyId,
        enabled: true,
        archivedAt: null,
      }).session(session ?? null);
      if (policy) return { policy, routingRuleId: rule.id };
    }
  const workspace = await WorkspaceModel.findById(workspaceId).session(session ?? null);
  const policy = workspace?.oncallFallbackPolicyId
    ? await PolicyModel.findOne({
        workspaceId,
        _id: workspace.oncallFallbackPolicyId,
        enabled: true,
        archivedAt: null,
      }).session(session ?? null)
    : null;
  return { policy, routingRuleId: null };
};
export const startEscalation = async (
  alert: InstanceType<typeof AlertModel>,
  policy: InstanceType<typeof PolicyModel> | null,
  session: ClientSession,
  now: Date,
  automation?: AutomationContext,
) => {
  if (!policy) return;
  const snapshot = policySchema.parse({
    name: policy.name,
    description: policy.description ?? '',
    enabled: !!policy.enabled,
    steps: policy.steps,
    repeatCount: policy.repeatCount ?? 0,
    repeatDelayMinutes: policy.repeatDelayMinutes ?? 30,
  });
  alert.escalationPolicyId = policy._id;
  alert.escalationPolicyVersion = policy.version;
  await alert.save({ session });
  await EscalationModel.create(
    [
      {
        workspaceId: alert.workspaceId,
        alertId: alert._id,
        alertCycle: alert.cycle,
        policyId: policy._id,
        policyVersion: policy.version,
        policySnapshot: JSON.parse(JSON.stringify(snapshot)),
        configuredBy: automation?.configuredBy,
        initiatedBy: automation?.initiatedBy,
        correlationId: automation?.correlationId,
        causationId: automation?.causationId,
        chainDepth: automation?.chainDepth,
        rulePath: automation?.rulePath,
        nextEscalationAt: new Date(now.getTime() + snapshot.steps[0]!.delayMinutes * 60000),
      },
    ],
    { session },
  );
};
export const createAlert = async (input: {
  workspaceId: string;
  actorId: string;
  fields: unknown;
  session?: ClientSession;
  automation?: AutomationContext;
  inbound?: boolean;
  now?: Date;
}) => {
  const fields = alertInputSchema.parse(input.fields);
  const now = input.now ?? new Date();
  const hash = createHash('sha256')
    .update(JSON.stringify({ fields, actorId: input.actorId }))
    .digest('hex');
  const work = async (session: ClientSession) => {
    const system =
      input.automation?.principal === automationPrincipal && input.actorId === automationActorId;
    if (!system)
      assertIncident(
        (await incidentActor(input.workspaceId, input.actorId, session)).admin,
        403,
        'Workspace administrator required',
      );
    const receipt = await AlertReceiptModel.findOne({
      workspaceId: input.workspaceId,
      operationId: fields.operationId,
    })
      .select('+requestHash')
      .session(session);
    if (receipt) {
      assertIncident(
        receipt.requestHash === hash && String(receipt.actorId) === input.actorId,
        409,
        'Operation ID already used',
      );
      const alert = await AlertModel.findOne({
        workspaceId: input.workspaceId,
        _id: receipt.alertId,
      }).session(session);
      assertIncident(alert, 404, 'Alert not found');
      return { alert, duplicate: true, replay: true };
    }
    await validateAlertReferences(input.workspaceId, fields, session);
    let alert = await AlertModel.findOne({
      workspaceId: input.workspaceId,
      fingerprint: fields.fingerprint,
    }).session(session);
    const duplicate = !!alert;
    if (alert) {
      // Fingerprints are workspace-wide and retain their lifecycle until explicit reopening.
      alert.occurrenceCount++;
      alert.lastReceivedAt = new Date(Math.max(alert.lastReceivedAt.getTime(), now.getTime()));
      await alert.save({ session });
    } else {
      const selected = await selectPolicy(input.workspaceId, fields, now, session);
      alert = new AlertModel({
        ...fields,
        workspaceId: input.workspaceId,
        createdBy: input.actorId,
        firstReceivedAt: now,
        lastReceivedAt: now,
        correlationId: input.automation?.correlationId ?? randomUUID(),
      });
      await alert.save({ session });
      await startEscalation(alert, selected.policy, session, now, input.automation);
    }
    await AlertReceiptModel.create(
      [
        {
          workspaceId: input.workspaceId,
          operationId: fields.operationId,
          requestHash: hash,
          actorId: input.actorId,
          alertId: alert._id,
        },
      ],
      { session },
    );
    await recordOncallActivity(
      input.workspaceId,
      input.actorId,
      alert.id,
      duplicate ? 'alert.occurrenceAdded' : 'alert.opened',
      session,
      { occurrenceCount: alert.occurrenceCount },
    );
    await emitDomainEvent(session, {
      workspaceId: input.workspaceId,
      eventType: duplicate ? 'alert.occurrenceAdded' : 'alert.opened',
      aggregateType: 'alert',
      aggregateId: alert.id,
      eventId: fields.operationId,
      context: input.automation,
      payload: {
        actorId: input.actorId,
        alertId: alert.id,
        severity: fields.severity,
        ...(fields.sourceIntegrationId ? { integrationId: fields.sourceIntegrationId } : {}),
        ...(alert.linkedIncidentId ? { incidentId: String(alert.linkedIncidentId) } : {}),
      },
    });
    return { alert, duplicate, replay: false };
  };
  return input.session ? work(input.session) : transact(work);
};
export const cancelEscalations = async (
  workspaceId: string,
  alertId: string,
  session: ClientSession,
) => {
  await EscalationModel.updateMany(
    { workspaceId, alertId, status: { $in: ['queued', 'running'] } },
    {
      $set: { status: 'cancelled', completedAt: new Date() },
      $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
    },
    { session },
  );
  await EscalationDeliveryModel.updateMany(
    { workspaceId, alertId, status: 'pending' },
    { $set: { status: 'cancelled' } },
    { session },
  );
};
export const snapshotPolicy = (policy: InstanceType<typeof PolicyModel>): PolicyInput =>
  policySchema.parse({
    name: policy.name,
    description: policy.description ?? '',
    enabled: !!policy.enabled,
    steps: policy.steps,
    repeatCount: policy.repeatCount ?? 0,
    repeatDelayMinutes: policy.repeatDelayMinutes ?? 30,
  });
