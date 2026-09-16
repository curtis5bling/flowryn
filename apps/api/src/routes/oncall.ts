import { createHash } from 'node:crypto';

import {
  alertInputSchema,
  forecastSchema,
  incidentIdSchema,
  oncallQuerySchema,
  overrideSchema,
  policySchema,
  routingSchema,
  scheduleSchema,
  type AlertInput,
  type PolicyInput,
  type RoutingInput,
  type ScheduleInput,
} from '@flowryn/shared';
import { Router, type Request, type ErrorRequestHandler } from 'express';
import { type ClientSession, type Model, Types } from 'mongoose';
import { z } from 'zod';

import { publishAutomationHint } from '../automation/hints.js';
import { IntegrationModel } from '../automation/models.js';
import {
  assertIncident,
  executeIncident,
  incidentActor,
  IncidentError,
  validateIncidentMembers,
} from '../incidents/service.js';
import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { IncidentModel } from '../models/Incident.js';
import { NotificationModel } from '../models/Notification.js';
import { ProjectModel } from '../models/Project.js';
import { WorkspaceModel } from '../models/Workspace.js';
import { oncallMetrics } from '../oncall/metrics.js';
import {
  AlertModel,
  AlertReceiptModel,
  EscalationDeliveryModel,
  EscalationModel,
  OverrideModel,
  PolicyModel,
  RoutingModel,
  ScheduleModel,
} from '../oncall/models.js';
import { calculateOncall, forecastOncall, scheduleContext } from '../oncall/schedules.js';
import {
  cancelEscalations,
  createAlert,
  recordOncallActivity,
  selectPolicy,
  startEscalation,
  transact,
  validateAlertReferences,
} from '../oncall/service.js';

const router = Router();
const base = '/:workspaceId/oncall';
router.use(base, requireAuth, requireWorkspaceRole('owner', 'admin', 'member'));
for (const parameter of [
  'workspaceId',
  'scheduleId',
  'overrideId',
  'policyId',
  'routeId',
  'alertId',
  'deliveryId',
])
  router.param(parameter, (_req, _res, next, value: string) => {
    if (!incidentIdSchema.safeParse(value).success)
      next(new IncidentError(400, 'Invalid identifier'));
    else next();
  });
const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown) => {
  const value = schema.safeParse(input);
  assertIncident(value.success, 400, 'Invalid on-call request');
  return value.data;
};
const workspace = (request: Request) => String(request.params.workspaceId).toLowerCase();
const scope = (request: Request) => ({ workspaceId: workspace(request) });
const admin = async (request: Request, session?: ClientSession) =>
  assertIncident(
    (await incidentActor(workspace(request), request.auth!.userId, session)).admin,
    403,
    'Workspace administrator required',
  );
const safe = (document: { _id: unknown; toObject(): object }) => {
  const row = document.toObject() as Record<string, unknown>;
  for (const key of [
    'leaseOwner',
    'leaseExpiresAt',
    'policySnapshot',
    'requestHash',
    'dispatchRevision',
    'overrideRevision',
    '__v',
  ])
    delete row[key];
  return { ...row, id: String(document._id) };
};
const audit = (request: Request, id: string, action: string, session: ClientSession) =>
  recordOncallActivity(workspace(request), request.auth!.userId, id, action, session);
const emit = (
  request: Request,
  entityId: string,
  type: Parameters<typeof publishAutomationHint>[0]['type'],
) =>
  publishAutomationHint({
    workspaceId: workspace(request),
    actorId: request.auth!.userId,
    entityId,
    type,
  });
const page = async <T>(
  model: Model<T>,
  request: Request,
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1> = { createdAt: -1, _id: 1 },
) => {
  const query = parse(oncallQuerySchema, request.query);
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    model.countDocuments(filter),
  ]);
  return {
    items: items.map(safe),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};
const validateSchedule = async (request: Request, input: ScheduleInput, session: ClientSession) =>
  validateIncidentMembers(
    workspace(request),
    input.layers.flatMap((layer) => layer.participants),
    session,
  );
const validatePolicy = async (request: Request, input: PolicyInput, session: ClientSession) => {
  for (const step of input.steps) {
    if (step.target.type === 'users')
      await validateIncidentMembers(workspace(request), step.target.userIds, session);
    if (step.target.type === 'schedule')
      assertIncident(
        await ScheduleModel.exists({
          ...scope(request),
          _id: step.target.scheduleId,
          enabled: true,
          archivedAt: null,
        }).session(session),
        400,
        'Active workspace schedule required',
      );
    for (const id of step.webhookIntegrationIds)
      assertIncident(
        await IntegrationModel.exists({
          ...scope(request),
          _id: id,
          status: 'active',
          archivedAt: null,
          endpoint: { $type: 'string' },
          outboundEvents: 'escalation.advanced',
        }).session(session),
        400,
        'Approved escalation integration required',
      );
  }
};
const validateRoute = async (request: Request, input: RoutingInput, session: ClientSession) => {
  assertIncident(
    await PolicyModel.exists({
      ...scope(request),
      _id: input.policyId,
      enabled: true,
      archivedAt: null,
    }).session(session),
    400,
    'Active workspace policy required',
  );
  for (const condition of input.conditions) {
    if (condition.field === 'sourceIntegrationId')
      assertIncident(
        await IntegrationModel.exists({
          ...scope(request),
          _id: condition.value,
          archivedAt: null,
        }).session(session),
        400,
        'Workspace integration required',
      );
    if (condition.field === 'projectId')
      assertIncident(
        await ProjectModel.exists({
          ...scope(request),
          _id: condition.value,
          status: 'active',
        }).session(session),
        400,
        'Workspace project required',
      );
  }
};
const configuration = <T>(
  resource: string,
  parameter: string,
  model: Model<T>,
  schema: z.ZodType,
  validate: (request: Request, input: never, session: ClientSession) => Promise<unknown>,
) => {
  router.get(`${base}/${resource}`, async (request, response) => {
    const q = parse(oncallQuerySchema, request.query);
    response.json(
      await page(
        model,
        request,
        { ...scope(request), archivedAt: q.archived === 'true' ? { $ne: null } : null },
        resource === 'routing' ? { priority: 1, _id: 1 } : { createdAt: -1, _id: 1 },
      ),
    );
  });
  router.get(`${base}/${resource}/:${parameter}`, async (request, response) => {
    const item = await model.findOne({ ...scope(request), _id: request.params[parameter] });
    assertIncident(item, 404, 'Configuration not found');
    response.json({ item: safe(item) });
  });
  router.post(`${base}/${resource}/validate`, async (request, response) => {
    const input = parse(schema, request.body);
    await transact(async (session) => {
      await admin(request, session);
      await validate(request, input as never, session);
    });
    response.json({ valid: true });
  });
  router.post(`${base}/${resource}`, async (request, response) => {
    const input = parse(schema, request.body) as Record<string, unknown>;
    const item = await transact(async (session) => {
      await admin(request, session);
      await validate(request, input as never, session);
      // Serialize caps, routing/fallback mutations and configuration creation.
      await WorkspaceModel.updateOne(
        { _id: workspace(request) },
        { $inc: { oncallRevision: 1 } },
        { session },
      );
      assertIncident(
        (await model.countDocuments({ ...scope(request), archivedAt: null }).session(session)) <
          100,
        400,
        'Configuration limit reached',
      );
      const [created] = await model.create(
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
      assertIncident(created, 503, 'Configuration unavailable');
      await audit(request, String(created._id), `oncall.${resource}Created`, session);
      return created;
    });
    assertIncident(item, 503, 'Configuration unavailable');
    emit(request, String(item._id), 'oncall.scheduleUpdated');
    response.status(201).json({ item: safe(item) });
  });
  router.put(`${base}/${resource}/:${parameter}`, async (request, response) => {
    const input = parse(
      z.object({ version: z.number().int().min(1), config: schema }).strict(),
      request.body,
    );
    const item = await transact(async (session) => {
      await admin(request, session);
      await validate(request, input.config as never, session);
      if (resource === 'schedules') {
        const current = await ScheduleModel.findOne({
          ...scope(request),
          _id: request.params[parameter],
        }).session(session);
        assertIncident(current, 404, 'Schedule not found');
        const next = input.config as ScheduleInput;
        for (const layer of current.layers as ScheduleInput['layers'])
          if (!next.layers.some((candidate) => candidate.id === layer.id))
            assertIncident(
              !(await OverrideModel.exists({
                ...scope(request),
                scheduleId: current._id,
                layerId: layer.id,
                cancelledAt: null,
                endsAt: { $gt: new Date() },
              }).session(session)),
              409,
              'Cancel future overrides before removing a layer',
            );
        for (const layer of next.layers)
          assertIncident(
            !(await OverrideModel.exists({
              ...scope(request),
              scheduleId: current._id,
              layerId: layer.id,
              cancelledAt: null,
              endsAt: { $gt: new Date() },
              originalUserId: { $exists: true, $nin: layer.participants },
            }).session(session)),
            409,
            'Future overrides reference a removed participant',
          );
      }
      const updated = await model.findOneAndUpdate(
        {
          ...scope(request),
          _id: request.params[parameter],
          version: input.version,
          archivedAt: null,
        },
        { $set: { ...input.config, updatedBy: request.auth!.userId }, $inc: { version: 1 } },
        { new: true, session, runValidators: true },
      );
      assertIncident(updated, 409, 'Configuration changed or archived');
      await audit(request, String(updated._id), `oncall.${resource}Updated`, session);
      return updated;
    });
    assertIncident(item, 503, 'Configuration unavailable');
    emit(request, String(item._id), 'oncall.scheduleUpdated');
    response.json({ item: safe(item) });
  });
  router.post(`${base}/${resource}/:${parameter}/archive`, async (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const item = await transact(async (session) => {
      await admin(request, session);
      const archived = await model.findOneAndUpdate(
        { ...scope(request), _id: request.params[parameter], archivedAt: null },
        {
          $set: { archivedAt: new Date(), enabled: false, updatedBy: request.auth!.userId },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      assertIncident(archived, 404, 'Configuration not found');
      await audit(request, String(archived._id), `oncall.${resource}Archived`, session);
      return archived;
    });
    assertIncident(item, 503, 'Configuration unavailable');
    emit(request, String(item._id), 'oncall.scheduleUpdated');
    response.json({ item: safe(item) });
  });
};
configuration('schedules', 'scheduleId', ScheduleModel, scheduleSchema, validateSchedule);
configuration('policies', 'policyId', PolicyModel, policySchema, validatePolicy);
configuration('routing', 'routeId', RoutingModel, routingSchema, validateRoute);
router.get(`${base}/schedules/:scheduleId/current`, async (request, response) => {
  parse(z.object({ at: z.string().datetime().optional() }).strict(), request.query);
  const at = request.query.at ? new Date(String(request.query.at)) : new Date();
  const context = await scheduleContext(
    workspace(request),
    String(request.params.scheduleId),
    at,
    new Date(at.getTime() + 1),
  );
  assertIncident(context, 404, 'Schedule not found');
  response.json({
    at: at.toISOString(),
    timezone: context.input.timezone,
    layerRecipients: calculateOncall(context.input, at, context.active, context.overrides),
  });
});
router.get(`${base}/schedules/:scheduleId/upcoming`, async (request, response) => {
  const range = parse(forecastSchema, request.query);
  const from = new Date(range.from),
    to = new Date(range.to);
  const context = await scheduleContext(
    workspace(request),
    String(request.params.scheduleId),
    from,
    to,
  );
  assertIncident(context, 404, 'Schedule not found');
  const segments = forecastOncall(context.input, from, to, context.active, context.overrides);
  response.json({
    timezone: context.input.timezone,
    segments,
    gaps: segments.filter((segment) => segment.gap),
    layerGaps: segments.filter((segment) => segment.layerRecipients.some((layer) => !layer.userId)),
  });
});
router.get(`${base}/schedules/:scheduleId/overrides`, async (request, response) =>
  response.json(
    await page(
      OverrideModel,
      request,
      { ...scope(request), scheduleId: request.params.scheduleId },
      { startsAt: -1, _id: 1 },
    ),
  ),
);
router.post(`${base}/schedules/:scheduleId/overrides`, async (request, response) => {
  const input = parse(overrideSchema, request.body);
  const item = await transact(async (session) => {
    const actor = await incidentActor(workspace(request), request.auth!.userId, session);
    const context = await scheduleContext(
      workspace(request),
      String(request.params.scheduleId),
      new Date(input.startsAt),
      new Date(input.endsAt),
      session,
    );
    assertIncident(context && context.input.enabled, 404, 'Active schedule required');
    assertIncident(
      context.input.layers.some((layer) => layer.id === input.layerId),
      400,
      'Layer not found',
    );
    const selectedLayer = context.input.layers.find((layer) => layer.id === input.layerId)!;
    await validateIncidentMembers(
      workspace(request),
      [input.replacementUserId, ...(input.originalUserId ? [input.originalUserId] : [])],
      session,
    );
    if (!actor.admin) {
      assertIncident(
        context.input.allowSelfOverrides &&
          input.originalUserId === request.auth!.userId &&
          Date.parse(input.startsAt) >= Date.now(),
        403,
        'Self overrides are not permitted',
      );
      const raw = forecastOncall(
        context.input,
        new Date(input.startsAt),
        new Date(input.endsAt),
        context.active,
      );
      assertIncident(
        raw.every(
          (segment) =>
            segment.layerRecipients.find((layer) => layer.layerId === input.layerId)?.userId ===
            request.auth!.userId,
        ),
        403,
        'Only your own covered shifts may be overridden',
      );
    } else
      assertIncident(
        !input.originalUserId || selectedLayer.participants.includes(input.originalUserId),
        400,
        'Original member must participate in the selected layer',
      );
    await ScheduleModel.updateOne(
      { ...scope(request), _id: context.schedule._id },
      { $inc: { overrideRevision: 1 } },
      { session },
    );
    assertIncident(
      !(await OverrideModel.exists({
        ...scope(request),
        scheduleId: context.schedule._id,
        layerId: input.layerId,
        cancelledAt: null,
        startsAt: { $lt: new Date(input.endsAt) },
        endsAt: { $gt: new Date(input.startsAt) },
      }).session(session)),
      409,
      'Overlapping override',
    );
    const [created] = await OverrideModel.create(
      [
        {
          ...input,
          ...scope(request),
          scheduleId: context.schedule._id,
          createdBy: request.auth!.userId,
        },
      ],
      { session },
    );
    await audit(request, created!.id, 'oncall.overrideCreated', session);
    return created!;
  });
  assertIncident(item, 503, 'Override unavailable');
  emit(request, item.id, 'oncall.overrideCreated');
  response.status(201).json({ item: safe(item) });
});
router.post(
  `${base}/schedules/:scheduleId/overrides/:overrideId/cancel`,
  async (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const item = await transact(async (session) => {
      const actor = await incidentActor(workspace(request), request.auth!.userId, session);
      const override = await OverrideModel.findOne({
        ...scope(request),
        _id: request.params.overrideId,
        scheduleId: request.params.scheduleId,
      }).session(session);
      assertIncident(override, 404, 'Override not found');
      assertIncident(
        actor.admin ||
          (String(override.createdBy) === request.auth!.userId &&
            String(override.originalUserId) === request.auth!.userId),
        403,
        'Override cancellation denied',
      );
      if (!override.cancelledAt) {
        override.cancelledAt = new Date();
        await override.save({ session });
        await ScheduleModel.updateOne(
          { ...scope(request), _id: override.scheduleId },
          { $inc: { overrideRevision: 1 } },
          { session },
        );
        await audit(request, override.id, 'oncall.overrideCancelled', session);
      }
      return override;
    });
    assertIncident(item, 503, 'Override unavailable');
    emit(request, item.id, 'oncall.overrideCancelled');
    response.json({ item: safe(item) });
  },
);
router.get(`${base}/fallback`, async (request, response) => {
  await admin(request);
  const item = await WorkspaceModel.findById(workspace(request));
  response.json({ policyId: item?.oncallFallbackPolicyId ?? null });
});
router.put(`${base}/fallback`, async (request, response) => {
  const input = parse(z.object({ policyId: incidentIdSchema.nullable() }).strict(), request.body);
  await transact(async (session) => {
    await admin(request, session);
    if (input.policyId)
      assertIncident(
        await PolicyModel.exists({
          ...scope(request),
          _id: input.policyId,
          enabled: true,
          archivedAt: null,
        }).session(session),
        400,
        'Active workspace policy required',
      );
    await WorkspaceModel.updateOne(
      { _id: workspace(request) },
      { $set: { oncallFallbackPolicyId: input.policyId }, $inc: { oncallRevision: 1 } },
      { session },
    );
    await audit(request, workspace(request), 'oncall.fallbackUpdated', session);
  });
  response.json(input);
});
router.post(`${base}/routing/dry-run`, async (request, response) => {
  await admin(request);
  const fields = parse(alertInputSchema, request.body);
  await validateAlertReferences(workspace(request), fields);
  const result = await selectPolicy(workspace(request), fields, new Date());
  response.json({
    policyId: result.policy?.id ?? null,
    policyVersion: result.policy?.version ?? null,
    routingRuleId: result.routingRuleId,
    fallback: !result.routingRuleId,
  });
});
router.post(`${base}/routing/reorder`, async (request, response) => {
  const input = parse(
    z
      .object({
        ids: z
          .array(incidentIdSchema)
          .min(1)
          .max(100)
          .refine((v) => new Set(v).size === v.length),
      })
      .strict(),
    request.body,
  );
  await transact(async (session) => {
    await admin(request, session);
    await WorkspaceModel.updateOne(
      { _id: workspace(request) },
      { $inc: { oncallRevision: 1 } },
      { session },
    );
    assertIncident(
      (await RoutingModel.countDocuments({
        ...scope(request),
        _id: { $in: input.ids },
        archivedAt: null,
      }).session(session)) === input.ids.length,
      400,
      'Invalid workspace routes',
    );
    for (let index = 0; index < input.ids.length; index++)
      await RoutingModel.updateOne(
        { ...scope(request), _id: input.ids[index] },
        { $set: { priority: index, updatedBy: request.auth!.userId }, $inc: { version: 1 } },
        { session },
      );
    await audit(request, workspace(request), 'oncall.routingReordered', session);
  });
  emit(request, workspace(request), 'oncall.scheduleUpdated');
  response.json({ updated: true });
});
router.post(`${base}/alerts`, async (request, response) => {
  const result = await createAlert({
    workspaceId: workspace(request),
    actorId: request.auth!.userId,
    fields: request.body,
  });
  assertIncident(result, 503, 'Alert unavailable');
  if (!result.replay)
    emit(request, result.alert.id, result.duplicate ? 'alert.occurrenceAdded' : 'alert.opened');
  response
    .status(result.duplicate ? 200 : 201)
    .json({ alert: safe(result.alert), duplicate: result.duplicate });
});
router.get(`${base}/alerts`, async (request, response) => {
  const q = parse(oncallQuerySchema, request.query);
  const filter: Record<string, unknown> = { ...scope(request) };
  for (const [key, value] of Object.entries({
    status: q.status,
    severity: q.severity,
    escalationPolicyId: q.policyId,
    sourceIntegrationId: q.integrationId,
    linkedIncidentId: q.incidentId,
  }))
    if (value) filter[key] = value;
  if (q.from || q.to)
    filter.lastReceivedAt = {
      ...(q.from ? { $gte: new Date(q.from) } : {}),
      ...(q.to ? { $lte: new Date(q.to) } : {}),
    };
  if (q.search)
    filter.title = { $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  response.json(await page(AlertModel, request, filter, { lastReceivedAt: -1, _id: 1 }));
});
router.get(`${base}/alerts/:alertId`, async (request, response) => {
  const alert = await AlertModel.findOne({ ...scope(request), _id: request.params.alertId });
  assertIncident(alert, 404, 'Alert not found');
  response.json({ alert: safe(alert) });
});
router.get(`${base}/alerts/:alertId/history`, async (request, response) => {
  await admin(request);
  assertIncident(
    await AlertModel.exists({ ...scope(request), _id: request.params.alertId }),
    404,
    'Alert not found',
  );
  const query = parse(oncallQuerySchema, request.query);
  const deliveries = await page(EscalationDeliveryModel, request, {
    ...scope(request),
    alertId: request.params.alertId,
  });
  const executions = await EscalationModel.find({
    ...scope(request),
    alertId: request.params.alertId,
  })
    .sort({ createdAt: -1 })
    .limit(query.limit);
  response.json({ ...deliveries, executions: executions.map(safe) });
});
const commandSchema = z
  .object({
    operationId: z.string().uuid(),
    until: z.string().datetime().optional(),
    incidentId: incidentIdSchema.nullable().optional(),
    confirmSev1: z.boolean().optional(),
  })
  .strict();
for (const action of [
  'acknowledge',
  'resolve',
  'reopen',
  'suppress',
  'link',
  'declare-incident',
  'timeline',
] as const)
  router.post(`${base}/alerts/:alertId/${action}`, async (request, response) => {
    const input = parse(commandSchema, request.body);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          input,
          action,
          alertId: String(request.params.alertId).toLowerCase(),
          actorId: request.auth!.userId,
        }),
      )
      .digest('hex');
    const alert = await transact(async (session) => {
      const actor = await incidentActor(workspace(request), request.auth!.userId, session);
      if (action !== 'acknowledge')
        assertIncident(actor.admin, 403, 'Workspace administrator required');
      const receipt = await AlertReceiptModel.findOne({
        ...scope(request),
        operationId: input.operationId,
      })
        .select('+requestHash')
        .session(session);
      if (receipt) {
        assertIncident(receipt.requestHash === requestHash, 409, 'Operation ID already used');
        const previous = await AlertModel.findOne({
          ...scope(request),
          _id: receipt.alertId,
        }).session(session);
        assertIncident(previous, 404, 'Alert not found');
        return previous;
      }
      const alert = await AlertModel.findOne({
        ...scope(request),
        _id: request.params.alertId,
      }).session(session);
      assertIncident(alert, 404, 'Alert not found');
      const now = new Date();
      if (action === 'acknowledge') {
        assertIncident(['open', 'acknowledged'].includes(alert.status), 409, 'Alert is not open');
        if (alert.status === 'open') {
          const execution = await EscalationModel.findOne({
            ...scope(request),
            alertId: alert._id,
            alertCycle: alert.cycle,
          }).session(session);
          alert.status = 'acknowledged';
          alert.acknowledgedAt = now;
          alert.acknowledgedBy = new Types.ObjectId(request.auth!.userId);
          const dispatched = execution
            ? await EscalationDeliveryModel.findOne({
                ...scope(request),
                executionId: execution._id,
                attemptCount: { $gt: 0 },
              })
                .sort({ cycle: -1, step: -1 })
                .session(session)
            : null;
          alert.acknowledgedStep = dispatched?.step ?? 0;
        }
        await cancelEscalations(workspace(request), alert.id, session);
      }
      if (action === 'resolve') {
        if (alert.status !== 'resolved') {
          alert.status = 'resolved';
          alert.resolvedAt = now;
          alert.resolvedBy = new Types.ObjectId(request.auth!.userId);
        }
        alert.suppressionEndsAt = undefined;
        await cancelEscalations(workspace(request), alert.id, session);
      }
      if (action === 'suppress') {
        assertIncident(
          alert.status !== 'resolved',
          409,
          'Reopen a resolved alert before suppressing it',
        );
        assertIncident(
          input.until &&
            Date.parse(input.until) > now.getTime() &&
            Date.parse(input.until) - now.getTime() <= 7 * 86400000,
          400,
          'Suppression must expire within seven days',
        );
        alert.status = 'suppressed';
        alert.suppressionEndsAt = new Date(input.until);
        await cancelEscalations(workspace(request), alert.id, session);
      }
      if (action === 'reopen') {
        assertIncident(alert.status !== 'open', 409, 'Alert already open');
        await cancelEscalations(workspace(request), alert.id, session);
        alert.status = 'open';
        alert.cycle++;
        alert.acknowledgedAt = undefined;
        alert.acknowledgedBy = undefined;
        alert.acknowledgedStep = undefined;
        alert.resolvedAt = undefined;
        alert.resolvedBy = undefined;
        alert.suppressionEndsAt = undefined;
        const policy = alert.escalationPolicyId
          ? await PolicyModel.findOne({
              ...scope(request),
              _id: alert.escalationPolicyId,
              enabled: true,
              archivedAt: null,
            }).session(session)
          : null;
        await startEscalation(alert, policy, session, now);
      }
      if (action === 'link') {
        if (input.incidentId)
          assertIncident(
            await IncidentModel.exists({
              ...scope(request),
              _id: input.incidentId,
              archivedAt: null,
            }).session(session),
            400,
            'Active workspace incident required',
          );
        alert.linkedIncidentId = input.incidentId
          ? new Types.ObjectId(input.incidentId)
          : undefined;
      }
      if (action === 'declare-incident') {
        assertIncident(!alert.linkedIncidentId, 409, 'Alert already linked');
        const incident = await executeIncident({
          workspaceId: workspace(request),
          actorId: request.auth!.userId,
          session,
          declaration: {
            operationId: input.operationId,
            title: alert.title,
            summary: alert.summary ?? '',
            impact: '',
            severity: alert.severity as AlertInput['severity'],
            responderIds: [],
            linkedProjectIds: [],
            linkedTaskIds: [],
            confirmSev1: input.confirmSev1 ?? false,
          },
        });
        alert.linkedIncidentId = incident._id;
      }
      if (action === 'timeline') {
        assertIncident(alert.linkedIncidentId, 400, 'Linked incident required');
        await executeIncident({
          workspaceId: workspace(request),
          actorId: request.auth!.userId,
          session,
          incidentId: String(alert.linkedIncidentId),
          mutation: {
            operationId: input.operationId,
            command: {
              action: 'timeline',
              mentionIds: [],
              message: `Alert ${alert.id}: ${alert.severity.toUpperCase()}, ${alert.occurrenceCount} occurrence(s). ${alert.title}`,
            },
          },
        });
      }
      await alert.save({ session });
      await AlertReceiptModel.create(
        [
          {
            ...scope(request),
            operationId: input.operationId,
            requestHash,
            alertId: alert._id,
            actorId: request.auth!.userId,
          },
        ],
        { session },
      );
      await audit(request, alert.id, `alert.${action}`, session);
      return alert;
    });
    assertIncident(alert, 503, 'Alert unavailable');
    if ((action === 'declare-incident' || action === 'timeline') && alert.linkedIncidentId) {
      publishAutomationHint({
        workspaceId: workspace(request),
        actorId: request.auth!.userId,
        entityId: String(alert.linkedIncidentId),
        incidentId: String(alert.linkedIncidentId),
        type: action === 'declare-incident' ? 'incident.declared' : 'incident.timeline_added',
      });
      const notifications = await NotificationModel.find({
        ...scope(request),
        operationId: input.operationId,
      }).select('recipientId');
      for (const notification of notifications)
        publishAutomationHint({
          workspaceId: workspace(request),
          actorId: request.auth!.userId,
          entityId: String(alert.linkedIncidentId),
          recipientId: String(notification.recipientId),
          type: 'notification.created',
        });
    }
    if (action !== 'timeline')
      emit(
        request,
        alert.id,
        action === 'acknowledge'
          ? 'alert.acknowledged'
          : action === 'resolve'
            ? 'alert.resolved'
            : action === 'reopen'
              ? 'alert.reopened'
              : action === 'suppress'
                ? 'alert.suppressed'
                : 'alert.incidentLinked',
      );
    response.json({ alert: safe(alert) });
  });
router.post(`${base}/deliveries/:deliveryId/retry`, async (request, response) => {
  const input = parse(z.object({ operationId: z.string().uuid() }).strict(), request.body);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        action: 'delivery.retry',
        deliveryId: String(request.params.deliveryId).toLowerCase(),
        actorId: request.auth!.userId,
      }),
    )
    .digest('hex');
  await transact(async (session) => {
    await admin(request, session);
    const existing = await AlertReceiptModel.findOne({
      ...scope(request),
      operationId: input.operationId,
    })
      .select('+requestHash')
      .session(session);
    if (existing) {
      assertIncident(existing.requestHash === requestHash, 409, 'Operation ID already used');
      return;
    }
    const delivery = await EscalationDeliveryModel.findOne({
      ...scope(request),
      _id: request.params.deliveryId,
      status: 'dead',
      channel: { $ne: 'gap' },
    }).session(session);
    assertIncident(delivery, 409, 'Eligible failed delivery required');
    const alert = await AlertModel.findOneAndUpdate(
      { ...scope(request), _id: delivery.alertId, status: 'open' },
      { $inc: { dispatchRevision: 1 } },
      { new: true, session },
    );
    assertIncident(alert, 409, 'Only open alerts can be retried');
    const job = await EscalationModel.findOne({
      ...scope(request),
      _id: delivery.executionId,
      alertCycle: alert.cycle,
      status: { $in: ['dead', 'completed'] },
    }).session(session);
    assertIncident(job, 409, 'Escalation is running or cancelled');
    assertIncident(
      delivery.step != null && delivery.cycle != null,
      409,
      'Invalid delivery receipt',
    );
    delivery.status = 'pending';
    delivery.error = undefined;
    await delivery.save({ session });
    job.status = 'queued';
    job.currentStep = delivery.step;
    job.repeatIndex = delivery.cycle;
    job.stepAttemptCount = 0;
    job.retryDeliveryId = delivery._id;
    job.nextEscalationAt = new Date();
    job.completedAt = undefined;
    job.error = undefined;
    await job.save({ session });
    await AlertReceiptModel.create(
      [
        {
          ...scope(request),
          operationId: input.operationId,
          requestHash,
          alertId: alert._id,
          actorId: request.auth!.userId,
        },
      ],
      { session },
    );
    await audit(request, alert.id, 'escalation.retryQueued', session);
  });
  response.status(202).json({ queued: true });
});
router.get(`${base}/metrics`, async (request, response) => {
  await admin(request);
  response.json(await oncallMetrics(workspace(request)));
});
const errors: ErrorRequestHandler = (error, _request, response, next) => {
  if (error instanceof IncidentError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Invalid on-call request' });
    return;
  }
  void next;
  console.error(JSON.stringify({ service: 'oncall', event: 'request_failed' }));
  response.status(503).json({ error: 'On-call operation unavailable' });
};
router.use(errors);
export default router;
