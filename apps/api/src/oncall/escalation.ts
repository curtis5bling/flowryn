import { createHash, randomUUID } from 'node:crypto';

import { policySchema, type PolicyInput } from '@flowryn/shared';
import type { ClientSession } from 'mongoose';

import { publishAutomationHint } from '../automation/hints.js';
import { IntegrationModel, OutboxEventModel } from '../automation/models.js';
import { emitDomainEvent } from '../automation/outbox.js';
import { automationActorId, automationPrincipal } from '../automation/principal.js';
import {
  decryptSecret,
  sendWebhook,
  WebhookError,
  type NetworkAdapters,
} from '../automation/security.js';
import { assertIncident } from '../incidents/service.js';
import { IncidentModel } from '../models/Incident.js';
import { NotificationModel } from '../models/Notification.js';

import { AlertModel, EscalationModel, EscalationDeliveryModel, PolicyModel } from './models.js';
import { activeMembers, calculateOncall, scheduleContext } from './schedules.js';
import { cancelEscalations, recordOncallActivity, startEscalation, transact } from './service.js';

const leaseMs = 60000;
export const claimEscalation = (workerId: string, now = new Date()) =>
  EscalationModel.findOneAndUpdate(
    {
      nextEscalationAt: { $lte: now },
      $or: [{ status: 'queued' }, { status: 'running', leaseExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        status: 'running',
        leaseOwner: `${workerId}:${randomUUID()}`,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
      $inc: { attemptCount: 1, stepAttemptCount: 1 },
    },
    { new: true, sort: { nextEscalationAt: 1, _id: 1 } },
  ).select('+policySnapshot');
export type ClaimedEscalation = NonNullable<Awaited<ReturnType<typeof claimEscalation>>>;
const fence = (job: ClaimedEscalation) => ({
  workspaceId: job.workspaceId,
  _id: job._id,
  status: 'running',
  leaseOwner: job.leaseOwner,
  leaseExpiresAt: { $gt: new Date() },
});
const lockJob = async (job: ClaimedEscalation, session: ClientSession) => {
  const locked = await EscalationModel.findOneAndUpdate(
    fence(job),
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
    { new: true, session },
  );
  assertIncident(locked, 409, 'Escalation lease lost');
  return locked;
};
const lockAlert = (job: ClaimedEscalation, session: ClientSession) =>
  AlertModel.findOneAndUpdate(
    { workspaceId: job.workspaceId, _id: job.alertId, cycle: job.alertCycle, status: 'open' },
    { $inc: { dispatchRevision: 1 } },
    { new: true, session },
  );
const stableKey = (job: ClaimedEscalation, suffix: string) => {
  const hash = createHash('sha256')
    .update(`${job.id}:${job.repeatIndex}:${job.currentStep}:${suffix}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const hint = (job: ClaimedEscalation, type: 'escalation.advanced' | 'escalation.deliveryFailed') =>
  publishAutomationHint({
    workspaceId: String(job.workspaceId),
    entityId: String(job.alertId),
    actorId: automationActorId,
    type,
  });
const resolveRecipients = async (
  job: ClaimedEscalation,
  step: PolicyInput['steps'][number],
  alert: InstanceType<typeof AlertModel>,
  at: Date,
  session: ClientSession,
) => {
  const workspaceId = String(job.workspaceId);
  let ids: string[] = [];
  if (step.target.type === 'users') ids = step.target.userIds;
  if (step.target.type === 'schedule') {
    const context = await scheduleContext(
      workspaceId,
      step.target.scheduleId,
      at,
      new Date(at.getTime() + 1),
      session,
    );
    if (context)
      ids = calculateOncall(context.input, at, context.active, context.overrides).flatMap(
        (layer) => (layer.userId ? [layer.userId] : []),
      );
  }
  if (
    (step.target.type === 'commander' || step.target.type === 'responders') &&
    alert.linkedIncidentId
  ) {
    const incident = await IncidentModel.findOne({
      workspaceId,
      _id: alert.linkedIncidentId,
      archivedAt: null,
    }).session(session);
    if (incident)
      ids =
        step.target.type === 'commander'
          ? incident.commanderId
            ? [incident.commanderId]
            : []
          : [...incident.responderIds];
  }
  return [...(await activeMembers(workspaceId, ids, session))];
};
const prepareDeliveries = async (job: ClaimedEscalation, policy: PolicyInput, now: Date) =>
  transact(async (session) => {
    await lockJob(job, session);
    const alert = await lockAlert(job, session);
    if (!alert) {
      await cancelEscalations(String(job.workspaceId), String(job.alertId), session);
      return [];
    }
    const existing = await EscalationDeliveryModel.find({
      workspaceId: job.workspaceId,
      executionId: job._id,
      step: job.currentStep,
      cycle: job.repeatIndex,
    }).session(session);
    if (existing.length) return existing;
    const step = policy.steps[job.currentStep]!;
    const recipients = await resolveRecipients(job, step, alert, now, session);
    const common = {
      workspaceId: job.workspaceId,
      alertId: job.alertId,
      executionId: job._id,
      step: job.currentStep,
      cycle: job.repeatIndex,
    };
    const rows = recipients.map((recipient) => ({
      ...common,
      deliveryKey: stableKey(job, `user:${recipient}`),
      channel: 'notification',
      recipients: [recipient],
    }));
    const webhooks = step.webhookIntegrationIds.map((integrationId) => ({
      ...common,
      integrationId,
      deliveryKey: stableKey(job, `webhook:${integrationId}`),
      channel: 'webhook',
      recipients,
    }));
    const gaps = rows.length
      ? []
      : [
          {
            ...common,
            deliveryKey: stableKey(job, 'gap'),
            channel: 'gap',
            recipients: [] as string[],
            status: 'dead',
            error: 'NO_ACTIVE_RECIPIENTS',
          },
        ];
    return EscalationDeliveryModel.create([...rows, ...webhooks, ...gaps], {
      session,
      ordered: true,
    });
  });
const dispatch = async (job: ClaimedEscalation, deliveryId: string, adapters?: NetworkAdapters) =>
  transact(async (session) => {
    await lockJob(job, session);
    // This write arbitrates with acknowledgement. A committed acknowledgement wins
    // before network dispatch; an admitted dispatch holds this write through commit.
    const alert = await lockAlert(job, session);
    const delivery = await EscalationDeliveryModel.findOne({
      workspaceId: job.workspaceId,
      _id: deliveryId,
      executionId: job._id,
    }).session(session);
    assertIncident(delivery, 404, 'Delivery not found');
    if (delivery.status !== 'pending')
      return { status: delivery.status, recipients: [] as string[] };
    if (!alert) {
      delivery.status = 'cancelled';
      await delivery.save({ session });
      return { status: 'cancelled', recipients: [] as string[] };
    }
    delivery.attemptCount++;
    if (job.stepAttemptCount > 5) {
      delivery.status = 'dead';
      delivery.error = 'ATTEMPTS_EXHAUSTED';
      await delivery.save({ session });
      return { status: 'dead', recipients: [] as string[] };
    }
    if (delivery.channel === 'notification') {
      const recipients = [
        ...(await activeMembers(String(job.workspaceId), delivery.recipients, session)),
      ];
      if (!recipients.length) {
        delivery.status = 'dead';
        delivery.error = 'RECIPIENT_UNAVAILABLE';
      } else {
        await NotificationModel.updateOne(
          {
            workspaceId: job.workspaceId,
            recipientId: recipients[0],
            operationId: delivery.deliveryKey,
          },
          {
            $setOnInsert: {
              actorId: automationActorId,
              type: 'oncall_page',
              entityType: 'alert',
              entityId: job.alertId,
              title: `On-call ${alert.severity.toUpperCase()}: ${alert.title}`.slice(0, 200),
              readAt: null,
            },
          },
          { upsert: true, session },
        );
        delivery.recipients = recipients;
        delivery.status = 'succeeded';
        delivery.deliveredAt = new Date();
      }
    } else if (delivery.channel === 'webhook') {
      const integration = await IntegrationModel.findOne({
        workspaceId: job.workspaceId,
        _id: delivery.integrationId,
        status: 'active',
        archivedAt: null,
        outboundEvents: 'escalation.advanced',
      })
        .select('+credentials')
        .session(session);
      if (!integration?.endpoint) {
        delivery.status = 'dead';
        delivery.error = 'INTEGRATION_UNAVAILABLE';
      } else {
        // Bounded HTTP transport and its stable receiver key reuse Milestone 6.
        try {
          delivery.statusCode = await sendWebhook(
            {
              endpoint: integration.endpoint,
              secret: decryptSecret(integration as typeof integration & { credentials: string }),
              deliveryId: delivery.deliveryKey,
              eventId: alert.correlationId,
              body: JSON.stringify({
                schemaVersion: 1,
                eventType: 'escalation.advanced',
                alertId: alert.id,
                severity: alert.severity,
                correlationId: alert.correlationId,
                step: job.currentStep,
                cycle: job.repeatIndex,
              }),
            },
            adapters,
          );
          delivery.status = 'succeeded';
          delivery.deliveredAt = new Date();
        } catch (error) {
          delivery.error = error instanceof WebhookError ? error.code : 'DELIVERY_FAILED';
          if ((error instanceof WebhookError && !error.retryable) || job.stepAttemptCount >= 5)
            delivery.status = 'dead';
        }
      }
    }
    await delivery.save({ session });
    await recordOncallActivity(
      String(job.workspaceId),
      automationActorId,
      String(job.alertId),
      'escalation.delivery',
      session,
      { channel: delivery.channel, status: delivery.status },
    );
    return {
      status: delivery.status,
      recipients:
        delivery.channel === 'notification' && delivery.status === 'succeeded'
          ? delivery.recipients
          : [],
    };
  });
export const processEscalation = async (
  job: ClaimedEscalation,
  adapters?: NetworkAdapters,
  now = new Date(),
) => {
  try {
    const parsed = policySchema.safeParse(job.policySnapshot);
    if (!parsed.success || !parsed.data.steps[job.currentStep]) {
      await EscalationModel.updateOne(fence(job), {
        $set: { status: 'dead', error: 'INVALID_POLICY_SNAPSHOT', completedAt: now },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      });
      hint(job, 'escalation.deliveryFailed');
      return;
    }
    const deliveries = job.retryDeliveryId
      ? await EscalationDeliveryModel.find({
          workspaceId: job.workspaceId,
          executionId: job._id,
          _id: job.retryDeliveryId,
        })
      : await prepareDeliveries(job, parsed.data, now);
    for (const delivery of deliveries) {
      const result = await dispatch(job, delivery.id, adapters);
      for (const recipientId of result.recipients)
        publishAutomationHint({
          workspaceId: String(job.workspaceId),
          entityId: String(job.alertId),
          actorId: automationActorId,
          recipientId,
          type: 'notification.created',
        });
    }
    const result = await transact(async (session) => {
      const completedAt = new Date();
      await lockJob(job, session);
      const alert = await lockAlert(job, session);
      if (!alert) {
        await cancelEscalations(String(job.workspaceId), String(job.alertId), session);
        return 'cancelled';
      }
      const rows = await EscalationDeliveryModel.find({
        workspaceId: job.workspaceId,
        executionId: job._id,
        step: job.currentStep,
        cycle: job.repeatIndex,
        ...(job.retryDeliveryId ? { _id: job.retryDeliveryId } : {}),
      }).session(session);
      if (rows.some((row) => row.status === 'pending')) {
        if (job.stepAttemptCount >= 5) {
          await EscalationDeliveryModel.updateMany(
            {
              workspaceId: job.workspaceId,
              executionId: job._id,
              step: job.currentStep,
              cycle: job.repeatIndex,
              status: 'pending',
            },
            { $set: { status: 'dead', error: 'ATTEMPTS_EXHAUSTED' } },
            { session },
          );
        } else {
          await EscalationModel.updateOne(
            fence(job),
            {
              $set: {
                status: 'queued',
                nextEscalationAt: new Date(
                  completedAt.getTime() + Math.min(300000, 1000 * 2 ** job.stepAttemptCount),
                ),
              },
              $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1 },
            },
            { session },
          );
          return 'retry';
        }
      }
      const failed = rows.some((row) => row.status === 'dead' || row.status === 'pending');
      const next = job.currentStep + 1;
      const policy = parsed.data;
      const moreSteps = next < policy.steps.length;
      const repeats = !moreSteps && job.repeatIndex < policy.repeatCount;
      const failedEver =
        failed ||
        !!(await EscalationDeliveryModel.exists({
          workspaceId: job.workspaceId,
          executionId: job._id,
          status: 'dead',
        }).session(session));
      if (job.retryDeliveryId) {
        await EscalationModel.updateOne(
          fence(job),
          {
            $set: {
              status: failedEver ? 'dead' : 'completed',
              completedAt,
              ...(failedEver ? { error: 'DELIVERY_FAILED' } : {}),
            },
            $unset: { leaseOwner: 1, leaseExpiresAt: 1, retryDeliveryId: 1 },
          },
          { session },
        );
        return failedEver ? 'failed' : 'advanced';
      }
      await EscalationModel.updateOne(
        fence(job),
        {
          $set:
            moreSteps || repeats
              ? {
                  status: 'queued',
                  currentStep: moreSteps ? next : 0,
                  repeatIndex: job.repeatIndex + (repeats ? 1 : 0),
                  stepAttemptCount: 0,
                  nextEscalationAt: new Date(
                    completedAt.getTime() +
                      (moreSteps
                        ? policy.steps[next]!.delayMinutes
                        : policy.repeatDelayMinutes + policy.steps[0]!.delayMinutes) *
                        60000,
                  ),
                  ...(failed ? { error: 'DELIVERY_FAILED' } : {}),
                }
              : {
                  status: failedEver ? 'dead' : 'completed',
                  completedAt,
                  ...(failed ? { error: 'DELIVERY_FAILED' } : {}),
                },
          $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
        },
        { session },
      );
      await recordOncallActivity(
        String(job.workspaceId),
        automationActorId,
        String(job.alertId),
        'escalation.advanced',
        session,
        { step: job.currentStep, repeat: job.repeatIndex },
      );
      const advancementEventId = `escalation:${job.id}:${job.repeatIndex}:${job.currentStep}`;
      const advancementExists = await OutboxEventModel.exists({
        workspaceId: job.workspaceId,
        eventId: advancementEventId,
      }).session(session);
      if (!advancementExists)
        await emitDomainEvent(session, {
          workspaceId: String(job.workspaceId),
          eventType: 'escalation.advanced',
          aggregateType: 'alert',
          aggregateId: String(job.alertId),
          eventId: advancementEventId,
          ...(job.configuredBy
            ? {
                context: {
                  principal: automationPrincipal,
                  configuredBy: String(job.configuredBy),
                  initiatedBy: job.initiatedBy ? String(job.initiatedBy) : undefined,
                  correlationId: job.correlationId ?? advancementEventId,
                  causationId: job.causationId ?? advancementEventId,
                  chainDepth: job.chainDepth ?? 0,
                  rulePath: job.rulePath ?? [],
                },
              }
            : {}),
          payload: {
            actorId: automationActorId,
            alertId: String(job.alertId),
            severity: alert.severity,
            ...(alert.linkedIncidentId ? { incidentId: String(alert.linkedIncidentId) } : {}),
          },
        });
      return failedEver ? 'failed' : 'advanced';
    });
    if (result === 'advanced' || result === 'failed') hint(job, 'escalation.advanced');
    if (result === 'failed' || result === 'retry') hint(job, 'escalation.deliveryFailed');
  } catch {
    // Interruption never clears another claimant's lease. Successful receipts survive.
    if (job.stepAttemptCount >= 5)
      await transact(async (session) => {
        await lockJob(job, session);
        await EscalationDeliveryModel.updateMany(
          {
            workspaceId: job.workspaceId,
            executionId: job._id,
            step: job.currentStep,
            cycle: job.repeatIndex,
            status: 'pending',
          },
          { $set: { status: 'dead', error: 'PROCESSING_INTERRUPTED' } },
          { session },
        );
        // Revisit this cursor once without redispatching dead receipts. The normal
        // finalizer will then advance remaining steps or leave a retryable terminal job.
        await EscalationModel.updateOne(
          fence(job),
          {
            $set: {
              status: 'queued',
              error: 'PROCESSING_INTERRUPTED',
              nextEscalationAt: new Date(),
            },
            $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
          },
          { session },
        );
      }).catch(() => undefined);
    else
      await EscalationModel.updateOne(fence(job), {
        $set: {
          status: 'queued',
          error: 'PROCESSING_INTERRUPTED',
          nextEscalationAt: new Date(Date.now() + 5000),
        },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      }).catch(() => undefined);
  }
};
export const resumeSuppressedAlert = async (now = new Date()) => {
  const due = await AlertModel.findOne({
    status: 'suppressed',
    suppressionEndsAt: { $lte: now },
  }).select('_id workspaceId');
  if (!due) return;
  await transact(async (session) => {
    const alert = await AlertModel.findOneAndUpdate(
      {
        workspaceId: due.workspaceId,
        _id: due._id,
        status: 'suppressed',
        suppressionEndsAt: { $lte: now },
      },
      {
        $set: { status: 'open' },
        $inc: { cycle: 1 },
        $unset: {
          suppressionEndsAt: 1,
          acknowledgedAt: 1,
          acknowledgedBy: 1,
          acknowledgedStep: 1,
          resolvedAt: 1,
          resolvedBy: 1,
        },
      },
      { new: true, session },
    );
    if (!alert) return;
    const policy = alert.escalationPolicyId
      ? await PolicyModel.findOne({
          workspaceId: alert.workspaceId,
          _id: alert.escalationPolicyId,
          enabled: true,
          archivedAt: null,
        }).session(session)
      : null;
    await startEscalation(alert, policy, session, now);
    await recordOncallActivity(
      String(alert.workspaceId),
      automationActorId,
      alert.id,
      'alert.reopened',
      session,
    );
  });
  publishAutomationHint({
    workspaceId: String(due.workspaceId),
    entityId: due.id,
    actorId: automationActorId,
    type: 'alert.reopened',
  });
};
