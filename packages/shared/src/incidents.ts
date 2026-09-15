import { z } from 'zod';

export const incidentIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
export const incidentSeveritySchema = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);
export const incidentStatusSchema = z.enum([
  'declared',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export const incidentTransitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  declared: ['investigating'],
  investigating: ['identified'],
  identified: ['monitoring'],
  monitoring: ['resolved'],
  resolved: ['investigating'],
};
export const canTransitionIncident = (from: IncidentStatus, to: IncidentStatus) =>
  incidentTransitions[from].includes(to);
const ids = z
  .array(incidentIdSchema)
  .max(100)
  .refine((items) => new Set(items).size === items.length, 'Duplicate identifiers');
const text = (limit: number) => z.string().trim().max(limit);
export const incidentFieldsSchema = z
  .object({
    title: text(200).min(1),
    summary: text(4000),
    impact: text(4000),
    severity: incidentSeveritySchema,
  })
  .strict();
export const declareIncidentSchema = incidentFieldsSchema
  .extend({
    operationId: z.string().uuid(),
    commanderId: incidentIdSchema.nullable().optional(),
    responderIds: ids.default([]),
    linkedProjectIds: ids.default([]),
    linkedTaskIds: ids.default([]),
    confirmSev1: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.severity !== 'sev1' || input.confirmSev1, 'Confirm sev1 declaration');
export const incidentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), fields: incidentFieldsSchema.partial() }).strict(),
  z.object({ action: z.literal('acknowledge') }).strict(),
  z
    .object({
      action: z.literal('transition'),
      status: incidentStatusSchema,
      resolutionSummary: text(4000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('commander'), userId: incidentIdSchema.nullable() }).strict(),
  z.object({ action: z.literal('responders'), userIds: ids }).strict(),
  z.object({ action: z.literal('links'), projectIds: ids, taskIds: ids }).strict(),
  z
    .object({
      action: z.literal('timeline'),
      message: text(4000).min(1),
      mentionIds: ids.default([]),
    })
    .strict(),
  z.object({ action: z.literal('archive') }).strict(),
  z.object({ action: z.literal('attach-runbook'), runbookId: incidentIdSchema }).strict(),
  z
    .object({
      action: z.literal('step'),
      runbookId: incidentIdSchema,
      stepId: z.string().uuid(),
      completed: z.boolean(),
    })
    .strict(),
]);
export const incidentCommandSchema = z
  .object({ operationId: z.string().uuid(), command: incidentActionSchema })
  .strict();
export type IncidentCommand = z.infer<typeof incidentCommandSchema>;
export const runbookStepSchema = z
  .object({
    id: z.string().uuid(),
    title: text(200).min(1),
    instructions: text(4000),
    position: z.number().int().min(0).max(1000),
  })
  .strict();
export const runbookInputSchema = z
  .object({
    name: text(200).min(1),
    description: text(4000),
    ownerId: incidentIdSchema,
    status: z.enum(['draft', 'active', 'archived']),
    steps: z.array(runbookStepSchema).max(100),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.steps.map((step) => step.id)).size === input.steps.length &&
      new Set(input.steps.map((step) => step.position)).size === input.steps.length,
    'Steps need unique IDs and positions',
  );
export const incidentQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    commanderId: incidentIdSchema.optional(),
    responderId: incidentIdSchema.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    archived: z.enum(['true', 'false']).default('false'),
    q: text(100).optional(),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, 'Invalid date range');
export type RunbookInput = z.infer<typeof runbookInputSchema>;
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;
export type IncidentRunbook = {
  runbookId: string;
  name: string;
  steps: Array<
    z.infer<typeof runbookStepSchema> & { completedAt: string | null; completedBy: string | null }
  >;
};
export type Incident = {
  id: string;
  workspaceId: string;
  incidentNumber: string;
  title: string;
  summary: string;
  impact: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  commanderId: string | null;
  responderIds: string[];
  linkedProjectIds: string[];
  linkedTaskIds: string[];
  declaredBy: string;
  declaredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  archivedAt: string | null;
  runbooks: IncidentRunbook[];
  createdAt: string;
  updatedAt: string;
};
export type IncidentTimelineEvent = {
  id: string;
  incidentId: string;
  actorId: string;
  eventType: string;
  message: string;
  previousValue?: string | null;
  nextValue?: string | null;
  createdAt: string;
};
export type Runbook = RunbookInput & { id: string; workspaceId: string };
export type IncidentMetrics = {
  openBySeverity: Array<{ _id: IncidentSeverity; count: number }>;
  averages: {
    meanAcknowledgeMs: number | null;
    acknowledgedCount: number;
    meanResolveMs: number | null;
    resolvedCount: number;
  };
  createdOverTime: Array<{ _id: string; count: number }>;
  resolvedOverTime: Array<{ _id: string; count: number }>;
};
