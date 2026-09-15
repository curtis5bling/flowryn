import { z } from 'zod';

import { incidentIdSchema, incidentSeveritySchema, incidentStatusSchema } from './incidents.js';

export const automationLimits = {
  depth: 4,
  conditions: 32,
  actions: 16,
  chainDepth: 8,
  snapshotBytes: 16384,
  attempts: 5,
} as const;
export const automationTriggerSchema = z.enum([
  'incident.declared',
  'incident.severityChanged',
  'incident.statusChanged',
  'incident.commanderChanged',
  'incident.responderChanged',
  'incident.timelineAdded',
  'incident.resolved',
  'incident.reopened',
  'task.created',
  'task.assigned',
  'task.statusChanged',
  'automation.manual',
]);
export const automationFieldSchema = z.enum([
  'incident.severity',
  'incident.status',
  'projectId',
  'commanderId',
  'responderIds',
  'task.status',
  'assigneeId',
  'actorId',
  'incident.ageMinutes',
  'integrationId',
]);
export type AutomationCondition =
  | {
      field: z.infer<typeof automationFieldSchema>;
      operator: 'eq' | 'in';
      values: Array<string | number | null>;
    }
  | { mode: 'all' | 'any'; children: AutomationCondition[] };
const leaf = z
  .object({
    field: automationFieldSchema,
    operator: z.enum(['eq', 'in']),
    values: z
      .array(z.union([z.string().max(200), z.number().finite().min(0).max(5256000), z.null()]))
      .min(1)
      .max(32),
  })
  .strict()
  .refine((v) => v.operator !== 'eq' || v.values.length === 1, 'Exact comparison needs one value')
  .refine(
    (v) =>
      v.values.every((value) => {
        if (v.field === 'incident.ageMinutes')
          return typeof value === 'number' && Number.isInteger(value);
        if (v.field === 'incident.severity') return incidentSeveritySchema.safeParse(value).success;
        if (v.field === 'incident.status') return incidentStatusSchema.safeParse(value).success;
        if (v.field === 'task.status')
          return (
            typeof value === 'string' &&
            ['backlog', 'todo', 'in_progress', 'review', 'done'].includes(value)
          );
        return value === null || incidentIdSchema.safeParse(value).success;
      }),
    'Invalid condition value for field',
  );
// Build a finite schema rather than recursing over unbounded untrusted input.
const conditionAt = (depth: number): z.ZodType<AutomationCondition> =>
  depth === automationLimits.depth
    ? leaf
    : z.union([
        leaf,
        z
          .object({
            mode: z.enum(['all', 'any']),
            children: z.array(conditionAt(depth + 1)).max(32),
          })
          .strict(),
      ]);
const countConditions = (c: AutomationCondition): number =>
  'field' in c ? 1 : 1 + c.children.reduce((n, child) => n + countConditions(child), 0);
export const automationConditionSchema = conditionAt(1).refine(
  (c) => countConditions(c) <= automationLimits.conditions,
  'Too many conditions',
);
const text = (n: number) => z.string().trim().min(1).max(n);
const base = { id: z.string().uuid() };
export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('incident.timeline'), message: text(4000) }).strict(),
  z
    .object({
      ...base,
      type: z.literal('task.create'),
      projectId: incidentIdSchema,
      title: text(200),
      assigneeId: incidentIdSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('task.update'),
      field: z.enum(['title', 'priority', 'status']),
      value: text(200),
    })
    .strict(),
  z.object({ ...base, type: z.literal('task.assign'), userId: incidentIdSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal('notification.send'),
      userId: incidentIdSchema,
      title: text(240),
    })
    .strict(),
  z.object({ ...base, type: z.literal('incident.runbook'), runbookId: incidentIdSchema }).strict(),
  z
    .object({ ...base, type: z.literal('incident.severity'), severity: incidentSeveritySchema })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('incident.transition'),
      status: incidentStatusSchema,
      resolutionSummary: text(4000).optional(),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('webhook.invoke'), integrationId: incidentIdSchema })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('incident.declare'),
      title: text(200),
      severity: incidentSeveritySchema,
    })
    .strict(),
]);
export const automationRuleSchema = z
  .object({
    name: text(200),
    description: z.string().trim().max(2000).default(''),
    enabled: z.boolean().default(false),
    triggerType: automationTriggerSchema,
    triggerVersion: z.literal(1),
    inboundIntegrationId: incidentIdSchema.optional(),
    conditions: automationConditionSchema,
    actions: z.array(automationActionSchema).min(1).max(automationLimits.actions),
  })
  .strict()
  .refine(
    (r) => new Set(r.actions.map((a) => a.id)).size === r.actions.length,
    'Action IDs must be unique',
  );
export type AutomationRuleInput = z.infer<typeof automationRuleSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationPayloadSchema = z
  .object({
    actorId: incidentIdSchema,
    incidentId: incidentIdSchema.optional(),
    taskId: incidentIdSchema.optional(),
    projectId: incidentIdSchema.optional(),
    projectIds: z.array(incidentIdSchema).max(100).optional(),
    integrationId: incidentIdSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    incidentStatus: incidentStatusSchema.optional(),
    commanderId: incidentIdSchema.nullable().optional(),
    responderIds: z.array(incidentIdSchema).max(100).optional(),
    taskStatus: z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']).optional(),
    assigneeId: incidentIdSchema.nullable().optional(),
    declaredAt: z.string().datetime().optional(),
  })
  .strict();
export type AutomationPayload = z.infer<typeof automationPayloadSchema>;
export const automationRunStatusSchema = z.enum([
  'queued',
  'running',
  'skipped',
  'succeeded',
  'partiallyFailed',
  'failed',
  'cancelled',
]);
export const automationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    ruleId: incidentIdSchema.optional(),
    status: automationRunStatusSchema.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    archived: z.enum(['true', 'false']).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'Invalid date range');
export const integrationInputSchema = z
  .object({
    name: text(200),
    type: z.literal('genericWebhook'),
    status: z.enum(['active', 'disabled']),
    endpoint: z.string().url().max(2048).optional(),
    inboundEvents: z.array(z.literal('alert.received')).max(1),
    outboundEvents: z.array(automationTriggerSchema).max(12),
  })
  .strict();
export type IntegrationInput = z.infer<typeof integrationInputSchema>;
export const inboundAlertSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventType: z.literal('alert.received'),
    incidentId: incidentIdSchema.optional(),
    severity: incidentSeveritySchema,
    status: incidentStatusSchema.optional(),
  })
  .strict();
export type AutomationRule = AutomationRuleInput & {
  id: string;
  version: number;
  archivedAt: string | null;
  createdBy: string;
  updatedBy: string;
  health?: 'healthy' | 'failing' | 'pending' | 'neverRun';
};
export type AutomationRun = {
  id: string;
  ruleId: string;
  ruleVersion: number;
  status: z.infer<typeof automationRunStatusSchema>;
  attemptCount: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  triggerSnapshot: AutomationPayload;
  actionResults: Array<{
    id: string;
    status: 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';
    error?: string;
    entityId?: string;
  }>;
};
export type Integration = IntegrationInput & {
  id: string;
  archivedAt: string | null;
  keyVersion: string;
  lastDeliveryStatus?: string;
};
