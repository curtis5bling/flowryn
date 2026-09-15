import { createHash, randomUUID } from 'node:crypto';

import {
  canTransitionIncident,
  automationPayloadSchema,
  automationQuerySchema,
  automationRuleSchema,
  incidentIdSchema,
  integrationInputSchema,
  type AutomationCondition,
} from '@flowryn/shared';
import { Router, type ErrorRequestHandler, type Request } from 'express';
import mongoose, { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';

import { publishAutomationHint } from '../automation/hints.js';
import { automationMetrics } from '../automation/metrics.js';
import {
  AutomationRuleModel,
  AutomationRunModel,
  IntegrationModel,
  OutboxEventModel,
  WebhookDeliveryModel,
} from '../automation/models.js';
import { emitDomainEvent, evaluateCondition } from '../automation/outbox.js';
import { automationActorId } from '../automation/principal.js';
import {
  encryptSecret,
  endpointUrl,
  newSigningSecret,
  WebhookError,
} from '../automation/security.js';
import {
  assertIncident,
  incidentActor,
  IncidentError,
  validateIncidentMembers,
} from '../incidents/service.js';
import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { ActivityModel } from '../models/Activity.js';
import { IncidentModel } from '../models/Incident.js';
import { ProjectModel } from '../models/Project.js';
import { RunbookModel } from '../models/Runbook.js';
import { TaskModel } from '../models/Task.js';
import { WorkspaceModel } from '../models/Workspace.js';

const router = Router();
const base = '/:workspaceId/automation';
const ruleHint = (request: Request, rule: { _id: { toString(): string } }) =>
  publishAutomationHint({
    workspaceId: request.params.workspaceId as string,
    entityId: String(rule._id),
    actorId: request.auth!.userId,
    type: request.path.endsWith('/enable')
      ? 'automation.ruleEnabled'
      : request.path.endsWith('/disable')
        ? 'automation.ruleDisabled'
        : request.path.endsWith('/archive')
          ? 'automation.ruleArchived'
          : request.method === 'POST'
            ? 'automation.ruleCreated'
            : 'automation.ruleUpdated',
  });
router.use(base, requireAuth, requireWorkspaceRole('owner', 'admin', 'member'));
for (const parameter of ['ruleId', 'runId', 'integrationId', 'eventId'])
  router.param(parameter, (_request, _response, next, id: string) => {
    if (!incidentIdSchema.safeParse(id).success) next(new IncidentError(400, 'Invalid identifier'));
    else next();
  });
const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new IncidentError(400, 'Invalid automation request');
  return result.data;
};
const admin = async (request: Request, session?: ClientSession) => {
  assertIncident(
    (await incidentActor(request.params.workspaceId as string, request.auth!.userId, session))
      .admin,
    403,
    'Workspace administrator required',
  );
};
const transaction = async <T>(work: (session: ClientSession) => Promise<T>) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};
const scope = (request: Request) => ({ workspaceId: request.params.workspaceId as string });
const serialize = (document: {
  _id: { toString(): string };
  toObject(): Record<string, unknown>;
}) => {
  const { credentials, ruleSnapshot, rulePath, leaseOwner, leaseExpiresAt, ...safe } =
    document.toObject();
  void credentials;
  void ruleSnapshot;
  void rulePath;
  void leaseOwner;
  void leaseExpiresAt;
  return { ...safe, id: document._id.toString() };
};
const audit = (request: Request, id: string, action: string, session: ClientSession) =>
  ActivityModel.create(
    [
      {
        ...scope(request),
        actorId: request.auth!.userId,
        entityType: 'automation',
        entityId: id,
        action,
        metadata: {},
      },
    ],
    { session },
  );
const filtered = (request: Request) => {
  const query = parse(automationQuerySchema, request.query);
  return {
    query,
    filter: {
      ...scope(request),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { $gte: new Date(query.from) } : {}),
              ...(query.to ? { $lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    },
  };
};
const validateReferences = async (
  workspaceId: string,
  rule: ReturnType<typeof automationRuleSchema.parse>,
  session?: ClientSession,
) => {
  const fields = new Map<string, Set<string>>();
  const collect = (condition: AutomationCondition) => {
    if (!('field' in condition)) {
      condition.children.forEach(collect);
      return;
    }
    const ids = fields.get(condition.field) ?? new Set<string>();
    condition.values
      .filter((value): value is string => typeof value === 'string')
      .forEach((id) => ids.add(id));
    fields.set(condition.field, ids);
  };
  collect(rule.conditions);
  const members = [
    ...new Set(
      ['commanderId', 'responderIds', 'assigneeId', 'actorId'].flatMap((field) =>
        [...(fields.get(field) ?? [])].filter(
          (id) => field !== 'actorId' || id !== automationActorId,
        ),
      ),
    ),
  ];
  if (members.length) await validateIncidentMembers(workspaceId, members, session);
  for (const [field, model] of [
    ['projectId', ProjectModel],
    ['integrationId', IntegrationModel],
  ] as const) {
    const ids = [...(fields.get(field) ?? [])];
    if (ids.length)
      assertIncident(
        (await model
          .countDocuments({ workspaceId, _id: { $in: ids } })
          .session(session ?? null)) === ids.length,
        400,
        'Condition references must belong to the workspace',
      );
  }
  if (rule.inboundIntegrationId) {
    assertIncident(
      rule.triggerType === 'automation.manual',
      400,
      'Inbound rules require manual trigger',
    );
    assertIncident(
      await IntegrationModel.exists({
        workspaceId,
        _id: rule.inboundIntegrationId,
        archivedAt: null,
        status: 'active',
        inboundEvents: 'alert.received',
      }).session(session ?? null),
      400,
      'Approved inbound integration required',
    );
  }
  for (const action of rule.actions) {
    if (action.type === 'incident.declare')
      assertIncident(
        rule.triggerType === 'automation.manual',
        400,
        'Declaration requires a manual or inbound rule',
      );
    if (action.type === 'task.create')
      assertIncident(
        await ProjectModel.exists({ workspaceId, _id: action.projectId, status: 'active' }).session(
          session ?? null,
        ),
        400,
        'Active workspace project required',
      );
    if (action.type === 'task.assign' || action.type === 'notification.send')
      await validateIncidentMembers(workspaceId, [action.userId], session);
    if (action.type === 'task.create' && action.assigneeId)
      await validateIncidentMembers(workspaceId, [action.assigneeId], session);
    if (action.type === 'incident.runbook')
      assertIncident(
        await RunbookModel.exists({ workspaceId, _id: action.runbookId, status: 'active' }).session(
          session ?? null,
        ),
        400,
        'Active workspace runbook required',
      );
    if (action.type === 'webhook.invoke')
      assertIncident(
        await IntegrationModel.exists({
          workspaceId,
          _id: action.integrationId,
          status: 'active',
          archivedAt: null,
          outboundEvents: rule.triggerType,
        }).session(session ?? null),
        400,
        'Approved workspace integration required',
      );
    if (action.type === 'task.update' && action.field !== 'title')
      assertIncident(
        (action.field === 'status'
          ? ['backlog', 'todo', 'in_progress', 'review', 'done']
          : ['low', 'medium', 'high', 'urgent']
        ).includes(action.value),
        400,
        'Invalid task field value',
      );
    if (action.type === 'incident.transition' && action.status === 'resolved')
      assertIncident(action.resolutionSummary, 400, 'Resolution summary required');
  }
};
const targetPayload = async (request: Request) => {
  const body = parse(
    z
      .object({
        operationId: z.string().uuid(),
        incidentId: incidentIdSchema.optional(),
        taskId: incidentIdSchema.optional(),
      })
      .strict(),
    request.body,
  );
  const workspaceId = request.params.workspaceId as string;
  const payload: ReturnType<typeof automationPayloadSchema.parse> = {
    actorId: request.auth!.userId,
  };
  if (body.incidentId) {
    const incident = await IncidentModel.findOne({
      workspaceId,
      _id: body.incidentId,
      archivedAt: null,
    });
    assertIncident(incident, 404, 'Incident not found');
    Object.assign(payload, {
      incidentId: incident.id,
      severity: incident.severity,
      incidentStatus: incident.status,
      commanderId: incident.commanderId,
      responderIds: [...incident.responderIds],
      projectIds: [...incident.linkedProjectIds],
      declaredAt: incident.declaredAt.toISOString(),
      projectId: incident.linkedProjectIds[0],
    });
  }
  if (body.taskId) {
    const task = await TaskModel.findOne({ workspaceId, _id: body.taskId });
    assertIncident(task, 404, 'Task not found');
    Object.assign(payload, {
      taskId: task.id,
      taskStatus: task.status,
      assigneeId: task.assigneeId ? String(task.assigneeId) : null,
      projectId: String(task.projectId),
    });
  }
  return { body, payload: automationPayloadSchema.parse(payload) };
};
router.get(`${base}/rules`, async (request, response) => {
  const { query } = filtered(request);
  const filter = {
    ...scope(request),
    archivedAt: query.archived === 'true' ? { $ne: null } : null,
  };
  const [items, total] = await Promise.all([
    AutomationRuleModel.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    AutomationRuleModel.countDocuments(filter),
  ]);
  const latest = await AutomationRunModel.aggregate([
    {
      $match: {
        workspaceId: new Types.ObjectId(request.params.workspaceId as string),
        ruleId: { $in: items.map((rule) => rule._id) },
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: '$ruleId', status: { $first: '$status' } } },
  ]);
  const health = new Map(latest.map((run) => [String(run._id), run.status as string]));
  response.json({
    items: items.map((rule) => ({
      ...serialize(rule),
      health: ['failed', 'partiallyFailed'].includes(health.get(rule.id) ?? '')
        ? 'failing'
        : health.get(rule.id) === 'succeeded'
          ? 'healthy'
          : health.has(rule.id)
            ? 'pending'
            : 'neverRun',
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.post(`${base}/rules/validate`, async (request, response) => {
  await admin(request);
  const rule = parse(automationRuleSchema, request.body);
  await validateReferences(request.params.workspaceId as string, rule);
  response.json({ valid: true, rule });
});
router.post(`${base}/rules`, async (request, response) => {
  const input = parse(automationRuleSchema, request.body);
  const rule = await transaction(async (session) => {
    await admin(request, session);
    // Serialize the count with the workspace document, preventing concurrent cap bypass.
    await WorkspaceModel.updateOne(
      { _id: request.params.workspaceId },
      { $inc: { automationRevision: 1 } },
      { session },
    );
    assertIncident(
      (await AutomationRuleModel.countDocuments({ ...scope(request), archivedAt: null }).session(
        session,
      )) < 100,
      400,
      'Workspace rule limit is 100',
    );
    await validateReferences(request.params.workspaceId as string, input, session);
    const [rule] = await AutomationRuleModel.create(
      [
        {
          ...input,
          ...scope(request),
          createdBy: request.auth!.userId,
          updatedBy: request.auth!.userId,
        },
      ],
      { session },
    );
    await audit(request, rule!.id, 'automation.ruleCreated', session);
    return rule!;
  });
  ruleHint(request, rule!);
  response.status(201).json({ rule: serialize(rule!) });
});
router.get(`${base}/rules/:ruleId`, async (request, response) => {
  const rule = await AutomationRuleModel.findOne({ ...scope(request), _id: request.params.ruleId });
  assertIncident(rule, 404, 'Rule not found');
  response.json({ rule: serialize(rule) });
});
router.put(`${base}/rules/:ruleId`, async (request, response) => {
  const body = parse(
    z.object({ version: z.number().int().min(1), rule: automationRuleSchema }).strict(),
    request.body,
  );
  const rule = await transaction(async (session) => {
    await admin(request, session);
    await validateReferences(request.params.workspaceId as string, body.rule, session);
    const rule = await AutomationRuleModel.findOneAndUpdate(
      { ...scope(request), _id: request.params.ruleId, version: body.version, archivedAt: null },
      {
        $set: { ...JSON.parse(JSON.stringify(body.rule)), updatedBy: request.auth!.userId },
        $inc: { version: 1 },
        ...(!body.rule.inboundIntegrationId ? { $unset: { inboundIntegrationId: 1 } } : {}),
      },
      { new: true, session, runValidators: true },
    );
    assertIncident(rule, 409, 'Rule changed or unavailable');
    await audit(request, rule.id, 'automation.ruleUpdated', session);
    return rule;
  });
  ruleHint(request, rule!);
  response.json({ rule: serialize(rule!) });
});
for (const operation of ['enable', 'disable', 'archive'] as const)
  router.post(`${base}/rules/:ruleId/${operation}`, async (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const rule = await transaction(async (session) => {
      await admin(request, session);
      const rule = await AutomationRuleModel.findOneAndUpdate(
        { ...scope(request), _id: request.params.ruleId, archivedAt: null },
        {
          $set: {
            enabled: operation === 'enable',
            ...(operation === 'archive' ? { archivedAt: new Date() } : {}),
            updatedBy: request.auth!.userId,
          },
          $inc: { version: 1 },
        },
        { session, new: true },
      );
      assertIncident(rule, 404, 'Rule not found');
      await audit(
        request,
        rule.id,
        `automation.rule${operation === 'enable' ? 'Enabled' : operation === 'disable' ? 'Disabled' : 'Archived'}`,
        session,
      );
      return rule;
    });
    ruleHint(request, rule!);
    response.json({ rule: serialize(rule!) });
  });
router.post(`${base}/rules/:ruleId/dry-run`, async (request, response) => {
  await admin(request);
  const { payload } = await targetPayload(request);
  const rule = await AutomationRuleModel.findOne({
    ...scope(request),
    _id: request.params.ruleId,
    archivedAt: null,
  });
  assertIncident(rule, 404, 'Rule not found');
  const input = automationRuleSchema.parse({
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    triggerType: rule.triggerType,
    triggerVersion: rule.triggerVersion,
    inboundIntegrationId: rule.inboundIntegrationId ? String(rule.inboundIntegrationId) : undefined,
    conditions: rule.conditions,
    actions: rule.actions,
  });
  await validateReferences(request.params.workspaceId as string, input);
  const actions = input.actions.map((action) => {
    let reason: string | undefined;
    if (
      action.type.startsWith('incident.') &&
      action.type !== 'incident.declare' &&
      !payload.incidentId
    )
      reason = 'INCIDENT_TARGET_REQUIRED';
    if ((action.type === 'task.update' || action.type === 'task.assign') && !payload.taskId)
      reason = 'TASK_TARGET_REQUIRED';
    if (
      action.type === 'incident.transition' &&
      payload.incidentStatus &&
      action.status !== payload.incidentStatus &&
      !canTransitionIncident(payload.incidentStatus, action.status)
    )
      reason = 'INVALID_STATUS_TRANSITION';
    return {
      id: action.id,
      type: action.type,
      status: reason ? 'blocked' : 'ready',
      ...(reason ? { reason } : {}),
    };
  });
  response.json({
    matched: evaluateCondition(input.conditions, payload),
    eligible:
      evaluateCondition(input.conditions, payload) &&
      actions.every((action) => action.status === 'ready'),
    ruleVersion: rule.version,
    actions,
  });
});
router.post(`${base}/rules/:ruleId/execute`, async (request, response) => {
  await admin(request);
  const { body, payload } = await targetPayload(request);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ body, actorId: request.auth!.userId, ruleId: request.params.ruleId }))
    .digest('hex');
  await transaction(async (session) => {
    await admin(request, session);
    const rule = await AutomationRuleModel.findOne({
      ...scope(request),
      _id: request.params.ruleId,
      triggerType: 'automation.manual',
      enabled: true,
      archivedAt: null,
    }).session(session);
    assertIncident(rule, 404, 'Enabled manual rule required');
    const existing = await OutboxEventModel.findOne({
      ...scope(request),
      eventId: body.operationId,
    })
      .select('+requestHash')
      .session(session);
    if (existing) {
      assertIncident(
        String(existing.initiatedBy) === request.auth!.userId &&
          String(existing.targetRuleId) === rule.id &&
          existing.requestHash === requestHash,
        409,
        'Operation ID already used',
      );
      return;
    }
    await emitDomainEvent(session, {
      workspaceId: request.params.workspaceId as string,
      eventId: body.operationId,
      eventType: 'automation.manual',
      aggregateType: 'automation',
      aggregateId: rule.id,
      payload,
      requestHash,
      targetRuleId: rule.id,
      initiatedBy: request.auth!.userId,
    });
    await audit(request, rule.id, 'automation.manualQueued', session);
  });
  response.status(202).json({ eventId: body.operationId });
});
router.get(`${base}/runs`, async (request, response) => {
  await admin(request);
  const { query, filter } = filtered(request);
  const [items, total] = await Promise.all([
    AutomationRunModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    AutomationRunModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serialize),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.get(`${base}/runs/:runId`, async (request, response) => {
  await admin(request);
  const run = await AutomationRunModel.findOne({ ...scope(request), _id: request.params.runId });
  assertIncident(run, 404, 'Run not found');
  response.json({ run: serialize(run) });
});
for (const operation of ['cancel', 'retry'] as const)
  router.post(`${base}/runs/:runId/${operation}`, async (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const run = await transaction(async (session) => {
      await admin(request, session);
      const run = await AutomationRunModel.findOneAndUpdate(
        {
          ...scope(request),
          _id: request.params.runId,
          status: operation === 'cancel' ? 'queued' : { $in: ['failed', 'partiallyFailed'] },
        },
        {
          $set:
            operation === 'cancel'
              ? { status: 'cancelled', cancelledAt: new Date(), initiatedBy: request.auth!.userId }
              : {
                  status: 'queued',
                  availableAt: new Date(),
                  initiatedBy: request.auth!.userId,
                  cycleAttemptCount: 0,
                },
          $unset: { leaseOwner: 1, leaseExpiresAt: 1, error: 1, completedAt: 1, failedAt: 1 },
        },
        { new: true, session },
      );
      assertIncident(run, 409, 'Run is not eligible');
      await audit(
        request,
        run.id,
        `automation.run${operation === 'cancel' ? 'Cancelled' : 'Retried'}`,
        session,
      );
      return run;
    });
    response.json({ run: serialize(run!) });
  });
router.get(`${base}/dead-letters`, async (request, response) => {
  await admin(request);
  const { query } = filtered(request);
  const filter = { ...scope(request), status: 'dead' };
  const [items, total] = await Promise.all([
    OutboxEventModel.find(filter)
      .select('-payload')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    OutboxEventModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serialize),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.post(`${base}/dead-letters/:eventId/replay`, async (request, response) => {
  parse(z.object({}).strict(), request.body ?? {});
  await transaction(async (session) => {
    await admin(request, session);
    const event = await OutboxEventModel.findOneAndUpdate(
      { ...scope(request), _id: request.params.eventId, status: 'dead' },
      {
        $set: {
          status: 'pending',
          availableAt: new Date(),
          attemptCount: 0,
          initiatedBy: request.auth!.userId,
        },
        $unset: { error: 1, leaseOwner: 1, leaseExpiresAt: 1 },
      },
      { new: true, session },
    );
    assertIncident(event, 409, 'Event is not eligible');
    await audit(request, event.id, 'automation.deadLetterReplayed', session);
  });
  response.status(202).json({ queued: true });
});
router.get(`${base}/metrics`, async (request, response) => {
  await admin(request);
  const { query } = filtered(request);
  response.json(
    await automationMetrics(request.params.workspaceId as string, query.from, query.to),
  );
});
router.get(`${base}/integrations`, async (request, response) => {
  await admin(request);
  const { query } = filtered(request);
  const filter = {
    ...scope(request),
    archivedAt: query.archived === 'true' ? { $ne: null } : null,
  };
  const [items, total] = await Promise.all([
    IntegrationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    IntegrationModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serialize),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.post(`${base}/integrations`, async (request, response) => {
  const input = parse(integrationInputSchema, request.body);
  if (input.endpoint) endpointUrl(input.endpoint);
  const secret = newSigningSecret();
  const id = new Types.ObjectId();
  const integration = await transaction(async (session) => {
    await admin(request, session);
    const [integration] = await IntegrationModel.create(
      [
        {
          ...input,
          ...scope(request),
          _id: id,
          ...encryptSecret(secret, request.params.workspaceId as string, String(id)),
          createdBy: request.auth!.userId,
          updatedBy: request.auth!.userId,
        },
      ],
      { session },
    );
    await audit(request, String(id), 'integration.created', session);
    return integration!;
  });
  response.status(201).json({ integration: serialize(integration!), secret });
});
router.get(`${base}/integrations/:integrationId`, async (request, response) => {
  await admin(request);
  const integration = await IntegrationModel.findOne({
    ...scope(request),
    _id: request.params.integrationId,
  });
  assertIncident(integration, 404, 'Integration not found');
  response.json({ integration: serialize(integration) });
});
router.put(`${base}/integrations/:integrationId`, async (request, response) => {
  const input = parse(integrationInputSchema, request.body);
  if (input.endpoint) endpointUrl(input.endpoint);
  const integration = await transaction(async (session) => {
    await admin(request, session);
    const integration = await IntegrationModel.findOneAndUpdate(
      { ...scope(request), _id: request.params.integrationId, archivedAt: null },
      { $set: { ...input, endpoint: input.endpoint ?? null, updatedBy: request.auth!.userId } },
      { session, new: true, runValidators: true },
    );
    assertIncident(integration, 404, 'Integration not found');
    await audit(request, integration.id, 'integration.updated', session);
    return integration;
  });
  response.json({ integration: serialize(integration!) });
});
router.post(`${base}/integrations/:integrationId/rotate`, async (request, response) => {
  parse(z.object({}).strict(), request.body ?? {});
  const secret = newSigningSecret();
  const integration = await transaction(async (session) => {
    await admin(request, session);
    const integration = await IntegrationModel.findOneAndUpdate(
      { ...scope(request), _id: request.params.integrationId, archivedAt: null },
      {
        $set: {
          ...encryptSecret(
            secret,
            request.params.workspaceId as string,
            request.params.integrationId as string,
          ),
          updatedBy: request.auth!.userId,
        },
        $inc: { secretVersion: 1 },
      },
      { new: true, session },
    );
    assertIncident(integration, 404, 'Integration not found');
    await audit(request, integration.id, 'integration.secretRotated', session);
    return integration;
  });
  response.json({ integration: serialize(integration!), secret });
});
router.post(`${base}/integrations/:integrationId/archive`, async (request, response) => {
  parse(z.object({}).strict(), request.body ?? {});
  await transaction(async (session) => {
    await admin(request, session);
    const integration = await IntegrationModel.findOneAndUpdate(
      { ...scope(request), _id: request.params.integrationId, archivedAt: null },
      { $set: { status: 'disabled', archivedAt: new Date(), updatedBy: request.auth!.userId } },
      { new: true, session },
    );
    assertIncident(integration, 404, 'Integration not found');
    await audit(request, integration.id, 'integration.archived', session);
  });
  response.json({ archived: true });
});
router.get(`${base}/integrations/:integrationId/deliveries`, async (request, response) => {
  await admin(request);
  assertIncident(
    await IntegrationModel.exists({ ...scope(request), _id: request.params.integrationId }),
    404,
    'Integration not found',
  );
  const { query } = filtered(request);
  const filter = { ...scope(request), integrationId: request.params.integrationId };
  const [items, total] = await Promise.all([
    WebhookDeliveryModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    WebhookDeliveryModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serialize),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.post(`${base}/integrations/:integrationId/test`, async (request, response) => {
  parse(z.object({}).strict(), request.body ?? {});
  const run = await transaction(async (session) => {
    await admin(request, session);
    const integration = await IntegrationModel.findOne({
      ...scope(request),
      _id: request.params.integrationId,
      status: 'active',
      archivedAt: null,
    }).session(session);
    assertIncident(
      integration?.endpoint && integration.outboundEvents.length,
      400,
      'Active outbound integration required',
    );
    const eventId = randomUUID();
    const action = { id: randomUUID(), type: 'webhook.invoke', integrationId: integration.id };
    const snapshot = automationRuleSchema.parse({
      name: `Test: ${integration.name}`,
      description: '',
      enabled: true,
      triggerType: integration.outboundEvents[0],
      triggerVersion: 1,
      conditions: { mode: 'all', children: [] },
      actions: [action],
    });
    const [run] = await AutomationRunModel.create(
      [
        {
          ...scope(request),
          ruleId: integration._id,
          ruleVersion: 1,
          ruleSnapshot: snapshot,
          configuredBy: request.auth!.userId,
          initiatedBy: request.auth!.userId,
          triggerEventId: eventId,
          correlationId: eventId,
          chainDepth: 0,
          triggerSnapshot: { actorId: request.auth!.userId },
          actionResults: [{ id: action.id, status: 'pending' }],
        },
      ],
      { session },
    );
    await audit(request, run!.id, 'integration.testQueued', session);
    return run!;
  });
  response.status(202).json({ run: serialize(run!) });
});
const errors: ErrorRequestHandler = (error, _request, response, next) => {
  void next;
  if (error instanceof IncidentError) response.status(error.status).json({ error: error.message });
  else if (error instanceof WebhookError)
    response.status(400).json({ error: 'Invalid integration endpoint' });
  else {
    console.error(JSON.stringify({ service: 'automation', event: 'request_failed' }));
    response.status(503).json({ error: 'Automation request unavailable' });
  }
};
router.use(errors);
export default router;
