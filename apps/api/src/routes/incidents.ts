import {
  declareIncidentSchema,
  incidentCommandSchema,
  incidentIdSchema,
  incidentQuerySchema,
  runbookInputSchema,
} from '@flowryn/shared';
import { Router, type ErrorRequestHandler } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import {
  assertIncident,
  executeIncident,
  incidentActor,
  IncidentError,
  serializeIncident,
  validateIncidentMembers,
} from '../incidents/service.js';
import { requireAuth, requireWorkspaceRole } from '../middleware/auth.js';
import { IncidentModel } from '../models/Incident.js';
import { IncidentEventModel } from '../models/IncidentEvent.js';
import { ProjectModel } from '../models/Project.js';
import { RunbookModel } from '../models/Runbook.js';
import { TaskModel } from '../models/Task.js';
import { UserModel } from '../models/User.js';
import { WorkspaceMemberModel } from '../models/WorkspaceMember.js';
import { getPresence } from '../realtime/gateway.js';

const router = Router();
const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new IncidentError(400, result.error.issues.map((issue) => issue.message).join('; '));
  return result.data;
};
router.use(
  '/:workspaceId/incidents',
  requireAuth,
  requireWorkspaceRole('owner', 'admin', 'member'),
);
router.use('/:workspaceId/runbooks', requireAuth, requireWorkspaceRole('owner', 'admin', 'member'));
for (const parameter of ['incidentId', 'runbookId'])
  router.param(parameter, (_request, _response, next, value: string) => {
    if (!incidentIdSchema.safeParse(value).success)
      next(new IncidentError(400, 'Invalid identifier'));
    else next();
  });
const filterFor = (workspaceId: string, query: ReturnType<typeof incidentQuerySchema.parse>) => {
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
    archivedAt: query.archived === 'true' ? { $ne: null } : null,
  };
  if (query.status) filter.status = query.status;
  if (query.severity) filter.severity = query.severity;
  if (query.commanderId) filter.commanderId = query.commanderId;
  if (query.responderId) filter.responderIds = query.responderId;
  if (query.from || query.to)
    filter.declaredAt = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lte: new Date(query.to) } : {}),
    };
  if (query.q)
    filter.title = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return filter;
};
router.get('/:workspaceId/incidents', async (request, response) => {
  const query = parse(incidentQuerySchema, request.query);
  const filter = filterFor(request.params.workspaceId, query);
  const [items, total] = await Promise.all([
    IncidentModel.find(filter)
      .sort({ declaredAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    IncidentModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serializeIncident),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.get('/:workspaceId/incidents/metrics', async (request, response) => {
  const query = parse(incidentQuerySchema, request.query);
  const [metrics] = await IncidentModel.aggregate([
    { $match: filterFor(request.params.workspaceId, query) },
    {
      $facet: {
        openBySeverity: [
          { $match: { status: { $ne: 'resolved' } } },
          { $group: { _id: '$severity', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        averages: [
          {
            $group: {
              _id: null,
              meanAcknowledgeMs: {
                $avg: {
                  $cond: [
                    { $ne: ['$acknowledgedAt', null] },
                    { $subtract: ['$acknowledgedAt', '$declaredAt'] },
                    null,
                  ],
                },
              },
              acknowledgedCount: { $sum: { $cond: [{ $ne: ['$acknowledgedAt', null] }, 1, 0] } },
              meanResolveMs: {
                $avg: {
                  $cond: [
                    { $ne: ['$resolvedAt', null] },
                    { $subtract: ['$resolvedAt', '$declaredAt'] },
                    null,
                  ],
                },
              },
              resolvedCount: { $sum: { $cond: [{ $ne: ['$resolvedAt', null] }, 1, 0] } },
            },
          },
        ],
        createdOverTime: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$declaredAt', timezone: 'UTC' } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        resolvedOverTime: [
          { $match: { resolvedAt: { $ne: null } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$resolvedAt', timezone: 'UTC' } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);
  response.json({
    ...metrics,
    averages: metrics?.averages[0] ?? {
      meanAcknowledgeMs: null,
      acknowledgedCount: 0,
      meanResolveMs: null,
      resolvedCount: 0,
    },
  });
});
router.get('/:workspaceId/incidents/references', async (request, response) => {
  const workspaceId = request.params.workspaceId;
  const query = parse(
    z.object({ page: z.coerce.number().int().min(1).default(1) }).strict(),
    request.query,
  );
  const skip = (query.page - 1) * 100;
  const [projects, tasks, projectTotal, taskTotal] = await Promise.all([
    ProjectModel.find({ workspaceId }).select('_id name').sort({ _id: 1 }).skip(skip).limit(100),
    TaskModel.find({ workspaceId })
      .select('_id title projectId')
      .sort({ _id: 1 })
      .skip(skip)
      .limit(100),
    ProjectModel.countDocuments({ workspaceId }),
    TaskModel.countDocuments({ workspaceId }),
  ]);
  response.json({ projects, tasks, pages: Math.ceil(Math.max(projectTotal, taskTotal) / 100) });
});
router.post('/:workspaceId/incidents', async (request, response) => {
  const incident = await executeIncident({
    workspaceId: request.params.workspaceId,
    actorId: request.auth!.userId,
    declaration: parse(declareIncidentSchema, request.body),
  });
  response.status(201).json({ incident: serializeIncident(incident) });
});
router.get('/:workspaceId/incidents/:incidentId', async (request, response) => {
  const incident = await IncidentModel.findOne({
    workspaceId: request.params.workspaceId,
    _id: request.params.incidentId,
  });
  assertIncident(incident, 404, 'Incident not found');
  response.json({ incident: serializeIncident(incident) });
});
router.post('/:workspaceId/incidents/:incidentId/actions', async (request, response) => {
  const incident = await executeIncident({
    workspaceId: request.params.workspaceId,
    actorId: request.auth!.userId,
    incidentId: request.params.incidentId,
    mutation: parse(incidentCommandSchema, request.body),
  });
  response.json({ incident: serializeIncident(incident) });
});
router.patch('/:workspaceId/incidents/:incidentId', async (request, response) => {
  const body = parse(incidentCommandSchema, request.body);
  assertIncident(body.command.action === 'edit', 400, 'Use actions for incident transitions');
  const incident = await executeIncident({
    workspaceId: request.params.workspaceId,
    actorId: request.auth!.userId,
    incidentId: request.params.incidentId,
    mutation: body,
  });
  response.json({ incident: serializeIncident(incident) });
});
router.get('/:workspaceId/incidents/:incidentId/presence', async (request, response) => {
  assertIncident(
    await IncidentModel.exists({
      workspaceId: request.params.workspaceId,
      _id: request.params.incidentId,
    }),
    404,
    'Incident not found',
  );
  const ids = await getPresence(request.params.incidentId);
  const members = await WorkspaceMemberModel.find({
    workspaceId: request.params.workspaceId,
    userId: { $in: ids },
    disabled: { $ne: true },
  });
  const users = await UserModel.find({
    _id: { $in: members.map((member) => member.userId) },
    status: 'active',
  }).select('_id name');
  response.json({ users: users.map((user) => ({ id: user.id, name: user.name })) });
});
router.get('/:workspaceId/incidents/:incidentId/timeline', async (request, response) => {
  const filter = { workspaceId: request.params.workspaceId, incidentId: request.params.incidentId };
  assertIncident(
    await IncidentModel.exists({ workspaceId: filter.workspaceId, _id: filter.incidentId }),
    404,
    'Incident not found',
  );
  const query = parse(
    z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
    request.query,
  );
  const [items, total] = await Promise.all([
    IncidentEventModel.find(filter)
      .select('-operationId')
      .sort({ createdAt: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    IncidentEventModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serializeIncident),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.get('/:workspaceId/runbooks', async (request, response) => {
  const query = parse(
    z
      .object({
        status: z.enum(['draft', 'active', 'archived']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
    request.query,
  );
  const filter = {
    workspaceId: request.params.workspaceId,
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    RunbookModel.find(filter)
      .sort({ updatedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    RunbookModel.countDocuments(filter),
  ]);
  response.json({
    items: items.map(serializeIncident),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  });
});
router.post('/:workspaceId/runbooks', async (request, response) => {
  assertIncident(
    (await incidentActor(request.params.workspaceId, request.auth!.userId)).admin,
    403,
    'Workspace administrator required',
  );
  const input = parse(runbookInputSchema, request.body);
  await validateIncidentMembers(request.params.workspaceId, [input.ownerId]);
  const book = await RunbookModel.create({ ...input, workspaceId: request.params.workspaceId });
  response.status(201).json({ runbook: serializeIncident(book) });
});
router.put('/:workspaceId/runbooks/:runbookId', async (request, response) => {
  assertIncident(
    (await incidentActor(request.params.workspaceId, request.auth!.userId)).admin,
    403,
    'Workspace administrator required',
  );
  const input = parse(runbookInputSchema, request.body);
  await validateIncidentMembers(request.params.workspaceId, [input.ownerId]);
  const book = await RunbookModel.findOneAndUpdate(
    { workspaceId: request.params.workspaceId, _id: request.params.runbookId },
    { $set: input },
    { new: true, runValidators: true },
  );
  assertIncident(book, 404, 'Runbook not found');
  response.json({ runbook: serializeIncident(book) });
});
router.post('/:workspaceId/runbooks/:runbookId/archive', async (request, response) => {
  assertIncident(
    (await incidentActor(request.params.workspaceId, request.auth!.userId)).admin,
    403,
    'Workspace administrator required',
  );
  const book = await RunbookModel.findOneAndUpdate(
    { workspaceId: request.params.workspaceId, _id: request.params.runbookId },
    { status: 'archived' },
    { new: true },
  );
  assertIncident(book, 404, 'Runbook not found');
  response.json({ runbook: serializeIncident(book) });
});
const errors: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  if (error instanceof IncidentError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  console.info(JSON.stringify({ service: 'incidents', event: 'operation_failed' }));
  response
    .status(503)
    .json({
      error: 'Incident operation unavailable. MongoDB replica-set transactions are required.',
    });
};
router.use(errors);
export default router;
