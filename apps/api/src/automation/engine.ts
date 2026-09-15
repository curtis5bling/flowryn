import { createHash, randomUUID } from 'node:crypto';

import {
  automationLimits,
  automationPayloadSchema,
  automationRuleSchema,
  declareIncidentSchema,
  incidentCommandSchema,
  type AutomationAction,
  type AutomationRuleInput,
} from '@flowryn/shared';
import mongoose, { type ClientSession } from 'mongoose';

import {
  assertIncident,
  executeIncident,
  IncidentError,
  validateIncidentMembers,
} from '../incidents/service.js';
import { ActivityModel } from '../models/Activity.js';
import { NotificationModel } from '../models/Notification.js';
import { TaskModel } from '../models/Task.js';

import { publishAutomationHint } from './hints.js';
import {
  AutomationRuleModel,
  AutomationRunModel,
  IntegrationModel,
  OutboxEventModel,
  WebhookDeliveryModel,
} from './models.js';
import { evaluateCondition } from './outbox.js';
import { automationActorId, automationPrincipal, type AutomationContext } from './principal.js';
import { decryptSecret, sendWebhook, WebhookError, type NetworkAdapters } from './security.js';
import { executeTask } from './tasks.js';

export const leaseMs = 60000;
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.min(300000, 1000 * 2 ** Math.min(attempt, 8)) + Math.floor(random() * 1000);
const transaction = async <T>(work: (session: ClientSession) => Promise<T>) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};
export const claimEvent = (owner: string, now = new Date()) =>
  OutboxEventModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseOwner: `${owner}:${randomUUID()}`,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
      $inc: { attemptCount: 1 },
    },
    { new: true, sort: { availableAt: 1, _id: 1 } },
  );
export const claimRun = (owner: string, now = new Date()) =>
  AutomationRunModel.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', availableAt: { $lte: now } },
        { status: 'running', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'running',
        leaseOwner: `${owner}:${randomUUID()}`,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
      $inc: { attemptCount: 1, cycleAttemptCount: 1 },
    },
    { new: true, sort: { availableAt: 1, _id: 1 } },
  ).select('+ruleSnapshot');
type ClaimedEvent = NonNullable<Awaited<ReturnType<typeof claimEvent>>>;
type ClaimedRun = NonNullable<Awaited<ReturnType<typeof claimRun>>>;
const eventFence = (event: ClaimedEvent) => ({
  _id: event._id,
  workspaceId: event.workspaceId,
  status: 'processing',
  leaseOwner: event.leaseOwner,
  leaseExpiresAt: { $gt: new Date() },
});
const runFence = (run: ClaimedRun) => ({
  _id: run._id,
  workspaceId: run.workspaceId,
  status: 'running',
  leaseOwner: run.leaseOwner,
  leaseExpiresAt: { $gt: new Date() },
});
export const processEvent = async (event: ClaimedEvent) => {
  if (event.attemptCount > automationLimits.attempts) {
    await OutboxEventModel.updateOne(eventFence(event), {
      $set: { status: 'dead', error: 'ATTEMPTS_EXHAUSTED' },
      $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
    });
    return;
  }
  try {
    await transaction(async (session) => {
      const lock = await OutboxEventModel.updateOne(
        eventFence(event),
        { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
        { session },
      );
      assertIncident(lock.modifiedCount, 409, 'Lease lost');
      assertIncident(event.schemaVersion === 1, 400, 'Unsupported event schema version');
      const payload = automationPayloadSchema.parse(event.payload);
      // Workspace rule counts are bounded at creation. All matching rules are snapshotted atomically.
      const rules = await AutomationRuleModel.find({
        workspaceId: event.workspaceId,
        enabled: true,
        archivedAt: null,
        triggerType: event.eventType,
        ...(payload.integrationId ? { inboundIntegrationId: payload.integrationId } : {}),
        ...(event.targetRuleId ? { _id: event.targetRuleId } : {}),
      })
        .limit(101)
        .session(session);
      assertIncident(rules.length <= 100, 400, 'Workspace rule limit exceeded');
      for (const rule of rules) {
        const snapshot = automationRuleSchema.parse({
          name: rule.name,
          description: rule.description,
          enabled: rule.enabled,
          triggerType: rule.triggerType,
          triggerVersion: rule.triggerVersion,
          inboundIntegrationId: rule.inboundIntegrationId
            ? String(rule.inboundIntegrationId)
            : undefined,
          conditions: rule.conditions,
          actions: rule.actions,
        });
        const loop =
          event.chainDepth >= automationLimits.chainDepth || event.rulePath.includes(rule.id);
        const eligible =
          !loop && evaluateCondition(snapshot.conditions, payload, event.createdAt.getTime());
        await AutomationRunModel.updateOne(
          { workspaceId: event.workspaceId, ruleId: rule._id, triggerEventId: event.eventId },
          {
            $setOnInsert: {
              ruleVersion: rule.version,
              ruleSnapshot: JSON.parse(JSON.stringify(snapshot)),
              configuredBy: rule.updatedBy,
              initiatedBy: event.initiatedBy,
              triggerSnapshot: payload,
              correlationId: event.correlationId,
              causationId: event.eventId,
              chainDepth: event.chainDepth,
              rulePath: [...event.rulePath, rule.id],
              status: eligible ? 'queued' : 'skipped',
              ...(eligible
                ? {}
                : {
                    completedAt: new Date(),
                    error: loop ? 'LOOP_PREVENTED' : 'CONDITIONS_NOT_MATCHED',
                  }),
              actionResults: snapshot.actions.map((a) => ({
                id: a.id,
                status: eligible ? 'pending' : 'skipped',
              })),
            },
          },
          { upsert: true, session },
        );
      }
      const saved = await OutboxEventModel.updateOne(
        eventFence(event),
        {
          $set: {
            status: 'processed',
            processedAt: new Date(),
            cleanupAt: new Date(Date.now() + 90 * 86400000),
          },
          $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1 },
        },
        { session },
      );
      assertIncident(saved.modifiedCount, 409, 'Lease lost');
    });
    const runs = await AutomationRunModel.find({
      workspaceId: event.workspaceId,
      triggerEventId: event.eventId,
    })
      .select('_id status')
      .limit(100);
    for (const run of runs)
      publishAutomationHint({
        workspaceId: String(event.workspaceId),
        actorId: automationActorId,
        entityId: run.id,
        type: run.status === 'skipped' ? 'automation.runSkipped' : 'automation.runQueued',
      });
  } catch {
    await OutboxEventModel.updateOne(eventFence(event), {
      $set: {
        status: event.attemptCount >= automationLimits.attempts ? 'dead' : 'pending',
        availableAt: new Date(Date.now() + retryDelay(event.attemptCount)),
        error: 'EVENT_PROCESSING_FAILED',
      },
      $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
    });
  }
};
const stableOperation = (runId: string, actionId: string) => {
  const hash = createHash('sha256').update(`${runId}:${actionId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const contextFor = (run: ClaimedRun): AutomationContext => ({
  principal: automationPrincipal,
  configuredBy: String(run.configuredBy),
  initiatedBy: run.initiatedBy ? String(run.initiatedBy) : undefined,
  correlationId: run.correlationId!,
  causationId: run.triggerEventId,
  chainDepth: (run.chainDepth ?? 0) + 1,
  rulePath: run.rulePath,
});
const domainAction = async (run: ClaimedRun, action: AutomationAction, session: ClientSession) => {
  const workspaceId = String(run.workspaceId);
  const payload = automationPayloadSchema.parse(run.triggerSnapshot);
  const operationId = stableOperation(run.id, action.id);
  const automation = contextFor(run);
  const common = { workspaceId, actorId: automationActorId, session, automation };
  if (action.type.startsWith('incident.')) {
    if (action.type === 'incident.declare') {
      assertIncident(
        payload.integrationId || run.ruleSnapshot.triggerType === 'automation.manual',
        400,
        'Declaration requires inbound or manual trigger',
      );
      const incident = await executeIncident({
        ...common,
        declaration: declareIncidentSchema.parse({
          operationId,
          title: action.title,
          severity: action.severity,
          summary: '',
          impact: '',
          confirmSev1: true,
        }),
      });
      return incident.id;
    }
    assertIncident(payload.incidentId, 400, 'Incident trigger required');
    const command =
      action.type === 'incident.timeline'
        ? { action: 'timeline', message: action.message }
        : action.type === 'incident.runbook'
          ? { action: 'attach-runbook', runbookId: action.runbookId }
          : action.type === 'incident.severity'
            ? { action: 'edit', fields: { severity: action.severity } }
            : action.type === 'incident.transition'
              ? {
                  action: 'transition',
                  status: action.status,
                  resolutionSummary: action.resolutionSummary,
                }
              : null;
    const incident = await executeIncident({
      ...common,
      incidentId: payload.incidentId,
      mutation: incidentCommandSchema.parse({ operationId, command }),
    });
    return incident.id;
  }
  if (action.type === 'task.create')
    return (
      await executeTask({
        ...common,
        operationId,
        projectId: action.projectId,
        fields: { title: action.title, assigneeId: action.assigneeId },
      })
    ).id;
  if (action.type === 'task.assign' || action.type === 'task.update') {
    assertIncident(payload.taskId, 400, 'Task trigger required');
    return (
      await executeTask({
        ...common,
        operationId,
        taskId: payload.taskId,
        fields:
          action.type === 'task.assign'
            ? { assigneeId: action.userId }
            : { [action.field]: action.value },
      })
    ).id;
  }
  if (action.type === 'notification.send') {
    await validateIncidentMembers(workspaceId, [action.userId], session);
    await NotificationModel.create(
      [
        {
          workspaceId,
          recipientId: action.userId,
          actorId: automationActorId,
          type: 'automation',
          entityType: 'automation',
          entityId: run._id,
          operationId,
          title: action.title,
        },
      ],
      { session },
    );
    return run.id;
  }
  throw new IncidentError(400, 'Unsupported action');
};
const actionFence = async (run: ClaimedRun, session: ClientSession) => {
  const current = await AutomationRunModel.findOneAndUpdate(
    runFence(run),
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
    { new: true, session },
  ).select('+ruleSnapshot');
  assertIncident(current, 409, 'Lease lost');
  return current;
};
const saveAction = async (
  run: ClaimedRun,
  index: number,
  result: Record<string, unknown>,
  session: ClientSession,
) => {
  const saved = await AutomationRunModel.updateOne(
    runFence(run),
    { $set: { [`actionResults.${index}`]: result } },
    { session },
  );
  assertIncident(saved.modifiedCount, 409, 'Lease lost');
};
const webhookAction = async (
  run: ClaimedRun,
  action: Extract<AutomationAction, { type: 'webhook.invoke' }>,
  index: number,
  adapters?: NetworkAdapters,
) => {
  const deliveryId = stableOperation(run.id, action.id);
  const integration = await transaction(async (session) => {
    const locked = await actionFence(run, session);
    if (locked.actionResults[index]?.status === 'succeeded') return null;
    const integration = await IntegrationModel.findOne({
      workspaceId: run.workspaceId,
      _id: action.integrationId,
      status: 'active',
      archivedAt: null,
      outboundEvents: run.ruleSnapshot.triggerType,
    })
      .select('+credentials')
      .session(session);
    assertIncident(integration?.endpoint, 400, 'Approved outbound integration required');
    await WebhookDeliveryModel.updateOne(
      {
        workspaceId: run.workspaceId,
        integrationId: integration._id,
        deliveryId,
        direction: 'outbound',
      },
      {
        $setOnInsert: { eventId: run.triggerEventId, eventType: run.ruleSnapshot.triggerType },
        $inc: { attemptCount: 1 },
        $set: { status: 'pending' },
      },
      { upsert: true, session },
    );
    return integration;
  });
  if (!integration) return;
  const body = JSON.stringify({
    schemaVersion: 1,
    eventId: run.triggerEventId,
    eventType: run.ruleSnapshot.triggerType,
    correlationId: run.correlationId,
    data: automationPayloadSchema.parse(run.triggerSnapshot),
  });
  try {
    const statusCode = await sendWebhook(
      {
        endpoint: integration.endpoint!,
        secret: decryptSecret(integration as typeof integration & { credentials: string }),
        deliveryId,
        eventId: run.triggerEventId,
        body,
      },
      adapters,
    );
    await transaction(async (session) => {
      await actionFence(run, session);
      await WebhookDeliveryModel.updateOne(
        {
          workspaceId: run.workspaceId,
          integrationId: integration._id,
          deliveryId,
          direction: 'outbound',
        },
        { $set: { status: 'succeeded', statusCode }, $unset: { error: 1 } },
        { session },
      );
      await IntegrationModel.updateOne(
        { workspaceId: run.workspaceId, _id: integration._id },
        { $set: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'succeeded' } },
        { session },
      );
      await saveAction(run, index, { id: action.id, status: 'succeeded', deliveryId }, session);
      await auditAction(run, action, session);
    });
  } catch (error) {
    const confirmed = await AutomationRunModel.exists({
      workspaceId: run.workspaceId,
      _id: run._id,
      [`actionResults.${index}.status`]: 'succeeded',
    });
    if (confirmed) return;
    await transaction(async (session) => {
      await actionFence(run, session);
      await WebhookDeliveryModel.updateOne(
        {
          workspaceId: run.workspaceId,
          integrationId: integration._id,
          deliveryId,
          direction: 'outbound',
        },
        {
          $set: {
            status: 'failed',
            error: error instanceof WebhookError ? error.code : 'DELIVERY_FAILED',
            statusCode: error instanceof WebhookError ? error.statusCode : undefined,
          },
        },
        { session },
      );
      await IntegrationModel.updateOne(
        { workspaceId: run.workspaceId, _id: integration._id },
        { $set: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'failed' } },
        { session },
      );
    });
    throw error;
  }
};
const auditAction = (run: ClaimedRun, action: AutomationAction, session: ClientSession) =>
  ActivityModel.create(
    [
      {
        workspaceId: run.workspaceId,
        actorId: automationActorId,
        entityType: 'automation',
        entityId: run._id,
        action: action.type,
        metadata: {
          executionIdentity: 'flowryn:automation:v1',
          configuredBy: String(run.configuredBy),
          initiatedBy: run.initiatedBy ? String(run.initiatedBy) : null,
          ruleId: String(run.ruleId),
          actionId: action.id,
        },
      },
    ],
    { session },
  );
const completedActionHints = async (run: ClaimedRun, action: AutomationAction, index: number) => {
  const current = await AutomationRunModel.findOne({
    workspaceId: run.workspaceId,
    _id: run._id,
  }).select('actionResults');
  const entityId = current?.actionResults[index]?.entityId as string | undefined;
  const common = {
    workspaceId: String(run.workspaceId),
    actorId: automationActorId,
    entityId: entityId ?? run.id,
  };
  if (entityId && action.type.startsWith('task.')) {
    const task = await TaskModel.findOne({ workspaceId: run.workspaceId, _id: entityId }).select(
      'projectId',
    );
    if (task)
      publishAutomationHint({
        ...common,
        projectId: String(task.projectId),
        type: action.type === 'task.create' ? 'task.created' : 'task.updated',
      });
  }
  if (entityId && action.type.startsWith('incident.'))
    publishAutomationHint({
      ...common,
      incidentId: entityId,
      type:
        action.type === 'incident.timeline'
          ? 'incident.timeline_added'
          : action.type === 'incident.runbook'
            ? 'incident.runbook_attached'
            : action.type === 'incident.declare'
              ? 'incident.declared'
              : 'incident.updated',
    });
  const notifications = await NotificationModel.find({
    workspaceId: run.workspaceId,
    operationId: stableOperation(run.id, action.id),
  })
    .select('recipientId')
    .limit(200);
  for (const notification of notifications)
    publishAutomationHint({
      ...common,
      recipientId: String(notification.recipientId),
      type: 'notification.created',
    });
  if (action.type === 'webhook.invoke')
    publishAutomationHint({
      ...common,
      entityId: action.integrationId,
      type: 'integration.healthChanged',
    });
};
export const processRun = async (run: ClaimedRun, adapters?: NetworkAdapters) => {
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void AutomationRunModel.updateOne(runFence(run), {
      $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    })
      .catch(() => undefined)
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 15000);
  try {
    const parsed = automationRuleSchema.safeParse(run.ruleSnapshot);
    if (!parsed.success) {
      await AutomationRunModel.updateOne(runFence(run), {
        $set: {
          status: run.actionResults.some((action) => action.status === 'succeeded')
            ? 'partiallyFailed'
            : 'failed',
          error: 'INVALID_RULE_SNAPSHOT',
          failedAt: new Date(),
          completedAt: new Date(),
        },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      });
      return;
    }
    const snapshot: AutomationRuleInput = parsed.data;
    if (run.cycleAttemptCount > automationLimits.attempts) {
      const finished = run.actionResults.every((action) =>
        ['succeeded', 'skipped'].includes(action.status),
      );
      const partial = run.actionResults.some((action) => action.status === 'succeeded');
      await AutomationRunModel.updateOne(runFence(run), {
        $set: {
          status: finished ? 'succeeded' : partial ? 'partiallyFailed' : 'failed',
          completedAt: new Date(),
          ...(finished ? {} : { error: 'ATTEMPTS_EXHAUSTED', failedAt: new Date() }),
        },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      });
      return;
    }
    await AutomationRunModel.updateOne(
      { ...runFence(run), startedAt: null },
      { $set: { startedAt: new Date() } },
    );
    publishAutomationHint({
      workspaceId: String(run.workspaceId),
      actorId: automationActorId,
      entityId: run.id,
      type: 'automation.runStarted',
    });
    for (let index = 0; index < snapshot.actions.length; index++) {
      const action = snapshot.actions[index]!;
      const current = await AutomationRunModel.findOne(runFence(run));
      assertIncident(current, 409, 'Lease lost');
      if (
        current.actionResults[index]?.status === 'succeeded' ||
        current.actionResults[index]?.status === 'skipped'
      )
        continue;
      await AutomationRunModel.updateOne(runFence(run), {
        $set: { [`actionResults.${index}.status`]: 'running' },
      });
      try {
        if (action.type === 'webhook.invoke') await webhookAction(run, action, index, adapters);
        else
          await transaction(async (session) => {
            const locked = await actionFence(run, session);
            if (locked.actionResults[index]?.status === 'succeeded') return;
            const entityId = await domainAction(run, action, session);
            await saveAction(run, index, { id: action.id, status: 'succeeded', entityId }, session);
            await auditAction(run, action, session);
          });
        // Disposable publication failures cannot turn a committed effect into a failed action.
        await completedActionHints(run, action, index).catch(() => undefined);
      } catch (error) {
        const permanent =
          (error instanceof IncidentError && error.status < 500) ||
          (error instanceof WebhookError && !error.retryable);
        const exhausted = permanent || run.cycleAttemptCount >= automationLimits.attempts;
        const completed = await AutomationRunModel.findOne(runFence(run));
        if (!completed) return;
        if (completed.actionResults[index]?.status === 'succeeded') continue;
        const partial = completed.actionResults.some((a) => a.status === 'succeeded');
        await AutomationRunModel.updateOne(runFence(run), {
          $set: {
            [`actionResults.${index}`]: {
              id: action.id,
              status: 'failed',
              error: error instanceof WebhookError ? error.code : 'ACTION_FAILED',
            },
            status: exhausted ? (partial ? 'partiallyFailed' : 'failed') : 'queued',
            error: 'ACTION_FAILED',
            availableAt: new Date(Date.now() + retryDelay(run.cycleAttemptCount)),
            ...(exhausted ? { failedAt: new Date(), completedAt: new Date() } : {}),
          },
          $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
        });
        publishAutomationHint({
          workspaceId: String(run.workspaceId),
          actorId: automationActorId,
          entityId: run.id,
          type: 'automation.runFailed',
        });
        if (action.type === 'webhook.invoke')
          publishAutomationHint({
            workspaceId: String(run.workspaceId),
            actorId: automationActorId,
            entityId: action.integrationId,
            type: 'integration.deliveryFailed',
          });
        return;
      }
    }
    await AutomationRunModel.updateOne(runFence(run), {
      $set: { status: 'succeeded', completedAt: new Date() },
      $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1 },
    });
    publishAutomationHint({
      workspaceId: String(run.workspaceId),
      actorId: automationActorId,
      entityId: run.id,
      type: 'automation.runCompleted',
    });
  } finally {
    clearInterval(heartbeat);
  }
};
export class AutomationWorker {
  readonly id = randomUUID();
  private stopping = false;
  private ticking = false;
  private active = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private loop?: Promise<void>;
  private wake?: () => void;
  ready = false;
  constructor(
    readonly concurrency = 4,
    readonly pollMs = 1000,
  ) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 16 ||
      pollMs < 250 ||
      pollMs > 30000
    )
      throw new Error('Invalid automation worker bounds');
  }
  async tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      let claimed = 0;
      while (!this.stopping && this.active.size < this.concurrency && claimed < this.concurrency) {
        const run = await claimRun(this.id);
        const event = run ? null : await claimEvent(this.id);
        if (!run && !event) break;
        const work = (run ? processRun(run) : processEvent(event!))
          .catch(() => {
            console.error(
              JSON.stringify({ service: 'automation', event: 'processing_interrupted' }),
            );
          })
          .finally(() => this.active.delete(work));
        this.active.add(work);
        claimed++;
      }
      this.ready = mongoose.connection.readyState === 1;
    } catch {
      this.ready = false;
      console.error(JSON.stringify({ service: 'automation', event: 'storage_unavailable' }));
    } finally {
      this.ticking = false;
    }
  }
  start() {
    this.loop ??= (async () => {
      while (!this.stopping) {
        await this.tick();
        if (!this.stopping)
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, this.pollMs);
          });
      }
    })();
  }
  async stop() {
    this.stopping = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    await Promise.allSettled(this.active);
  }
}
